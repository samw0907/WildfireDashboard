"""NWS point forecast (current wind + multi-day outlook) for a fire's
location - free, no API key, same government-authoritative source already
used for Red Flag Warnings. Verified live 2026-07-29: `/points/{lat},{lon}`
resolves the forecast office grid cell, whose `forecast` URL returns ~14
twelve-hour day/night periods (~7 days) with windSpeed as a range string
("5 to 12 mph"), windDirection as a 16-point compass string ("SSW"), and
probabilityOfPrecipitation nested as `{value: int | null}`.
"""

import logging
import re
import time

import httpx

logger = logging.getLogger(__name__)

HEADERS = {
    "User-Agent": "WildfireDashboard/0.1 (portfolio project; contact: swilliamson_0907@outlook.com)",
    "Accept": "application/geo+json",
}

# Forecasts update roughly every few hours upstream and don't need to be
# fetched fresh on every Fire Detail page view - a short in-process cache
# (same pattern as the alerts cache in nws.py) avoids hammering NWS while
# still staying current within a session.
CACHE_TTL_SECONDS = 30 * 60
_cache: dict[tuple[float, float], tuple[float, dict]] = {}

COMPASS_DEGREES = {
    "N": 0.0, "NNE": 22.5, "NE": 45.0, "ENE": 67.5,
    "E": 90.0, "ESE": 112.5, "SE": 135.0, "SSE": 157.5,
    "S": 180.0, "SSW": 202.5, "SW": 225.0, "WSW": 247.5,
    "W": 270.0, "WNW": 292.5, "NW": 315.0, "NNW": 337.5,
}


def parse_wind_speed_mph(text: str | None) -> float | None:
    """"5 to 12 mph" -> 12.0 (the upper bound - more relevant for spread
    risk than the lower one). "10 mph" -> 10.0."""
    if not text:
        return None
    numbers = [float(n) for n in re.findall(r"\d+(?:\.\d+)?", text)]
    return max(numbers) if numbers else None


def fetch_forecast_periods(lat: float, lon: float, client: httpx.Client | None = None) -> list[dict] | None:
    cache_key = (round(lat, 3), round(lon, 3))
    cached = _cache.get(cache_key)
    if cached and time.monotonic() - cached[0] < CACHE_TTL_SECONDS:
        return cached[1]["periods"]

    owns_client = client is None
    client = client or httpx.Client(timeout=15.0, headers=HEADERS)
    try:
        points_resp = client.get(f"https://api.weather.gov/points/{lat:.4f},{lon:.4f}")
        points_resp.raise_for_status()
        forecast_url = points_resp.json()["properties"]["forecast"]

        forecast_resp = client.get(forecast_url)
        forecast_resp.raise_for_status()
        periods = forecast_resp.json()["properties"]["periods"]

        _cache[cache_key] = (time.monotonic(), {"periods": periods})
        return periods
    except (httpx.HTTPError, KeyError) as exc:
        logger.warning("NWS forecast fetch failed for (%s, %s): %s", lat, lon, exc)
        return None
    finally:
        if owns_client:
            client.close()
