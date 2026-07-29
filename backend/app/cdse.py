"""CDSE (Copernicus Data Space Ecosystem) Sentinel-1 scene search for the
mark-for-acquisition workflow (see DECISIONS.md). Generalizes the
LAwildfireSAR pipeline's `search_scene()` (single forced date + orbit
direction) into a date-range candidate search across both orbit
directions, so the frontend can present real candidate scenes for a human
to pick from rather than a single pre-decided one. Search itself needs no
auth (verified live) - only actual scene download would need the CDSE
token, which belongs to the future compute-dispatch phase, not this one.
"""

import logging

import httpx

logger = logging.getLogger(__name__)

CATALOGUE_URL = "https://catalogue.dataspace.copernicus.eu/odata/v1/Products"
PRODUCT_TYPE = "IW_GRDH_1S"


def search_scenes(
    bbox: tuple[float, float, float, float],
    date_start: str,
    date_end: str,
    client: httpx.Client | None = None,
) -> list[dict]:
    """Live search for Sentinel-1 IW GRD scenes intersecting bbox within
    [date_start, date_end) (YYYY-MM-DD strings). Returns candidates from
    both orbit directions - the caller does the same-track filtering once
    a human has picked a "before" scene."""
    lon_min, lat_min, lon_max, lat_max = bbox
    filter_str = (
        f"Collection/Name eq 'SENTINEL-1' "
        f"and Attributes/OData.CSC.StringAttribute/any(att:att/Name eq 'productType' "
        f"and att/OData.CSC.StringAttribute/Value eq '{PRODUCT_TYPE}') "
        f"and ContentDate/Start gt {date_start}T00:00:00.000Z "
        f"and ContentDate/Start lt {date_end}T00:00:00.000Z "
        f"and OData.CSC.Intersects(area=geography'SRID=4326;POLYGON(("
        f"{lon_min} {lat_min},{lon_max} {lat_min},"
        f"{lon_max} {lat_max},{lon_min} {lat_max},"
        f"{lon_min} {lat_min}))')"
    )
    params = {
        "$filter": filter_str,
        "$expand": "Attributes",
        "$top": "50",
        "$orderby": "ContentDate/Start asc",
    }

    owns_client = client is None
    client = client or httpx.Client(timeout=30.0)
    try:
        response = client.get(CATALOGUE_URL, params=params)
        response.raise_for_status()
        products = response.json().get("value", [])
        return [_to_scene_dict(p) for p in products]
    finally:
        if owns_client:
            client.close()


def _to_scene_dict(product: dict) -> dict:
    attrs = {a["Name"]: a["Value"] for a in product.get("Attributes", [])}
    return {
        "id": product["Id"],
        "name": product["Name"],
        "date": product["ContentDate"]["Start"],
        "orbit_direction": attrs.get("orbitDirection"),
        "relative_orbit": attrs.get("relativeOrbitNumber"),
        "polarisation": attrs.get("polarisationChannels"),
        # GeoJSON footprint of the actual imaged area - IW mode is acquired
        # in bursts, so a scene can intersect an AOI's bounding box while a
        # burst gap runs right through part of it (the real "Track 137
        # burst gap" bug from the original LAwildfireSAR project). Full
        # containment of the fire perimeter, not just bbox intersection, is
        # what the caller should actually check.
        "footprint": product.get("GeoFootprint"),
    }
