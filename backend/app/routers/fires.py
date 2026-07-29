import httpx
from fastapi import APIRouter, Depends, Header, HTTPException
from shapely.geometry import mapping
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import geo, overpass
from ..config import get_settings
from ..db import SessionLocal
from ..exposure import BUFFER_BANDS, compute_exposure_for_fire
from ..models import BuildingCache, ExposureStat, Fire
from ..schemas import ExposureStatOut, FireDetailOut, FireOut

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


def _to_fire_out(fire: Fire, exposure: list[ExposureStat]) -> FireOut:
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
        exposure=[ExposureStatOut.model_validate(e) for e in exposure],
    )


@router.get("/fires", response_model=list[FireOut])
def list_fires(db: Session = Depends(get_db)):
    fires = db.scalars(select(Fire).order_by(Fire.source_updated.desc())).all()
    exposure_by_fire = _latest_exposure_by_fire(db, [f.id for f in fires])
    return [_to_fire_out(f, exposure_by_fire.get(f.id, [])) for f in fires]


@router.get("/fires/{fire_id}", response_model=FireDetailOut)
def get_fire(fire_id: str, db: Session = Depends(get_db)):
    fire = db.get(Fire, fire_id)
    if fire is None:
        raise HTTPException(status_code=404, detail="Fire not found")

    exposure_by_fire = _latest_exposure_by_fire(db, [fire_id])
    cache = db.get(BuildingCache, fire_id)
    buffers = {str(band): mapping(geo.buffer_meters(fire.perimeter, band)) for band in MAP_BUFFER_BANDS}

    base = _to_fire_out(fire, exposure_by_fire.get(fire_id, []))
    return FireDetailOut(**base.model_dump(), buildings=cache.buildings if cache else None, buffers=buffers)


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
