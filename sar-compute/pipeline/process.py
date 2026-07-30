"""RTC (radiometric terrain correction) processing via pyroSAR/SNAP -
unchanged core logic from LAwildfireSAR's src/pipeline/process.py, just
parameterized directly instead of reading a config.yaml file. See
SAR_METHODOLOGY.md §1.2 for why every one of these geocode() options
matters (gamma0 terrain flattening specifically, not just geometric
correction).
"""

import logging
import os

from pyroSAR.snap import geocode

logger = logging.getLogger(__name__)

# 20m output pixel spacing, UTM CRS chosen per-fire (see entrypoint.py),
# SRTM 1-arcsec DEM auto-downloaded by SNAP - all unchanged from the
# validated original pipeline.
SPACING_METERS = 20
DEM_NAME = "SRTM 1Sec HGT"
POLARIZATIONS = ["VV", "VH"]


def process_scene(scene_zip_path: str, output_dir: str, target_crs: int, snap_aux_path: str) -> str:
    """Process a single Sentinel-1 GRD scene to RTC gamma0 backscatter.
    Returns the output directory (pyroSAR writes per-polarization GeoTIFFs
    there, named by its own convention - see composite.py's find_rtc_file
    for how those get located again downstream)."""
    os.makedirs(output_dir, exist_ok=True)
    os.environ["SNAP_AUX_PATH"] = snap_aux_path

    logger.info("RTC processing: %s", os.path.basename(scene_zip_path))

    geocode(
        infile=scene_zip_path,
        outdir=output_dir,
        shapefile=None,  # no AOI clip at this stage - matches the original's
        # "clip in analysis" approach; RTC-processes the whole scene
        t_srs=target_crs,
        spacing=SPACING_METERS,
        polarizations=POLARIZATIONS,
        scaling="dB",
        removeS1BorderNoise=True,
        removeS1BorderNoiseMethod="pyroSAR",
        removeS1ThermalNoise=True,
        geocoding_type="Range-Doppler",
        terrainFlattening=True,  # radiometric terrain correction - the
        # whole reason this pipeline uses pyroSAR/SNAP instead of a
        # simpler geometric-only source, see SAR_METHODOLOGY.md §1.2
        demName=DEM_NAME,
        speckleFilter=False,  # median compositing across dates provides
        # the despeckling benefit instead, see SAR_METHODOLOGY.md §1.3
        refarea="gamma0",
        export_extra=["localIncidenceAngle"],
        cleanup=True,
    )

    logger.info("RTC processing complete: %s", os.path.basename(scene_zip_path))
    return output_dir
