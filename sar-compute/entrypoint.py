"""SAR compute job entrypoint - runs once per confirmed fire as an AWS
Batch (Fargate) job. See DECISIONS.md "SAR compute dispatch" and
SAR_METHODOLOGY.md for the full design reasoning behind every choice here.

Deliberately takes almost nothing as input except FIRE_ID - everything
else (perimeter, selected scenes, Composite vs Single-pair mode) is
fetched live from the main WildfireDashboard backend's own public API,
the same one the frontend uses. No CDSE track search happens here; a
human already picked exact scenes via the mark-for-acquisition picker.

Required environment variables:
  FIRE_ID               - the fire this job processes
  ACQUISITION_SEQUENCE  - which of this fire's acquisitions to process (a
                          fire can be acquired more than once over its
                          lifetime) - also what keeps this run's S3
                          outputs from colliding with any other
                          acquisition on the same fire.
  WILDFIRE_API_BASE_URL - e.g. https://wildfiredashboard-production.up.railway.app
  CDSE_USER / CDSE_PASSWORD
  S3_BUCKET             - results destination (AWS region/credentials
                          come from the Fargate task's IAM role, not env vars)
  AWS_DEFAULT_REGION
"""

import json
import logging
import math
import os
import sys

import httpx

from pipeline import buildings, change, composite, download, figures, s3_sync, process

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("sar-compute")

DATA_DIR = "/data"
RAW_DIR = os.path.join(DATA_DIR, "raw")
RTC_DIR = os.path.join(DATA_DIR, "rtc")
ANALYSIS_DIR = os.path.join(DATA_DIR, "analysis")
SNAP_AUX_PATH = os.path.join(DATA_DIR, "snap_aux")


def utm_epsg_for_lonlat(lon: float, lat: float) -> int:
    """CONUS/US wildfires are all northern hemisphere - EPSG 326xx."""
    zone = int((lon + 180) / 6) + 1
    return 32600 + zone


def fire_centroid_lonlat(perimeter_geojson: dict) -> tuple[float, float]:
    from shapely.geometry import shape

    centroid = shape(perimeter_geojson).centroid
    return centroid.x, centroid.y


def fetch_fire_and_acquisition(api_base_url: str, fire_id: str, sequence: int) -> tuple[dict, dict]:
    with httpx.Client(timeout=30.0) as client:
        fire_response = client.get(f"{api_base_url}/api/fires/{fire_id}")
        fire_response.raise_for_status()
        acquisition_response = client.get(f"{api_base_url}/api/fires/{fire_id}/acquisitions/{sequence}")
        acquisition_response.raise_for_status()
    return fire_response.json(), acquisition_response.json()


def main() -> None:
    fire_id = os.environ["FIRE_ID"]
    sequence = int(os.environ["ACQUISITION_SEQUENCE"])
    api_base_url = os.environ["WILDFIRE_API_BASE_URL"]
    s3_bucket = os.environ["S3_BUCKET"]
    aws_region = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")

    logger.info("Starting SAR compute job for fire %s, acquisition #%d", fire_id, sequence)
    fire, acquisition = fetch_fire_and_acquisition(api_base_url, fire_id, sequence)

    mode = acquisition["mode"]
    if mode not in ("composite", "single_pair"):
        logger.error("Fire %s has no valid acquisition selection (mode=%s) - nothing to process", fire_id, mode)
        sys.exit(1)

    before_scenes = acquisition["before_scenes"]
    after_scenes = acquisition["after_scenes"]
    logger.info(
        "Fire %s: mode=%s, %d before scene(s), %d after scene(s)",
        fire_id,
        mode,
        len(before_scenes),
        len(after_scenes),
    )

    lon, lat = fire_centroid_lonlat(fire["perimeter"])
    target_crs = utm_epsg_for_lonlat(lon, lat)
    logger.info("Fire centroid (%.4f, %.4f) -> EPSG:%d", lon, lat, target_crs)

    os.makedirs(RAW_DIR, exist_ok=True)
    os.makedirs(RTC_DIR, exist_ok=True)
    os.makedirs(ANALYSIS_DIR, exist_ok=True)
    os.makedirs(SNAP_AUX_PATH, exist_ok=True)

    cdse_user, cdse_password = download.get_cdse_credentials()

    # --- Download + RTC process every selected scene ---
    all_scenes = [(s, "before") for s in before_scenes] + [(s, "after") for s in after_scenes]
    scene_dates: dict[str, list[str]] = {"before": [], "after": []}

    for scene, side in all_scenes:
        # A fresh token per scene, not one fetched upfront for the whole
        # loop - CDSE's access tokens are short-lived, and RTC processing
        # (the Terrain-Correction step alone) can take ~30 minutes per
        # scene, so a token that was valid at job start is long expired by
        # the time a later scene's download is attempted. Confirmed live:
        # the original single-upfront-token design 401'd on exactly this.
        token = download.get_access_token(cdse_user, cdse_password)
        local_path = download.download_scene(scene["id"], scene["name"], token, RAW_DIR)
        process.process_scene(local_path, RTC_DIR, target_crs, SNAP_AUX_PATH)
        scene_dates[side].append(scene["date"][:10])  # YYYY-MM-DD

    # --- Composite (Composite mode only) or use the lone RTC scene directly (Single-pair) ---
    if mode == "composite":
        logger.info("Composite mode: building median composites")
        composites = composite.run_composites(RTC_DIR, scene_dates["before"], scene_dates["after"], ANALYSIS_DIR)
        pre_vv_path, post_vv_path = composites["pre_VV"], composites["post_VV"]
        pre_vh_path, post_vh_path = composites["pre_VH"], composites["post_VH"]
    else:
        logger.info("Single-pair mode: skipping compositing, using the single scene per side directly")
        pre_vv_path = composite.find_rtc_file(RTC_DIR, scene_dates["before"][0], "VV")
        post_vv_path = composite.find_rtc_file(RTC_DIR, scene_dates["after"][0], "VV")
        pre_vh_path = composite.find_rtc_file(RTC_DIR, scene_dates["before"][0], "VH")
        post_vh_path = composite.find_rtc_file(RTC_DIR, scene_dates["after"][0], "VH")

    # --- Change detection ---
    change_result = change.run_change_detection(
        pre_vv_path, post_vv_path, pre_vh_path, post_vh_path, fire["perimeter"], ANALYSIS_DIR
    )

    # --- Building damage classification (OSM, not Microsoft - see SAR_METHODOLOGY.md §6) ---
    buildings_output_path = os.path.join(ANALYSIS_DIR, "building_damage.geojson")
    buildings_gdf = buildings.run_buildings(
        api_base_url=api_base_url,
        fire_id=fire_id,
        # Clipped to the fire's own perimeter, not the whole-scene raster -
        # a building outside the perimeter has no methodological basis for
        # a fire-caused damage classification even when the underlying
        # pixels show real change (see change.py's run_change_detection).
        change_raster_path=change_result["change_combined_clipped_path"],
        rtc_dir=RTC_DIR,
        reference_date=scene_dates["before"][0],
        target_crs=target_crs,
        output_path=buildings_output_path,
    )

    damage_counts = buildings_gdf["damage_class"].value_counts().to_dict()

    # --- Static figures (matplotlib/contextily) - see pipeline/figures.py
    # for why these came back after being dropped earlier in the build ---
    figure_paths = figures.run_figures(
        perimeter_geojson=fire["perimeter"],
        target_crs=target_crs,
        buildings_gdf=buildings_gdf,
        burn_perimeter_path=change_result["burn_perimeter_path"],
        pre_vv_path=pre_vv_path,
        post_vv_path=post_vv_path,
        change_combined_clipped_path=change_result["change_combined_clipped_path"],
        threshold_db=change.THRESHOLD_COMBINED_DB,
        output_dir=ANALYSIS_DIR,
    )

    # --- Files to sync to S3 - built once, reused for both the summary's
    # own file manifest (below) and the actual upload, so the two can
    # never drift out of sync with each other. Raw per-scene RTC rasters
    # (previously discarded once change-detection consumed them) are
    # included now so the before/after backscatter is independently
    # downloadable, not just visible inside the backscatter_panel figure.
    sync_files = {
        "burn_perimeter": change_result["burn_perimeter_path"],
        "building_damage": buildings_output_path,
        "change_combined": change_result["change_combined_path"],
        "rtc_pre_vv": pre_vv_path,
        "rtc_post_vv": post_vv_path,
        "rtc_pre_vh": pre_vh_path,
        "rtc_post_vh": post_vh_path,
        **figure_paths,
    }

    # --- Result summary - the compact JSON Phase E's Fire Detail UI reads,
    # rather than parsing the full GeoJSON/rasters directly ---
    summary = {
        "fire_id": fire_id,
        "mode": mode,
        "before_scenes": [s["id"] for s in before_scenes],
        "after_scenes": [s["id"] for s in after_scenes],
        "target_crs": target_crs,
        "total_burn_area_ha": change_result["total_area_ha"],
        "burn_patch_count": change_result["patch_count"],
        "building_damage_counts": damage_counts,
        "total_buildings_classified": int(len(buildings_gdf)),
        # Threshold and building-dataset honesty framing, carried into the
        # output itself, not just docs - see SAR_METHODOLOGY.md §6/§7.
        "threshold_db": change.THRESHOLD_COMBINED_DB,
        "threshold_validated": False,
        "threshold_note": (
            "Inherited from LAwildfireSAR, calibrated against CAL FIRE DINS ground truth for two "
            "Southern California WUI fires - not independently validated for this fire."
        ),
        "building_dataset": "OpenStreetMap",
        "building_dataset_note": (
            "The original pipeline's F1~0.80 was validated against Microsoft's building footprints, "
            "not OSM - that figure does not transfer to this dataset."
        ),
        # {label: filename} for every file actually produced (a missing
        # path, e.g. no burn detected at all, is just omitted rather than
        # included as null) - matches s3_sync's own deterministic
        # acquisitions/{fire_id}/{sequence}/{filename} key convention
        # exactly, so the backend/frontend can construct download URLs
        # without needing a separate manifest fetch.
        "files": {label: os.path.basename(path) for label, path in sync_files.items() if path},
    }
    summary_path = os.path.join(ANALYSIS_DIR, "result_summary.json")
    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2)
    logger.info("Result summary: %s", json.dumps(summary, indent=2))

    # --- Sync results to S3 (summary included last so its own "files" key
    # already reflects everything else being uploaded alongside it) ---
    sync_files["summary"] = summary_path
    s3_sync.run_sync(fire_id=fire_id, sequence=sequence, bucket=s3_bucket, region=aws_region, files=sync_files)

    logger.info("SAR compute job complete for fire %s, acquisition #%d", fire_id, sequence)


if __name__ == "__main__":
    main()
