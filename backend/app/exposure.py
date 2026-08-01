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


def _population_within_buffer_areal(
    bg: census.BlockGroup, pop: float, buffer_wgs84
) -> float:
    """Areal-weighted fallback for a single block group: contributes
    population * (fraction of its area inside the buffer). Only used when
    a block group has zero OSM buildings mapped at all (a real data gap -
    dasymetric weighting has nothing to distribute against in that case,
    not a bug in the weighting itself). Computed in Albers, since area in
    raw WGS84 degrees is meaningless."""
    bg_albers = geo.to_albers(bg.geometry)
    bg_area = bg_albers.area
    if bg_area <= 0:
        return 0.0
    intersection_area = bg_albers.intersection(geo.to_albers(buffer_wgs84)).area
    if intersection_area <= 0:
        return 0.0
    return pop * (intersection_area / bg_area)


def _buildings_in_geometry(buildings: list, geometry) -> int:
    return sum(1 for b in buildings if geometry.contains(b.representative_point()))


def _fetch_block_group_building_counts(
    block_groups: list[census.BlockGroup], client: httpx.Client
) -> dict[str, int]:
    """Total OSM building count per block group, needed to convert its
    Census population into a per-building share (dasymetric weighting) -
    a fundamentally different, wider query than the fire's own 2,400m
    buffer fetch, since block groups are sized by *population* (600-3,000
    people) not land area and routinely extend well beyond it in sparse
    terrain.

    Fetched as a single Overpass call covering every overlapping block
    group's combined bounding box, not one call per block group - a large
    fire can span many block groups, and firing off a separate request
    (plus politeness delay) per one would mean real, avoidable extra load
    on the shared public instance. Block groups are a non-overlapping
    partition by construction, so filtering the same candidate set against
    each one's own polygon locally afterward is safe - no double-counting
    risk the way there would be from unioning separately-fetched sets."""
    if not block_groups:
        return {}
    lons = [x for bg in block_groups for x in (bg.geometry.bounds[0], bg.geometry.bounds[2])]
    lats = [y for bg in block_groups for y in (bg.geometry.bounds[1], bg.geometry.bounds[3])]
    candidates = overpass.fetch_buildings_in_bbox(
        min_lat=min(lats), min_lon=min(lons), max_lat=max(lats), max_lon=max(lons), client=client
    )
    return {bg.geoid: _buildings_in_geometry(candidates, bg.geometry) for bg in block_groups}


def _population_within_buffer_dasymetric(
    block_groups: list[census.BlockGroup],
    population_by_geoid: dict[str, float],
    building_counts_by_geoid: dict[str, int],
    fire_buildings: list,
    buffer_wgs84,
) -> float:
    """Building-weighted (dasymetric) estimate: a block group's population
    is first divided evenly across its own real OSM buildings (not its
    raw area), then only the buildings that actually fall inside this
    buffer band count toward its total - fixes the areal-weighted
    method's worst failure mode (a sparse block group's population
    getting spread across empty land the buffer barely clips, producing
    implausible results like 564 people attributed to 3 buildings,
    confirmed live on a real fire). Falls back to areal weighting for any
    block group with zero mapped buildings - a real OSM coverage gap, not
    something dasymetric weighting can work around."""
    total = 0.0
    for bg in block_groups:
        pop = population_by_geoid.get(bg.geoid)
        if pop is None:
            continue
        building_count = building_counts_by_geoid.get(bg.geoid, 0)
        if building_count > 0:
            population_per_building = pop / building_count
            buildings_in_bg_and_buffer = sum(
                1
                for b in fire_buildings
                if bg.geometry.contains(b.representative_point()) and buffer_wgs84.contains(b.representative_point())
            )
            total += population_per_building * buildings_in_bg_and_buffer
        else:
            total += _population_within_buffer_areal(bg, pop, buffer_wgs84)
    return total


def _compute_population_by_band(
    band_buffers: dict[int, object],
    fire_buildings: list,
    min_lat: float,
    min_lon: float,
    max_lat: float,
    max_lon: float,
    client: httpx.Client,
) -> dict[int, float | None]:
    """Best-effort: population is an enhancement over the building counts,
    not something worth losing a fire's whole exposure computation over.
    Returns all-None (not raised) if no API key is configured yet, or if
    any Census/Overpass call in this fails for any reason - logged either
    way. A real per-block-group data gap (zero mapped buildings) is
    handled by the areal-weighted fallback above, not treated as a
    failure of the whole cycle."""
    api_key = get_settings().census_api_key
    if not api_key:
        return {band: None for band in band_buffers}

    try:
        block_groups = census.fetch_block_groups_in_bbox(min_lat=min_lat, min_lon=min_lon, max_lat=max_lat, max_lon=max_lon)
        population_by_geoid = census.fetch_population_by_geoid(block_groups, api_key)
        building_counts_by_geoid = _fetch_block_group_building_counts(block_groups, client)
        return {
            band: _population_within_buffer_dasymetric(
                block_groups, population_by_geoid, building_counts_by_geoid, fire_buildings, buffer
            )
            for band, buffer in band_buffers.items()
        }
    except Exception:
        logger.exception("Census/building population lookup failed - leaving population_est null for this cycle")
        return {band: None for band in band_buffers}


def fires_needing_recompute(session: Session) -> list[Fire]:
    staleness_cutoff = datetime.now(timezone.utc) - timedelta(hours=get_settings().exposure_staleness_hours)

    fires = session.scalars(select(Fire)).all()
    cache_by_fire = {c.fire_id: c for c in session.scalars(select(BuildingCache)).all()}

    bands_by_fire: dict[str, set[int]] = {}
    for fire_id, band in session.execute(select(ExposureStat.fire_id, ExposureStat.buffer_meters).distinct()):
        bands_by_fire.setdefault(fire_id, set()).add(band)
    required_bands = set(BUFFER_BANDS)

    to_recompute = []
    for fire in fires:
        cache = cache_by_fire.get(fire.id)
        if cache is None:
            to_recompute.append(fire)
        elif fire.source_updated > cache.fetched_at:
            to_recompute.append(fire)  # perimeter changed since we last fetched
        elif cache.fetched_at < staleness_cutoff:
            to_recompute.append(fire)
        elif not required_bands.issubset(bands_by_fire.get(fire.id, set())):
            # e.g. a new buffer band (like the 0m "within perimeter" band)
            # was added to BUFFER_BANDS after this fire was last computed -
            # self-healing backfill rather than a one-off migration script.
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
        band_buffers, buildings, min_lat=min_lat, min_lon=min_lon, max_lat=max_lat, max_lon=max_lon, client=client
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
