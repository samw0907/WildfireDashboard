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
# Bumped from the inherited 0.1 ha (an order of magnitude finer than
# typical burned-area-mapping practice, which runs ~1-6 ha) - see
# SAR_PIPELINE_REDESIGN.md §1.5. 0.1 ha let far more small, likely-
# speckle patches survive than standard practice would.
MIN_PATCH_HECTARES = 1.0
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
            # nodata=np.nan is required here, explicitly - crop=True only
            # crops to the perimeter polygon's *bounding box*, not a tight
            # polygon crop, so real pixels remain inside the cropped array
            # for the (bbox-but-outside-polygon) gap area on any
            # non-rectangular fire (i.e. every real fire). Without an
            # explicit nodata override, rasterio.mask.mask() falls back to
            # the source dataset's own nodata metadata - which load_raster()
            # never sets - so it defaults to filling that gap with 0.0, a
            # real-looking "zero change" value. Every downstream consumer
            # (write_raster's nodata=np.nan tag, buildings.py's
            # zonal_stats(nodata=np.nan)) assumes NaN, so that gap was
            # silently read as legitimate low-change data instead of being
            # excluded - confirmed live: buildings geometrically outside
            # the fire perimeter but inside its bounding box were getting
            # classified "no_damage" instead of "no_data".
            clipped, clipped_transform = rasterio_mask(
                dataset, [perimeter_in_raster_crs], crop=True, nodata=np.nan
            )

    clipped_profile = profile.copy()
    clipped_profile.update(
        height=clipped.shape[1],
        width=clipped.shape[2],
        transform=clipped_transform,
    )
    return clipped[0], clipped_profile


def compute_otsu_threshold(combined_clipped: np.ndarray, bins: int = 256) -> float | None:
    """Otsu's method - a standard, ground-truth-free way to let *this
    fire's own* change-image statistics set a threshold, rather than
    assuming the fixed THRESHOLD_COMBINED_DB (borrowed from two different
    fires) transfers everywhere. See SAR_PIPELINE_REDESIGN.md §1.4/§0 -
    picks the cutoff that maximizes between-class variance between the
    resulting "changed"/"unchanged" pixel groups. Plain numpy, no new
    dependency - the algorithm itself is a short, well-known histogram
    computation, not something that needs scikit-image just for this.

    Returns None if there's no valid (non-NaN) data to compute a
    threshold from at all - the caller falls back to the fixed threshold
    only in that case, same as any other missing-data situation here."""
    valid = combined_clipped[~np.isnan(combined_clipped)]
    if valid.size == 0:
        return None

    hist, bin_edges = np.histogram(valid, bins=bins)
    bin_centers = (bin_edges[:-1] + bin_edges[1:]) / 2

    weight_below = np.cumsum(hist)
    weight_above = np.cumsum(hist[::-1])[::-1]
    # Only interior bin boundaries are valid split points - both sides
    # must have at least one pixel for a variance comparison to mean
    # anything.
    valid_splits = (weight_below[:-1] > 0) & (weight_above[1:] > 0)
    if not np.any(valid_splits):
        return None

    mean_below = np.cumsum(hist * bin_centers) / np.where(weight_below == 0, 1, weight_below)
    cumsum_above = np.cumsum((hist * bin_centers)[::-1])[::-1]
    mean_above = cumsum_above / np.where(weight_above == 0, 1, weight_above)

    between_class_variance = np.zeros(bins - 1)
    between_class_variance[valid_splits] = (
        weight_below[:-1][valid_splits]
        * weight_above[1:][valid_splits]
        * (mean_below[:-1][valid_splits] - mean_above[1:][valid_splits]) ** 2
    )
    best_idx = int(np.argmax(between_class_variance))
    return float(bin_centers[best_idx])


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


def smooth_for_display(gdf: gpd.GeoDataFrame, pixel_spacing_meters: float) -> gpd.GeoDataFrame:
    """Purely cartographic - vectorise_mask() traces raw pixel boundaries
    with zero generalization, which looks like a stack of little squares
    even for a large, entirely real, spatially-coherent patch. Real
    burned-area products (NIFC's own perimeters, USGS burned-area
    products) are also raster-derived underneath but are always shown
    generalized, not as raw pixel blocks - this is that same standard
    step, nothing more. Tolerance is half a pixel width; buffer-out-then-
    in rounds the stair-stepped corners, simplify() then thins redundant
    vertices along the now-smoother edge.

    Deliberately never used for anything computational - area/patch-count
    stats and apply_spatial_corroboration()'s intersection check in
    buildings.py both use the raw, unsmoothed geometry, so this cosmetic
    step can never silently change a real number or which buildings get
    corroborated."""
    if len(gdf) == 0:
        return gdf
    tolerance = pixel_spacing_meters / 2
    smoothed = gdf.copy()
    smoothed["geometry"] = smoothed.geometry.buffer(tolerance).buffer(-tolerance).simplify(
        tolerance, preserve_topology=True
    )
    return smoothed


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

    # Computed from this fire's own clipped change-image statistics, not
    # borrowed from another fire - see compute_otsu_threshold()'s own
    # docstring and SAR_PIPELINE_REDESIGN.md §1.4. Used downstream as a
    # cross-check against THRESHOLD_COMBINED_DB, not a replacement for it.
    adaptive_threshold_db = compute_otsu_threshold(combined_clipped)
    if adaptive_threshold_db is not None:
        logger.info("Adaptive (Otsu) threshold for this fire: %.2f dB (fixed default: %.2f dB)",
                     adaptive_threshold_db, THRESHOLD_COMBINED_DB)
    else:
        logger.warning("Could not compute an adaptive threshold (no valid clipped data) - fixed threshold only")

    pixel_area_ha = (PIXEL_SPACING_METERS**2) / 10000
    min_pixels = int(MIN_PATCH_HECTARES / pixel_area_ha)

    logger.info("Applying burn mask threshold: %.2f dB combined magnitude...", THRESHOLD_COMBINED_DB)
    burn_mask = apply_burn_mask(combined_clipped, THRESHOLD_COMBINED_DB)
    burn_mask = remove_small_patches(burn_mask, min_pixels)
    write_mask(burn_mask, clipped_profile, os.path.join(output_dir, "burn_mask.tif"))

    # Raw, unsmoothed - this is what area/patch-count stats and
    # buildings.py's spatial-corroboration check both use. Never the
    # display copy below.
    burn_gdf = vectorise_mask(burn_mask, clipped_profile)
    total_area_ha = burn_gdf["area_ha"].sum() if len(burn_gdf) else 0.0
    logger.info("Detected burn area: %.1f ha across %d patches", total_area_ha, len(burn_gdf))

    burn_path = os.path.join(output_dir, "burn_perimeter.geojson")
    if len(burn_gdf):
        # smooth_for_display() only affects what gets written/shown here -
        # a cosmetic generalization of the raw pixel-boundary polygon
        # above, computed fresh from it rather than mutating burn_gdf
        # itself. Written in WGS84, not the UTM working CRS - the frontend
        # map (fire perimeters, OSM buildings) is entirely EPSG:4326, and
        # this output is meant to overlay directly on it.
        burn_gdf_display = smooth_for_display(burn_gdf, PIXEL_SPACING_METERS)
        burn_gdf_display.to_crs(epsg=4326).to_file(burn_path, driver="GeoJSON")

    return {
        "change_combined_path": os.path.join(output_dir, "change_combined.tif"),
        "change_combined_clipped_path": os.path.join(output_dir, "change_combined_clipped.tif"),
        "burn_mask_path": os.path.join(output_dir, "burn_mask.tif"),
        "burn_perimeter_path": burn_path if len(burn_gdf) else None,
        # Raw (unsmoothed) GeoDataFrame, in-memory, for buildings.py's
        # apply_spatial_corroboration() - not the cosmetically-smoothed
        # file written above.
        "burn_gdf": burn_gdf,
        "total_area_ha": float(total_area_ha),
        "patch_count": len(burn_gdf),
        "adaptive_threshold_db": adaptive_threshold_db,
    }
