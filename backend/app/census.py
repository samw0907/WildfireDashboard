"""US Census Bureau client: TIGERweb for block group geometries (no key
needed, verified live), Census ACS 5-Year Data API for population
(requires a free key - Census APIs started requiring one as of a May 2026
policy change, confirmed live via a "Missing Key" response before writing
this).

Chosen over WorldPop's hosted stats API: authoritative for the US (which
is all Phase 1 needs), and reuses patterns already in this codebase
(ArcGIS REST bbox queries like nifc.py, shapely intersection math) instead
of adding raster-processing infrastructure.
"""

from dataclasses import dataclass

import httpx
from shapely.geometry import shape
from shapely.geometry.base import BaseGeometry

TIGERWEB_URL = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/1/query"
# Bumped from 2022 to 2024 (2026-08-01) - confirmed live that the 2024
# vintage is published (real dataset metadata, not just a placeholder:
# https://api.census.gov/data/2024/acs/acs5.json returns c_vintage: 2024).
# Couldn't verify actual row-level data completeness without a real
# CENSUS_API_KEY (metadata endpoints are public, data endpoints aren't),
# but this is low-risk either way - the existing graceful-degrade-on-
# failure logic below just leaves population_est null for a cycle if a
# vintage turns out to be incomplete, same as any other Census API
# failure. Verify this is still the most recent available vintage again
# if population numbers start looking stale.
ACS_URL = "https://api.census.gov/data/2024/acs/acs5"
POPULATION_VARIABLE = "B01003_001E"  # total population


@dataclass
class BlockGroup:
    geoid: str
    state_fips: str
    county_fips: str
    geometry: BaseGeometry  # WGS84


def fetch_block_groups_in_bbox(
    min_lat: float, min_lon: float, max_lat: float, max_lon: float, client: httpx.Client | None = None
) -> list[BlockGroup]:
    owns_client = client is None
    client = client or httpx.Client(timeout=30.0)

    try:
        response = client.get(
            TIGERWEB_URL,
            params={
                "geometry": f"{min_lon},{min_lat},{max_lon},{max_lat}",
                "geometryType": "esriGeometryEnvelope",
                "inSR": 4326,
                "spatialRel": "esriSpatialRelIntersects",
                "outFields": "GEOID,STATE,COUNTY",
                "returnGeometry": "true",
                "f": "geojson",
            },
        )
        response.raise_for_status()
        data = response.json()

        block_groups = []
        for feature in data.get("features", []):
            props = feature["properties"]
            geometry = feature.get("geometry")
            if geometry is None:
                continue
            block_groups.append(
                BlockGroup(
                    geoid=props["GEOID"],
                    state_fips=props["STATE"],
                    county_fips=props["COUNTY"],
                    geometry=shape(geometry),
                )
            )
        return block_groups
    finally:
        if owns_client:
            client.close()


def fetch_population_by_geoid(
    block_groups: list[BlockGroup], api_key: str, client: httpx.Client | None = None
) -> dict[str, float]:
    """Census ACS queries are hierarchical (state/county/tract), not
    arbitrary-GEOID lookups - so this fetches every block group in each
    distinct (state, county) pair represented, then keeps only the ones
    actually requested. A fire's buffer only spans multiple counties near
    a county border, so this is usually a single call.

    NOT YET LIVE-TESTED as of writing - blocked on the Census API key
    being issued. Verify this actually works once a real key is available;
    the "in=" hierarchical query syntax below is based on Census API
    documentation, not a confirmed live response.
    """
    owns_client = client is None
    client = client or httpx.Client(timeout=30.0)
    population_by_geoid: dict[str, float] = {}

    try:
        counties = {(bg.state_fips, bg.county_fips) for bg in block_groups}
        for state_fips, county_fips in counties:
            response = client.get(
                ACS_URL,
                params={
                    "get": POPULATION_VARIABLE,
                    "for": "block group:*",
                    "in": f"state:{state_fips} county:{county_fips} tract:*",
                    "key": api_key,
                },
            )
            response.raise_for_status()
            rows = response.json()
            header, *data_rows = rows
            idx = {name: i for i, name in enumerate(header)}
            for row in data_rows:
                geoid = row[idx["state"]] + row[idx["county"]] + row[idx["tract"]] + row[idx["block group"]]
                population_by_geoid[geoid] = float(row[idx[POPULATION_VARIABLE]])
        return population_by_geoid
    finally:
        if owns_client:
            client.close()
