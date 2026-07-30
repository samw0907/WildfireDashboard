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


def extract_mean_change(buildings_gdf: gpd.GeoDataFrame, change_raster_path: str) -> gpd.GeoDataFrame:
    with rasterio.open(change_raster_path) as src:
        raster_crs = src.crs
    buildings_reproj = buildings_gdf.to_crs(raster_crs)

    stats = zonal_stats(buildings_reproj, change_raster_path, stats=["mean"], nodata=np.nan, geojson_out=False)
    buildings_gdf = buildings_gdf.copy()
    buildings_gdf["mean_change_combined"] = [s["mean"] if s["mean"] is not None else np.nan for s in stats]
    return buildings_gdf


def classify_damage(buildings_gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Destroyed / possibly_affected / no_damage / no_data, using the
    fixed thresholds inherited from the original pipeline - NOT
    independently calibrated for this fire. See SAR_METHODOLOGY.md §1.5/§7."""
    threshold_low = THRESHOLD_COMBINED_DB * THRESHOLD_LOW_RATIO

    def assign_class(val):
        if val is None or np.isnan(val):
            return "no_data"
        if val >= THRESHOLD_COMBINED_DB:
            return "destroyed"
        if val >= threshold_low:
            return "possibly_affected"
        return "no_damage"

    buildings_gdf = buildings_gdf.copy()
    buildings_gdf["damage_class"] = buildings_gdf["mean_change_combined"].apply(assign_class)
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

    lia_stats = zonal_stats(buildings_reproj, lia_raster_path, stats=["mean"], nodata=np.nan, geojson_out=False)
    buildings_gdf = buildings_gdf.copy()
    buildings_gdf["mean_lia"] = [s["mean"] if s["mean"] is not None else np.nan for s in lia_stats]

    buildings_gdf.loc[buildings_gdf["mean_lia"] > LIA_THRESHOLD_DEG, "damage_class"] = "geometry_limited"
    n_flagged = int((buildings_gdf["damage_class"] == "geometry_limited").sum())
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
) -> gpd.GeoDataFrame:
    buildings_gdf = fetch_osm_buildings(api_base_url, fire_id, target_crs)
    logger.info("Loaded %d cached OSM buildings for fire %s", len(buildings_gdf), fire_id)

    buildings_gdf = extract_mean_change(buildings_gdf, change_raster_path)
    buildings_gdf = classify_damage(buildings_gdf)
    buildings_gdf["area_m2"] = buildings_gdf.geometry.area

    lia_path = find_lia_file(rtc_dir, reference_date)
    if lia_path:
        buildings_gdf = flag_geometry_limited(buildings_gdf, lia_path)
    else:
        logger.warning("No localIncidenceAngle raster found - skipping geometry flagging")

    logger.info("Damage classification counts:\n%s", buildings_gdf["damage_class"].value_counts().to_string())

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    buildings_gdf.to_file(output_path, driver="GeoJSON")
    return buildings_gdf
