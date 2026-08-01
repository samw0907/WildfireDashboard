import httpx
from fastapi import APIRouter, Depends, Header, HTTPException
from shapely.geometry import mapping, shape
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import geo, overpass, weather
from ..config import get_settings
from ..db import SessionLocal
from ..exposure import BUFFER_BANDS, compute_exposure_for_fire
from ..models import Acquisition, BuildingCache, ExposureStat, Fire
from ..nws import fires_in_active_warnings, get_cached_alerts
from ..priority import compute_priority_scores
from ..schemas import ExposureStatOut, FireDetailOut, FireOut, FireWeatherOut, ForecastPeriodOut, WindOut

# Daytime-only periods to return - 5 days including today, no overnight
# rows (kept the Fire Detail forecast panel compact per user feedback).
FORECAST_DAYS = 5

# Bands worth drawing as a ring on the map - excludes 0 (the perimeter
# itself, which the frontend already has and renders separately).
MAP_BUFFER_BANDS = [b for b in BUFFER_BANDS if b > 0]

router = APIRouter(prefix="/api")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _latest_exposure_by_fire(session: Session, fire_ids: list[str]) -> dict[str, list[ExposureStat]]:
    """exposure_stats keeps a full history (new rows per recompute), so this
    picks the newest row per (fire_id, buffer_meters) rather than reading a
    'latest' column that doesn't exist by design."""
    if not fire_ids:
        return {}

    rows = session.scalars(
        select(ExposureStat)
        .where(ExposureStat.fire_id.in_(fire_ids))
        .order_by(ExposureStat.fire_id, ExposureStat.buffer_meters, ExposureStat.computed_at.desc())
    ).all()

    latest: dict[tuple[str, int], ExposureStat] = {}
    for row in rows:
        key = (row.fire_id, row.buffer_meters)
        if key not in latest:
            latest[key] = row

    by_fire: dict[str, list[ExposureStat]] = {}
    for (fire_id, _band), row in latest.items():
        by_fire.setdefault(fire_id, []).append(row)
    return by_fire


def _fire_ids_with_acquisitions(session: Session, fire_ids: list[str]) -> set[str]:
    if not fire_ids:
        return set()
    return set(
        session.scalars(select(Acquisition.fire_id).where(Acquisition.fire_id.in_(fire_ids)).distinct())
    )


def _to_fire_out(
    fire: Fire, exposure: list[ExposureStat], priority_score: float, in_warning: bool, has_acquisition: bool
) -> FireOut:
    return FireOut(
        id=fire.id,
        name=fire.name,
        source=fire.source,
        perimeter=fire.perimeter,
        acres=fire.acres,
        discovered_date=fire.discovered_date,
        source_updated=fire.source_updated,
        percent_contained=fire.percent_contained,
        fire_cause=fire.fire_cause,
        complexity_level=fire.complexity_level,
        state=fire.state,
        priority_score=priority_score,
        in_active_fire_weather_warning=in_warning,
        has_acquisition=has_acquisition,
        exposure=[ExposureStatOut.model_validate(e) for e in exposure],
    )


@router.get("/fires", response_model=list[FireOut])
def list_fires(db: Session = Depends(get_db)):
    fires = db.scalars(select(Fire).order_by(Fire.source_updated.desc())).all()
    exposure_by_fire = _latest_exposure_by_fire(db, [f.id for f in fires])
    flagged = fires_in_active_warnings(list(fires), get_cached_alerts())
    scores = compute_priority_scores(list(fires), exposure_by_fire, flagged)
    acquired = _fire_ids_with_acquisitions(db, [f.id for f in fires])
    return [
        _to_fire_out(f, exposure_by_fire.get(f.id, []), scores.get(f.id, 0.0), f.id in flagged, f.id in acquired)
        for f in fires
    ]


@router.get("/fires/{fire_id}", response_model=FireDetailOut)
def get_fire(fire_id: str, db: Session = Depends(get_db)):
    fire = db.get(Fire, fire_id)
    if fire is None:
        raise HTTPException(status_code=404, detail="Fire not found")

    # Priority score is relative to the whole current fire list (see
    # priority.py), so this needs every fire's data, not just this one's.
    all_fires = db.scalars(select(Fire)).all()
    exposure_by_fire = _latest_exposure_by_fire(db, [f.id for f in all_fires])
    flagged = fires_in_active_warnings(list(all_fires), get_cached_alerts())
    scores = compute_priority_scores(list(all_fires), exposure_by_fire, flagged)

    cache = db.get(BuildingCache, fire_id)
    buffers = {str(band): mapping(geo.buffer_meters(fire.perimeter, band)) for band in MAP_BUFFER_BANDS}
    has_acquisition = fire_id in _fire_ids_with_acquisitions(db, [fire_id])

    base = _to_fire_out(
        fire, exposure_by_fire.get(fire_id, []), scores.get(fire_id, 0.0), fire_id in flagged, has_acquisition
    )
    return FireDetailOut(**base.model_dump(), buildings=cache.buildings if cache else None, buffers=buffers)


@router.get("/fires/{fire_id}/weather", response_model=FireWeatherOut)
def get_fire_weather(fire_id: str, db: Session = Depends(get_db)):
    fire = db.get(Fire, fire_id)
    if fire is None:
        raise HTTPException(status_code=404, detail="Fire not found")

    centroid = shape(fire.perimeter).centroid
    with httpx.Client(timeout=15.0, headers=weather.HEADERS) as client:
        periods = weather.fetch_forecast_periods(centroid.y, centroid.x, client)

    if periods is None:
        raise HTTPException(status_code=503, detail="Weather forecast temporarily unavailable")

    # Current wind uses the actual current period (may be an overnight one
    # if it's evening), regardless of the daytime-only filter below - that
    # filter is just for the day-by-day forecast row.
    current = periods[0] if periods else None
    wind = WindOut(
        speed_mph=weather.parse_wind_speed_mph(current.get("windSpeed")) if current else None,
        direction_degrees=weather.COMPASS_DEGREES.get(current.get("windDirection", "")) if current else None,
        direction_text=current.get("windDirection") if current else None,
    )

    day_periods = [p for p in periods if p.get("isDaytime")]

    return FireWeatherOut(
        wind=wind,
        periods=[
            ForecastPeriodOut(
                name=p["name"],
                start_time=p["startTime"],
                is_daytime=p["isDaytime"],
                temperature=p.get("temperature"),
                temperature_unit=p.get("temperatureUnit"),
                short_forecast=p.get("shortForecast"),
                wind_speed=p.get("windSpeed"),
                wind_direction=p.get("windDirection"),
                probability_of_precipitation=(p.get("probabilityOfPrecipitation") or {}).get("value"),
            )
            for p in day_periods[:FORECAST_DAYS]
        ],
    )


def require_recompute_key(x_api_key: str | None = Header(default=None)) -> None:
    settings = get_settings()
    # Fail closed: if no key is configured server-side, the endpoint refuses
    # every request rather than silently allowing unauthenticated access.
    if not settings.recompute_api_key or x_api_key != settings.recompute_api_key:
        raise HTTPException(status_code=403, detail="Invalid or missing API key")


@router.post("/fires/{fire_id}/recompute", dependencies=[Depends(require_recompute_key)])
def trigger_recompute(fire_id: str, db: Session = Depends(get_db)):
    fire = db.get(Fire, fire_id)
    if fire is None:
        raise HTTPException(status_code=404, detail="Fire not found")

    try:
        with httpx.Client(timeout=overpass.HTTP_TIMEOUT, headers=overpass.HEADERS) as client:
            compute_exposure_for_fire(db, fire, client)
    except Exception as exc:
        db.rollback()
        # Same "Overpass is unreliable, don't pretend otherwise" stance as the
        # background exposure loop - surface it as a clean upstream-failure
        # response rather than an unhandled 500 traceback.
        raise HTTPException(status_code=503, detail=f"Exposure recompute failed (upstream error): {exc}") from exc

    return {"status": "recomputed", "fire_id": fire_id}
