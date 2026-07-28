"""Overpass API client for building footprints.

Deliberately queries a plain bounding box rather than a precise polygon -
query size/complexity then never depends on how complicated a fire's
perimeter is, which protects the shared public Overpass instance from an
oversized query on a large multi-part fire. Precise buffer-band containment
is checked locally in Python (see exposure.py) against the superset this
returns.

Known Phase 1 limitation: only way["building"] footprints are counted,
not multipolygon "relation" buildings (rare, usually large building
complexes) - a real simplification, not silently hidden.
"""

import httpx
from shapely.geometry import Polygon
from shapely.geometry.base import BaseGeometry

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OVERPASS_QUERY_TIMEOUT = 25  # server-side [timeout:N] in the query itself
HTTP_TIMEOUT = 35.0  # must exceed OVERPASS_QUERY_TIMEOUT, or we time out client-side first

# Overpass's public instance rejects requests with no identifying User-Agent
# (fair-use policy) - without this it returns a bare 406 with no explanation.
HEADERS = {"User-Agent": "WildfireDashboard/0.1 (portfolio project; contact: swilliamson_0907@outlook.com)"}


def _build_query(min_lat: float, min_lon: float, max_lat: float, max_lon: float) -> str:
    bbox = f"{min_lat},{min_lon},{max_lat},{max_lon}"
    return f'[out:json][timeout:{OVERPASS_QUERY_TIMEOUT}];way["building"]({bbox});out geom;'


def fetch_buildings_in_bbox(
    min_lat: float, min_lon: float, max_lat: float, max_lon: float, client: httpx.Client | None = None
) -> list[BaseGeometry]:
    """Raises httpx.HTTPError (incl. timeouts) if Overpass is unavailable or
    overloaded - callers should catch this, log, and move on rather than
    retry, since Overpass overload tends to be sustained, not momentary
    (confirmed by hand while building this)."""
    owns_client = client is None
    client = client or httpx.Client(timeout=HTTP_TIMEOUT, headers=HEADERS)

    try:
        response = client.post(OVERPASS_URL, data={"data": _build_query(min_lat, min_lon, max_lat, max_lon)})
        response.raise_for_status()
        elements = response.json().get("elements", [])

        buildings = []
        for element in elements:
            geometry = element.get("geometry")
            if not geometry or len(geometry) < 3:
                continue
            coords = [(point["lon"], point["lat"]) for point in geometry]
            if coords[0] != coords[-1]:
                coords.append(coords[0])
            buildings.append(Polygon(coords))

        return buildings
    finally:
        if owns_client:
            client.close()
