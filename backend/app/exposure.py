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

from . import geo, overpass
from .config import get_settings
from .db import SessionLocal
from .models import BuildingCache, ExposureStat, Fire

logger = logging.getLogger(__name__)

BUFFER_BANDS = (500, 1000, 2400)
MAX_BAND = max(BUFFER_BANDS)

# Politeness delay between Overpass requests - fair-use courtesy to the free
# public instance, independent of our no-retry-on-failure policy. Matters
# most on the very first backfill cycle, where every fire needs a fetch.
REQUEST_DELAY_SECONDS = 2


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

    for band in BUFFER_BANDS:
        session.add(
            ExposureStat(
                fire_id=fire.id,
                buffer_meters=band,
                building_count=counts[band],
                population_est=None,  # TODO: wire in WorldPop hosted stats API once a key is registered
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
