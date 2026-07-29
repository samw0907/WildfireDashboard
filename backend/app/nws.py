"""NWS active fire-weather alerts (Red Flag Warning, Fire Weather Watch) -
free, no API key, government-authoritative. Verified live 2026-07-29
before building against it: alert features come back with geometry=null;
the actual polygon lives on the referenced zone(s)
(`properties.affectedZones`, each a URL to `/zones/fire/{id}` which does
return real geometry). Zone boundaries are effectively static, so zones
are fetched once per cycle and deduped across alerts, not re-fetched per
alert.
"""

import logging

import httpx

logger = logging.getLogger(__name__)

ALERTS_URL = "https://api.weather.gov/alerts/active"
EVENTS = "Red Flag Warning,Fire Weather Watch"
HEADERS = {
    "User-Agent": "WildfireDashboard/0.1 (portfolio project; contact: swilliamson_0907@outlook.com)",
    "Accept": "application/geo+json",
}


def fetch_active_fire_alerts(client: httpx.Client | None = None) -> dict:
    """Returns a GeoJSON FeatureCollection: one feature per affected zone,
    carrying the parent alert's event/headline/effective/expires."""
    owns_client = client is None
    client = client or httpx.Client(timeout=30.0, headers=HEADERS)

    try:
        response = client.get(ALERTS_URL, params={"event": EVENTS})
        response.raise_for_status()
        alerts = response.json().get("features", [])

        zone_geometry_cache: dict[str, dict | None] = {}
        features = []

        for alert in alerts:
            props = alert["properties"]
            for zone_url in props.get("affectedZones", []):
                if zone_url not in zone_geometry_cache:
                    zone_geometry_cache[zone_url] = _fetch_zone_geometry(zone_url, client)
                geometry = zone_geometry_cache[zone_url]
                if geometry is None:
                    continue
                features.append(
                    {
                        "type": "Feature",
                        "geometry": geometry,
                        "properties": {
                            "event": props.get("event"),
                            "headline": props.get("headline"),
                            "areaDesc": props.get("areaDesc"),
                            "effective": props.get("effective"),
                            "expires": props.get("expires"),
                        },
                    }
                )

        return {"type": "FeatureCollection", "features": features}
    finally:
        if owns_client:
            client.close()


def _fetch_zone_geometry(zone_url: str, client: httpx.Client) -> dict | None:
    try:
        response = client.get(zone_url)
        response.raise_for_status()
        return response.json().get("geometry")
    except httpx.HTTPError:
        return None


# In-process cache, not a DB table - the dataset is tiny (a handful of
# alerts/zones nationally) and doesn't need to survive a restart, so this
# avoids the overhead of a persistent cache for something this small.
_cached_alerts: dict = {"type": "FeatureCollection", "features": []}


def get_cached_alerts() -> dict:
    return _cached_alerts


def refresh_alerts_cache() -> None:
    global _cached_alerts
    _cached_alerts = fetch_active_fire_alerts()
    logger.info("NWS fire-weather alerts refreshed: %d zone features", len(_cached_alerts["features"]))
