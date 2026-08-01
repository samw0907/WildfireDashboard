"""Building-level damage classification - adapted from LAwildfireSAR's
src/pipeline/buildings.py. Core zonal-statistics/classification/LIA-
flagging logic is unchanged (see SAR_METHODOLOGY.md §1.6) - the one real
change is the building footprint source: OpenStreetMap (already cached
per-fire by the main WildfireDashboard backend in `building_cache`, fetched
here via the same public API the frontend uses) instead of Microsoft's
Global ML Building Footprints, which is what the original pipeline's
validated F1 was actually measured against. See SAR_METHODOLOGY.md §6 for
the full reasoning behind that substitution and its honest cost.

`validate.py` has no equivalent here at all - there is no CAL FIRE DINS-
style ground truth available for an arbitrary live fire. See
SAR_METHODOLOGY.md §3/§7.
"""

import logging
import os

import geopandas as gpd
import httpx
import numpy as np
import rasterio
from rasterstats import zonal_stats

from .change import THRESHOLD_COMBINED_DB, THRESHOLD_LOW_RATIO

logger = logging.getLogger(__name__)

# Buildings on terrain facing significantly away from the radar (local
# incidence angle above this) are flagged as unreliable rather than
# classified - never actually exercised against ground truth in the
# original validation (flat terrain in both study fires), but the
# geometric logic is sound. See SAR_METHODOLOGY.md §1.6.
LIA_THRESHOLD_DEG = 60.0


def fetch_osm_buildings(api_base_url: str, fire_id: str, target_crs: int) -> gpd.GeoDataFrame:
    """Fetch this fire's already-cached OSM building footprints from the
    main backend - the same data the dashboard's own exposure feature
    already fetched via Overpass, reused here rather than adopting a
    separate building dataset. See SAR_METHODOLOGY.md §6."""
    with httpx.Client(timeout=30.0) as client:
        response = client.get(f"{api_base_url}/api/fires/{fire_id}")
        response.raise_for_status()
        buildings_geojson = response.json()["buildings"]

    if not buildings_geojson or not buildings_geojson.get("features"):
        raise RuntimeError(
            f"No cached OSM buildings available for fire {fire_id} - the dashboard's own "
            "exposure computation hasn't run for this fire yet, or found none in range"
        )

    gdf = gpd.GeoDataFrame.from_features(buildings_geojson["features"], crs="EPSG:4326")
    return gdf.to_crs(f"EPSG:{target_crs}")


def _zonal_mean_with_fallback(buildings_reproj: gpd.GeoDataFrame, raster_path: str) -> tuple[list[float], list[bool]]:
    """Standard zonal-stats practice for zones much larger than a pixel is
    center-only inclusion (only a pixel whose *center* falls inside the
    zone counts) - conservative, avoids edge-pixel bias. But a rural
    building is often smaller than one Sentinel-1 pixel (~10-15m footprint
    vs. ~20m pixel spacing), so a real, meaningful fraction of buildings
    contain zero pixel centers by pure chance of where they sit on the
    pixel grid - measured on a real fire at 741 of 3244 buildings (23%),
    not a hypothetical. That isn't "more accurate," it's just an absence
    of any answer, for buildings that are otherwise indistinguishable from
    ones that happen to sample fine.

    For zones this small relative to pixel size, standard remote-sensing
    guidance (see SAR_PIPELINE_REDESIGN.md) flips: an all_touched rule
    (any pixel the footprint even brushes counts) becomes preferable to a
    ~20%+ non-response rate, since which buildings get "unlucky" on
    center-alignment has nothing to do with whether they were actually
    damaged - the non-response itself is not a neutral or safe default.

    So: only for a building that got NO pixel under the standard rule, one
    single retry with all_touched=True. A building that already got a
    value is never touched by this - this can only add answers, never
    change one that already existed. Returns (values, used_fallback)."""
    primary = zonal_stats(buildings_reproj, raster_path, stats=["mean"], nodata=np.nan, geojson_out=False)
    values: list[float | None] = [s["mean"] for s in primary]
    missing_idx = [i for i, v in enumerate(values) if v is None]
    used_fallback = [False] * len(values)

    if missing_idx:
        missing_gdf = buildings_reproj.iloc[missing_idx]
        fallback = zonal_stats(missing_gdf, raster_path, stats=["mean"], nodata=np.nan, all_touched=True, geojson_out=False)
        for i, s in zip(missing_idx, fallback):
            values[i] = s["mean"]
            used_fallback[i] = s["mean"] is not None

    return [v if v is not None else np.nan for v in values], used_fallback


def extract_mean_change(buildings_gdf: gpd.GeoDataFrame, change_raster_path: str) -> gpd.GeoDataFrame:
    with rasterio.open(change_raster_path) as src:
        raster_crs = src.crs
    buildings_reproj = buildings_gdf.to_crs(raster_crs)

    values, used_fallback = _zonal_mean_with_fallback(buildings_reproj, change_raster_path)
    buildings_gdf = buildings_gdf.copy()
    buildings_gdf["mean_change_combined"] = values
    buildings_gdf["used_all_touched_fallback"] = used_fallback

    n_fallback = sum(used_fallback)
    if n_fallback:
        logger.info(
            "%d building(s) had no pixel-center overlap under standard sampling (small footprint vs. "
            "~20m resolution) - rescued via a single all_touched retry rather than left no_data",
            n_fallback,
        )
    return buildings_gdf


def _assign_class(val: float, threshold_db: float, threshold_low_ratio: float = THRESHOLD_LOW_RATIO) -> str:
    if val is None or np.isnan(val):
        return "no_data"
    if val >= threshold_db:
        return "destroyed"
    if val >= threshold_db * threshold_low_ratio:
        return "possibly_affected"
    return "no_damage"


def classify_damage(buildings_gdf: gpd.GeoDataFrame, adaptive_threshold_db: float | None) -> gpd.GeoDataFrame:
    """Classifies every building against both thresholds. `damage_class` is
    the *primary*, headline result: this fire's own adaptive (Otsu)
    threshold when one was found, since a fixed value borrowed from two
    specific California fires has no particular reason to transfer to a
    fire with very different vegetation/terrain (confirmed concretely on
    a real run - see SAR_PIPELINE_REDESIGN.md §1.4). `damage_class_fixed`
    is always computed too, as a stable, cross-fire-comparable reference
    value and the fallback primary result for a fire where Otsu can't
    find a clean bimodal split (little real change - nothing to adapt
    to). Neither is presented as "the" answer alone - see
    apply_spatial_corroboration() and compute_confidence() below for how
    the two get reconciled. Pure threshold comparison only at this stage,
    deliberately - no spatial reasoning here yet."""
    buildings_gdf = buildings_gdf.copy()
    buildings_gdf["damage_class_fixed"] = buildings_gdf["mean_change_combined"].apply(
        lambda v: _assign_class(v, THRESHOLD_COMBINED_DB)
    )
    if adaptive_threshold_db is not None:
        buildings_gdf["damage_class"] = buildings_gdf["mean_change_combined"].apply(
            lambda v: _assign_class(v, adaptive_threshold_db)
        )
    else:
        buildings_gdf["damage_class"] = buildings_gdf["damage_class_fixed"]
    return buildings_gdf


def apply_spatial_corroboration(buildings_gdf: gpd.GeoDataFrame, burn_gdf: gpd.GeoDataFrame | None) -> gpd.GeoDataFrame:
    """A building's raw pixel value crossing the fixed threshold isn't
    itself proof of real damage - a single noisy pixel (speckle, not a
    real building-scale destruction signal) can cross it too, and at
    Sentinel-1's ~20m resolution a building is frequently smaller than one
    pixel to begin with (see SAR_PIPELINE_REDESIGN.md §0/§1.2/§1.6).

    change.py's minimum-mapping-unit filter already separates genuinely
    spatially-coherent burn patches from small, likely-speckle fragments -
    but that filter previously only affected the vectorized burn-area
    output, never building classification, leaving an asymmetry between
    the two output paths (this was the exact gap named in
    SAR_METHODOLOGY.md §5 point 4, now closed).

    Any building classified "destroyed" or "possibly_affected" whose
    footprint doesn't actually intersect one of those MMU-surviving
    patches gets downgraded to "unconfirmed" - its pixel read crossed the
    threshold, but there was no spatially-coherent evidence to back that
    read up, which is exactly the profile of a noisy single pixel rather
    than a real finding. Only applied to the *primary* classification
    (`damage_class`) - the fixed reference value (`damage_class_fixed`)
    stays a plain threshold comparison, since its whole purpose is being
    an independent, stable cross-check, not a second full corroboration
    pipeline of its own."""
    buildings_gdf = buildings_gdf.copy()
    positive = buildings_gdf["damage_class"].isin(["destroyed", "possibly_affected"])
    if not positive.any():
        return buildings_gdf

    if burn_gdf is None or len(burn_gdf) == 0:
        # No burn patch survived the noise filter anywhere on this fire -
        # nothing exists to corroborate any positive read against.
        buildings_gdf.loc[positive, "damage_class"] = "unconfirmed"
        n_downgraded = int(positive.sum())
    else:
        burn_reproj = burn_gdf.to_crs(buildings_gdf.crs)
        burn_union = burn_reproj.geometry.union_all()
        corroborated = buildings_gdf.geometry.intersects(burn_union)
        downgrade = positive & ~corroborated
        buildings_gdf.loc[downgrade, "damage_class"] = "unconfirmed"
        n_downgraded = int(downgrade.sum())

    logger.info(
        "Downgraded %d building(s) to 'unconfirmed' - positive threshold read with no "
        "spatially-coherent patch to corroborate it",
        n_downgraded,
    )
    return buildings_gdf


def compute_confidence(buildings_gdf: gpd.GeoDataFrame, adaptive_threshold_db: float | None) -> gpd.GeoDataFrame:
    """Runs *after* spatial corroboration, comparing each building's final
    (possibly-downgraded) primary classification against the fixed
    reference one - "corroborated" where they agree, "uncertain"
    (threshold-sensitive) where they don't. `no_data`/`unconfirmed` aren't
    threshold-agreement questions in the first place (there's nothing to
    compare, or the positive read was already rejected on spatial
    grounds), so neither side being one of those makes the comparison
    itself not applicable rather than a disagreement. When there's no
    adaptive threshold at all, `damage_class` already just equals
    `damage_class_fixed` (classify_damage()'s fallback), so every
    building would trivially "agree" - not a real comparison, so
    everything is "n/a" instead."""
    buildings_gdf = buildings_gdf.copy()
    if adaptive_threshold_db is None:
        buildings_gdf["confidence"] = "n/a"
        return buildings_gdf

    not_comparable = {"no_data", "unconfirmed"}
    both_real = ~buildings_gdf["damage_class"].isin(not_comparable) & ~buildings_gdf["damage_class_fixed"].isin(
        not_comparable
    )
    agree = buildings_gdf["damage_class"] == buildings_gdf["damage_class_fixed"]
    buildings_gdf["confidence"] = np.where(~both_real, "n/a", np.where(agree, "corroborated", "uncertain"))
    return buildings_gdf


def find_lia_file(rtc_dir: str, reference_date: str) -> str | None:
    """LIA is a geometric property of orbit + terrain - all scenes on the
    same track are effectively identical, so one file (from the first
    pre-event date) represents all."""
    date_compact = reference_date.replace("-", "")[:8]
    matches = [f for f in os.listdir(rtc_dir) if date_compact in f and "localIncidenceAngle" in f and f.endswith(".tif")]
    if not matches:
        matches = [f for f in os.listdir(rtc_dir) if "localIncidenceAngle" in f and f.endswith(".tif")]
    return os.path.join(rtc_dir, matches[0]) if matches else None


def flag_geometry_limited(buildings_gdf: gpd.GeoDataFrame, lia_raster_path: str) -> gpd.GeoDataFrame:
    with rasterio.open(lia_raster_path) as src:
        lia_crs = src.crs
    buildings_reproj = buildings_gdf.to_crs(lia_crs)

    # Same centroid-then-all_touched-fallback sampling as the change
    # raster (extract_mean_change) - a building rescued into having a real
    # change value should get its LIA read from a consistent method too,
    # not leave this specific check unable to fire just because the same
    # small-footprint-vs-pixel-size issue hit this raster as well.
    values, _ = _zonal_mean_with_fallback(buildings_reproj, lia_raster_path)
    buildings_gdf = buildings_gdf.copy()
    buildings_gdf["mean_lia"] = values

    limited = buildings_gdf["mean_lia"] > LIA_THRESHOLD_DEG
    # Applied to both classifications, not just the primary one -
    # unreliable terrain geometry is a property of the radar/terrain
    # relationship, independent of which threshold value was used, so
    # both need the same override. Confidence is reset to n/a too -
    # agreement between two thresholds means nothing on data already
    # flagged unreliable.
    buildings_gdf.loc[limited, "damage_class"] = "geometry_limited"
    buildings_gdf.loc[limited, "damage_class_fixed"] = "geometry_limited"
    buildings_gdf.loc[limited, "confidence"] = "n/a"
    n_flagged = int(limited.sum())
    logger.info("Flagged %d buildings as geometry_limited (LIA > %.0f°)", n_flagged, LIA_THRESHOLD_DEG)
    return buildings_gdf


def run_buildings(
    api_base_url: str,
    fire_id: str,
    change_raster_path: str,
    rtc_dir: str,
    reference_date: str,
    target_crs: int,
    output_path: str,
    adaptive_threshold_db: float | None = None,
    burn_gdf: gpd.GeoDataFrame | None = None,
) -> gpd.GeoDataFrame:
    buildings_gdf = fetch_osm_buildings(api_base_url, fire_id, target_crs)
    logger.info("Loaded %d cached OSM buildings for fire %s", len(buildings_gdf), fire_id)

    buildings_gdf = extract_mean_change(buildings_gdf, change_raster_path)
    # Order matters: classify by threshold first, then require spatial
    # corroboration for any positive read (may downgrade damage_class to
    # "unconfirmed"), then compute confidence off the *final* damage_class
    # - so a building downgraded for lack of corroboration is compared
    # against the adaptive threshold as "unconfirmed", not as whatever its
    # original threshold-only read happened to be. geometry_limited runs
    # last, overriding everything - unreliable terrain data trumps both
    # threshold comparisons and spatial corroboration alike.
    buildings_gdf = classify_damage(buildings_gdf, adaptive_threshold_db)
    buildings_gdf = apply_spatial_corroboration(buildings_gdf, burn_gdf)
    buildings_gdf = compute_confidence(buildings_gdf, adaptive_threshold_db)
    buildings_gdf["area_m2"] = buildings_gdf.geometry.area

    lia_path = find_lia_file(rtc_dir, reference_date)
    if lia_path:
        buildings_gdf = flag_geometry_limited(buildings_gdf, lia_path)
    else:
        logger.warning("No localIncidenceAngle raster found - skipping geometry flagging")

    logger.info("Damage classification counts (primary):\n%s", buildings_gdf["damage_class"].value_counts().to_string())
    logger.info("Damage classification counts (fixed reference):\n%s", buildings_gdf["damage_class_fixed"].value_counts().to_string())
    if adaptive_threshold_db is not None:
        logger.info("Confidence counts:\n%s", buildings_gdf["confidence"].value_counts().to_string())

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    # Written in WGS84, not target_crs (the UTM working CRS) - the
    # frontend map is entirely EPSG:4326, and this output is meant to
    # overlay directly on it alongside the fire's existing OSM buildings.
    buildings_gdf.to_crs(epsg=4326).to_file(output_path, driver="GeoJSON")
    return buildings_gdf
