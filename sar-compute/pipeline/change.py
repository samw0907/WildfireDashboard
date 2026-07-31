"""Change detection - adapted from LAwildfireSAR's src/pipeline/change.py.
Core math is completely unchanged (log-ratio in dB space, VV+VH combined
magnitude, threshold, minimum-mapping-unit patch filter) - see
SAR_METHODOLOGY.md §1.4/§1.5 for why. Two real changes from the original:

1. Takes explicit raster paths for pre/post VV/VH instead of always
   reading from a fixed data/analysis/ composite path - works identically
   whether those paths are Composite mode's median composites or
   Single-pair mode's lone RTC-processed scene, so this module doesn't
   need to know which mode produced its inputs.
2. Clips to the fire's own perimeter polygon (a real shape from NIFC data)
   instead of a rectangular bounding box - a bbox would count area outside
   the actual fire as part of the analysis extent, which the original
   pipeline's own two-fire combined_bbox never had to worry about, but a
   single arbitrary fire's true footprint matters here.
"""

import logging
import os

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.mask import mask as rasterio_mask
from rasterio.warp import transform_geom
from rasterio.features import shapes
from scipy import ndimage
import geopandas as gpd
from shapely.geometry import shape

logger = logging.getLogger(__name__)

# Inherited from the original pipeline, calibrated against CAL FIRE DINS
# ground truth for two specific Southern California WUI fires - NOT
# independently validated for an arbitrary new fire. See
# SAR_METHODOLOGY.md §1.5/§3 for the full reasoning. Do not treat these as
# a universal physical constant.
THRESHOLD_COMBINED_DB = 2.9
THRESHOLD_LOW_RATIO = 0.6  # possibly_affected boundary = THRESHOLD_COMBINED_DB * this
MIN_PATCH_HECTARES = 0.1
PIXEL_SPACING_METERS = 20


def load_raster(path: str) -> tuple[np.ndarray, dict]:
    with rasterio.open(path) as src:
        data = src.read(1).astype(np.float32)
        profile = src.profile.copy()
    return data, profile


def compute_log_ratio(pre: np.ndarray, post: np.ndarray) -> np.ndarray:
    """Subtraction in dB space = log-ratio in linear space. Negative
    values indicate backscatter decrease (damage signal)."""
    return post - pre


def compute_combined_magnitude(change_vv: np.ndarray, change_vh: np.ndarray) -> np.ndarray:
    """VH sensitive to vegetation/volume scattering loss, VV to surface
    roughness/structural change - combining both improves separability."""
    return np.sqrt(change_vv**2 + change_vh**2)


def clip_to_perimeter(array: np.ndarray, profile: dict, perimeter_geojson: dict) -> tuple[np.ndarray, dict]:
    """Clip to the fire's actual perimeter polygon (reprojected into the
    raster's CRS), not just its bounding box."""
    perimeter_in_raster_crs = transform_geom("EPSG:4326", profile["crs"], perimeter_geojson)

    # rasterio_mask needs an in-memory dataset - write the array to a
    # temporary MemoryFile rather than round-tripping through disk.
    with rasterio.io.MemoryFile() as memfile:
        with memfile.open(**profile) as dataset:
            dataset.write(array, 1)
        with memfile.open() as dataset:
            clipped, clipped_transform = rasterio_mask(dataset, [perimeter_in_raster_crs], crop=True)

    clipped_profile = profile.copy()
    clipped_profile.update(
        height=clipped.shape[1],
        width=clipped.shape[2],
        transform=clipped_transform,
    )
    return clipped[0], clipped_profile


def apply_burn_mask(combined: np.ndarray, threshold: float) -> np.ndarray:
    mask = np.zeros_like(combined, dtype=np.uint8)
    mask[combined >= threshold] = 1
    return mask


def remove_small_patches(mask: np.ndarray, min_pixels: int) -> np.ndarray:
    labeled, num_features = ndimage.label(mask)
    if num_features == 0:
        return mask
    sizes = ndimage.sum(mask, labeled, range(1, num_features + 1))
    remove_labels = [i + 1 for i, size in enumerate(sizes) if size < min_pixels]
    for label in remove_labels:
        mask[labeled == label] = 0
    return mask


def vectorise_mask(mask: np.ndarray, profile: dict) -> gpd.GeoDataFrame:
    transform = profile["transform"]
    crs = profile["crs"]
    polygons = [shape(geom) for geom, val in shapes(mask, transform=transform) if val == 1]
    if not polygons:
        return gpd.GeoDataFrame(columns=["geometry", "area_ha"], crs=crs)
    gdf = gpd.GeoDataFrame(geometry=polygons, crs=crs)
    # area_ha must be computed in the projected (metric) CRS, before the
    # to_crs(4326) reprojection callers apply for output - degrees aren't
    # an area unit.
    gdf["area_ha"] = gdf.geometry.area / 10000
    return gdf


def write_raster(array: np.ndarray, profile: dict, output_path: str) -> None:
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    out_profile = profile.copy()
    out_profile.update(dtype=rasterio.float32, count=1, nodata=np.nan)
    with rasterio.open(output_path, "w", **out_profile) as dst:
        dst.write(array.astype(np.float32), 1)


def write_mask(array: np.ndarray, profile: dict, output_path: str) -> None:
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    out_profile = profile.copy()
    out_profile.update(dtype=rasterio.uint8, count=1, nodata=0)
    with rasterio.open(output_path, "w", **out_profile) as dst:
        dst.write(array.astype(np.uint8), 1)


def run_change_detection(
    pre_vv_path: str,
    post_vv_path: str,
    pre_vh_path: str,
    post_vh_path: str,
    perimeter_geojson: dict,
    output_dir: str,
) -> dict:
    """Main change detection entrypoint. Works identically for Composite
    mode (paths point at median composites) or Single-pair mode (paths
    point at the single RTC-processed scene per side)."""
    pre_vv, profile = load_raster(pre_vv_path)
    post_vv, _ = load_raster(post_vv_path)
    pre_vh, _ = load_raster(pre_vh_path)
    post_vh, _ = load_raster(post_vh_path)

    # Crop all arrays to minimum common shape - handles sub-pixel
    # alignment differences between scenes/composites.
    min_rows = min(pre_vv.shape[0], post_vv.shape[0], pre_vh.shape[0], post_vh.shape[0])
    min_cols = min(pre_vv.shape[1], post_vv.shape[1], pre_vh.shape[1], post_vh.shape[1])
    pre_vv, post_vv = pre_vv[:min_rows, :min_cols], post_vv[:min_rows, :min_cols]
    pre_vh, post_vh = pre_vh[:min_rows, :min_cols], post_vh[:min_rows, :min_cols]
    profile.update(width=min_cols, height=min_rows)

    logger.info("Computing change detection...")
    change_vv = compute_log_ratio(pre_vv, post_vv)
    change_vh = compute_log_ratio(pre_vh, post_vh)
    combined = compute_combined_magnitude(change_vv, change_vh)

    write_raster(change_vv, profile, os.path.join(output_dir, "change_vv.tif"))
    write_raster(change_vh, profile, os.path.join(output_dir, "change_vh.tif"))
    write_raster(combined, profile, os.path.join(output_dir, "change_combined.tif"))

    logger.info("Clipping to fire perimeter...")
    combined_clipped, clipped_profile = clip_to_perimeter(combined, profile, perimeter_geojson)
    # Written separately from the unclipped change_combined.tif above -
    # this clipped version is what building damage classification samples
    # (see buildings.py/entrypoint.py), not the whole-scene raster. A
    # building outside the fire's own perimeter has no methodological
    # basis for a "this fire damaged it" classification even if the
    # underlying pixels show real change - a month-apart before/after
    # pair can pick up genuine non-fire signal (snowmelt, soil moisture,
    # agriculture, even an unrelated fire elsewhere in the same ~250km
    # scene) anywhere outside the area the fire actually touched. Confirmed
    # live this was happening: a real Aspen Acres run classified buildings
    # 2km+ outside the perimeter as "destroyed" from real but unrelated
    # backscatter change.
    write_raster(combined_clipped, clipped_profile, os.path.join(output_dir, "change_combined_clipped.tif"))

    pixel_area_ha = (PIXEL_SPACING_METERS**2) / 10000
    min_pixels = int(MIN_PATCH_HECTARES / pixel_area_ha)

    logger.info("Applying burn mask threshold: %.2f dB combined magnitude...", THRESHOLD_COMBINED_DB)
    burn_mask = apply_burn_mask(combined_clipped, THRESHOLD_COMBINED_DB)
    burn_mask = remove_small_patches(burn_mask, min_pixels)
    write_mask(burn_mask, clipped_profile, os.path.join(output_dir, "burn_mask.tif"))

    burn_gdf = vectorise_mask(burn_mask, clipped_profile)
    total_area_ha = burn_gdf["area_ha"].sum() if len(burn_gdf) else 0.0
    logger.info("Detected burn area: %.1f ha across %d patches", total_area_ha, len(burn_gdf))

    burn_path = os.path.join(output_dir, "burn_perimeter.geojson")
    if len(burn_gdf):
        # Written in WGS84, not the UTM working CRS - the frontend map
        # (fire perimeters, OSM buildings) is entirely EPSG:4326, and this
        # output is meant to overlay directly on it.
        burn_gdf.to_crs(epsg=4326).to_file(burn_path, driver="GeoJSON")

    return {
        "change_combined_path": os.path.join(output_dir, "change_combined.tif"),
        "change_combined_clipped_path": os.path.join(output_dir, "change_combined_clipped.tif"),
        "burn_mask_path": os.path.join(output_dir, "burn_mask.tif"),
        "burn_perimeter_path": burn_path if len(burn_gdf) else None,
        "total_area_ha": float(total_area_ha),
        "patch_count": len(burn_gdf),
    }
