"""Shared geometry helpers: WGS84 <-> meter-accurate buffering.

Buffering in raw WGS84 degrees would distort distances (a degree of
longitude shrinks toward the poles), so perimeters are reprojected to a
CONUS-scale equal-area CRS before buffering, then back to WGS84 for storage
and querying. EPSG:5070 (NAD83 / Conus Albers) is standard for US-wide work
and is accurate enough for these buffer bands - they're literature-grounded
approximations already, not survey-precision figures.
"""

from shapely.geometry import shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import transform
from pyproj import Transformer

_WGS84 = "EPSG:4326"
_CONUS_ALBERS = "EPSG:5070"

_to_albers = Transformer.from_crs(_WGS84, _CONUS_ALBERS, always_xy=True).transform
_to_wgs84 = Transformer.from_crs(_CONUS_ALBERS, _WGS84, always_xy=True).transform


def buffer_meters(perimeter_geojson: dict, meters: int) -> BaseGeometry:
    """Return a buffered polygon (in WGS84) around a GeoJSON geometry."""
    geom_wgs84 = shape(perimeter_geojson)
    geom_albers = transform(_to_albers, geom_wgs84)
    buffered_albers = geom_albers.buffer(meters)
    return transform(_to_wgs84, buffered_albers)


def to_albers(geometry: BaseGeometry) -> BaseGeometry:
    """Project a WGS84 geometry to CONUS Albers - needed for accurate area
    calculations (e.g. areal-weighted population intersection), since area
    in raw WGS84 degrees is meaningless."""
    return transform(_to_albers, geometry)
