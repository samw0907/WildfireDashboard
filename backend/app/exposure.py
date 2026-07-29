"""Exposure computation: one Overpass fetch per fire at the largest buffer
band (2400m), with building counts at all three bands derived locally from
that single fetch - no repeat external calls per band.

Recompute is decoupled from the 15-min NIFC ingestion cadence (see
fires_needing_recompute): it only runs for a new fire, a fire whose
perimeter has changed since last computed, or one past the staleness
fallback window.
"""

import logging
import time
from datetime import datetime, timedelta, timezone

import httpx
from shapely.geometry import mapping
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from . import census, geo, overpass
from .config import get_settings
from .db import SessionLocal
from .models import BuildingCache, ExposureStat, Fire

logger = logging.getLogger(__name__)

BUFFER_BANDS = (0, 500, 1000, 2400)  # 0 = within the fire perimeter itself
MAX_BAND = max(BUFFER_BANDS)

# Politeness delay between Overpass requests - fair-use courtesy to the free
# public instance, independent of our no-retry-on-failure policy. Matters
# most on the very first backfill cycle, where every fire needs a fetch.
REQUEST_DELAY_SECONDS = 2


def _population_within_buffer(
    block_groups: list[census.BlockGroup], population_by_geoid: dict[str, float], buffer_wgs84
) -> float:
    """Areal-weighted estimate: each block group contributes population *
    (fraction of its area inside the buffer). Computed in Albers, since
    area in raw WGS84 degrees is meaningless."""
    buffer_albers = geo.to_albers(buffer_wgs84)
    total = 0.0
    for bg in block_groups:
        pop = population_by_geoid.get(bg.geoid)
        if pop is None:
            continue
        bg_albers = geo.to_albers(bg.geometry)
        bg_area = bg_albers.area
        if bg_area <= 0:
            continue
        intersection_area = bg_albers.intersection(buffer_albers).area
        if intersection_area <= 0:
            continue
        total += pop * (intersection_area / bg_area)
    return total


def _compute_population_by_band(
    band_buffers: dict[int, object], min_lat: float, min_lon: float, max_lat: float, max_lon: float
) -> dict[int, float | None]:
    """Best-effort: population is an enhancement over the building counts,
    not something worth losing a fire's whole exposure computation over.
    Returns all-None (not raised) if no API key is configured yet, or if
    the Census API call itself fails for any reason - logged either way."""
    api_key = get_settings().census_api_key
    if not api_key:
        return {band: None for band in band_buffers}

    try:
        block_groups = census.fetch_block_groups_in_bbox(min_lat=min_lat, min_lon=min_lon, max_lat=max_lat, max_lon=max_lon)
        population_by_geoid = census.fetch_population_by_geoid(block_groups, api_key)
        return {
            band: _population_within_buffer(block_groups, population_by_geoid, buffer)
            for band, buffer in band_buffers.items()
        }
    except Exception:
        logger.exception("Census population lookup failed - leaving population_est null for this cycle")
        return {band: None for band in band_buffers}


def fires_needing_recompute(session: Session) -> list[Fire]:
    staleness_cutoff = datetime.now(timezone.utc) - timedelta(hours=get_settings().exposure_staleness_hours)

    fires = session.scalars(select(Fire)).all()
    cache_by_fire = {c.fire_id: c for c in session.scalars(select(BuildingCache)).all()}

    to_recompute = []
    for fire in fires:
        cache = cache_by_fire.get(fire.id)
        if cache is None:
            to_recompute.append(fire)
        elif fire.source_updated > cache.fetched_at:
            to_recompute.append(fire)  # perimeter changed since we last fetched
        elif cache.fetched_at < staleness_cutoff:
            to_recompute.append(fire)
    return to_recompute


def compute_exposure_for_fire(session: Session, fire: Fire, client: httpx.Client) -> None:
    """Raises on Overpass failure - caller is expected to catch, log, and
    continue to the next fire rather than retry (see overpass.py)."""
    band_buffers = {band: geo.buffer_meters(fire.perimeter, band) for band in BUFFER_BANDS}
    max_buffer = band_buffers[MAX_BAND]

    min_lon, min_lat, max_lon, max_lat = max_buffer.bounds
    buildings = overpass.fetch_buildings_in_bbox(
        min_lat=min_lat, min_lon=min_lon, max_lat=max_lat, max_lon=max_lon, client=client
    )

    # Exact per-band containment check against the candidate set Overpass
    # returned for the bbox (a superset of what's actually within the buffer).
    representative_points = [b.representative_point() for b in buildings]
    counts = {
        band: sum(1 for point in representative_points if band_buffers[band].contains(point))
        for band in BUFFER_BANDS
    }

    buildings_geojson = {
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "geometry": mapping(b), "properties": {}} for b in buildings],
    }

    cache_stmt = insert(BuildingCache).values(
        fire_id=fire.id, buildings=buildings_geojson, fetched_at=datetime.now(timezone.utc)
    )
    cache_stmt = cache_stmt.on_conflict_do_update(
        index_elements=[BuildingCache.fire_id],
        set_={"buildings": cache_stmt.excluded.buildings, "fetched_at": cache_stmt.excluded.fetched_at},
    )
    session.execute(cache_stmt)

    population_by_band = _compute_population_by_band(
        band_buffers, min_lat=min_lat, min_lon=min_lon, max_lat=max_lat, max_lon=max_lon
    )

    for band in BUFFER_BANDS:
        session.add(
            ExposureStat(
                fire_id=fire.id,
                buffer_meters=band,
                building_count=counts[band],
                population_est=population_by_band[band],
            )
        )

    session.commit()
    logger.info("Exposure computed for %s (%s): %s", fire.id, fire.name, counts)


def run_exposure_cycle() -> None:
    session = SessionLocal()
    try:
        fires = fires_needing_recompute(session)
        if not fires:
            return

        with httpx.Client(timeout=overpass.HTTP_TIMEOUT, headers=overpass.HEADERS) as client:
            for i, fire in enumerate(fires):
                try:
                    compute_exposure_for_fire(session, fire, client)
                except Exception:
                    session.rollback()
                    logger.exception("Exposure computation failed for fire %s - will retry next cycle", fire.id)
                if i < len(fires) - 1:
                    time.sleep(REQUEST_DELAY_SECONDS)
    finally:
        session.close()
