"""Multi-temporal median compositing - adapted from LAwildfireSAR's
src/pipeline/composite.py. Core logic (median, not mean, for outlier
robustness; single master reference grid so all composites are pixel-
aligned) is unchanged - see SAR_METHODOLOGY.md §1.3 for why. Parameterized
to take an explicit list of dates (from the scenes a human picked via the
acquisition UI) instead of reading a config.yaml date list.

Only used in Composite mode (3+3) - Single-pair mode (1+1) skips this
entirely and feeds the lone RTC output straight to change.py.
"""

import logging
import os

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.vrt import WarpedVRT

logger = logging.getLogger(__name__)


def find_rtc_file(rtc_dir: str, date_str: str, polarisation: str) -> str:
    """Find the RTC GeoTIFF for a given date and polarisation.
    pyroSAR naming convention: S1*_IW__?_{timestamp}_{polarisation}_gamma0-rtc_db.tif"""
    date_compact = date_str.replace("-", "")[:8]
    matches = [
        f
        for f in os.listdir(rtc_dir)
        if date_compact in f and polarisation in f and f.endswith(".tif") and "gamma0-rtc" in f
    ]
    if not matches:
        raise FileNotFoundError(f"No RTC file found for {date_str} {polarisation} in {rtc_dir}")
    if len(matches) > 1:
        logger.warning("Multiple RTC matches for %s %s, using first: %s", date_str, polarisation, matches[0])
    return os.path.join(rtc_dir, matches[0])


def align_to_reference(src_path: str, ref_profile: dict) -> np.ndarray:
    with rasterio.open(src_path) as src:
        with WarpedVRT(
            src,
            crs=ref_profile["crs"],
            transform=ref_profile["transform"],
            width=ref_profile["width"],
            height=ref_profile["height"],
            resampling=Resampling.bilinear,
        ) as vrt:
            return vrt.read(1)


def build_composite(rtc_dir: str, dates: list[str], polarisation: str, output_path: str, ref_profile: dict) -> str:
    """Pixel-wise median composite across the given dates. Median, not
    mean, for robustness against a single anomalous scene (e.g. a rain
    event) - see SAR_METHODOLOGY.md §1.3. Requires >=3 dates for that
    property to mean anything; the caller (entrypoint.py) only calls this
    in Composite mode, which always has exactly 3."""
    if os.path.exists(output_path):
        logger.info("Composite already exists, skipping: %s", os.path.basename(output_path))
        return output_path

    logger.info("Building %s composite from %d scenes...", polarisation, len(dates))

    stack = [align_to_reference(find_rtc_file(rtc_dir, d, polarisation), ref_profile) for d in dates]
    stack_array = np.array(stack, dtype=np.float32)
    nodata = ref_profile.get("nodata")
    if nodata is not None:
        stack_array[stack_array == nodata] = np.nan
    composite = np.nanmedian(stack_array, axis=0)

    out_profile = ref_profile.copy()
    out_profile.update(dtype=rasterio.float32, count=1, nodata=np.nan)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with rasterio.open(output_path, "w", **out_profile) as dst:
        dst.write(composite.astype(np.float32), 1)

    logger.info("Written: %s", os.path.basename(output_path))
    return output_path


def run_composites(rtc_dir: str, pre_dates: list[str], post_dates: list[str], output_dir: str) -> dict[str, str]:
    """Build pre/post composites for VV and VH. All four are aligned to
    one master reference grid (first pre-event VV scene) so change.py can
    do pixel-wise subtraction on spatially registered arrays - a real
    ~136m misregistration bug in the original pipeline was fixed by
    exactly this, see SAR_METHODOLOGY.md §1.3."""
    polarisations = ["VV", "VH"]

    first_pre_path = find_rtc_file(rtc_dir, pre_dates[0], polarisations[0])
    with rasterio.open(first_pre_path) as ref:
        master_ref_profile = ref.profile.copy()
    logger.info("Master reference grid: %s", os.path.basename(first_pre_path))

    composites = {}
    for pol in polarisations:
        pre_path = os.path.join(output_dir, f"pre_composite_{pol}.tif")
        post_path = os.path.join(output_dir, f"post_composite_{pol}.tif")
        composites[f"pre_{pol}"] = build_composite(rtc_dir, pre_dates, pol, pre_path, master_ref_profile)
        composites[f"post_{pol}"] = build_composite(rtc_dir, post_dates, pol, post_path, master_ref_profile)

    return composites
