"""Client for the NIFC WFIGS "Current Interagency Fire Perimeters" service.

Endpoint verified 2026-07-28 by resolving the ArcGIS Hub dataset item to its
underlying FeatureServer - NIFC restructures these URLs periodically, so if
ingestion starts failing, re-verify against
https://data-nifc.opendata.arcgis.com/datasets/nifc::wfigs-current-interagency-fire-perimeters
before assuming a code bug.
"""

from datetime import datetime, timezone
from typing import Any

import httpx

QUERY_URL = (
    "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/"
    "WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query"
)

OUT_FIELDS = (
    "attr_IrwinID,attr_IncidentName,poly_GISAcres,attr_IncidentSize,attr_FireDiscoveryDateTime,"
    "poly_DateCurrent,poly_CreateDate,attr_PercentContained,attr_FireCause,attr_IncidentComplexityLevel,"
    "attr_POOState"
)

PAGE_SIZE = 200


def _parse_esri_date(value: Any) -> datetime | None:
    """ArcGIS date fields come back as epoch milliseconds (int) even under f=geojson."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value / 1000, tz=timezone.utc)
    if isinstance(value, str):
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    return None


def _to_fire_record(feature: dict) -> dict | None:
    props = feature["properties"]
    geometry = feature.get("geometry")

    irwin_id = props.get("attr_IrwinID")
    if not irwin_id or geometry is None:
        # A handful of WFIGS records have no IRWIN ID or no geometry yet
        # (e.g. very newly reported incidents) - skip until they're complete.
        return None

    source_updated = _parse_esri_date(props.get("poly_DateCurrent")) or _parse_esri_date(
        props.get("poly_CreateDate")
    )
    if source_updated is None:
        return None

    return {
        "id": irwin_id.strip("{}"),
        "name": props.get("attr_IncidentName") or "Unnamed fire",
        "source": "nifc_wfigs_current",
        "perimeter": geometry,
        "acres": props.get("poly_GISAcres") or props.get("attr_IncidentSize"),
        "discovered_date": _parse_esri_date(props.get("attr_FireDiscoveryDateTime")),
        "source_updated": source_updated,
        "percent_contained": props.get("attr_PercentContained"),
        "fire_cause": props.get("attr_FireCause"),
        "complexity_level": props.get("attr_IncidentComplexityLevel"),
        # attr_POOState comes back as "US-NE" (ISO 3166-2) - strip the
        # country prefix for a cleaner "NE" in filter dropdowns etc.
        "state": (props.get("attr_POOState") or "").removeprefix("US-") or None,
    }


def fetch_current_fires(client: httpx.Client | None = None) -> list[dict]:
    """Fetch every record from the current-fires layer, paginating as needed."""
    owns_client = client is None
    client = client or httpx.Client(timeout=30.0)
    records: list[dict] = []

    try:
        offset = 0
        while True:
            response = client.get(
                QUERY_URL,
                params={
                    "where": "1=1",
                    "outFields": OUT_FIELDS,
                    "returnGeometry": "true",
                    "f": "geojson",
                    "resultOffset": offset,
                    "resultRecordCount": PAGE_SIZE,
                },
            )
            response.raise_for_status()
            data = response.json()
            features = data.get("features", [])

            for feature in features:
                record = _to_fire_record(feature)
                if record is not None:
                    records.append(record)

            if len(features) < PAGE_SIZE:
                break
            offset += PAGE_SIZE

        return records
    finally:
        if owns_client:
            client.close()
