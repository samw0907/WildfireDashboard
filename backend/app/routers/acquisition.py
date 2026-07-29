"""Human-in-the-loop SAR acquisition workflow (see DECISIONS.md): mark a
fire for follow-up, browse real live CDSE candidate scenes for a sensible
pre/post-fire window, let a human pick a before/after pair, then confirm.
Actual compute dispatch (RTC processing, change detection) is a separate,
not-yet-built phase - "confirm" here only records the decision.

State-mutating actions (mark/select/confirm/unmark) are admin-key gated,
matching the recompute endpoint's pattern - candidate search itself is
free (no CDSE auth needed) so it stays open for browsing.
"""

from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException
from shapely.geometry import shape
from sqlalchemy.orm import Session

from .. import cdse, geo
from ..auth import require_admin_key
from ..db import SessionLocal
from ..models import Fire
from ..schemas import AcquisitionCandidatesOut, AcquisitionOut, AcquisitionSelectIn, SceneOut

# How far around the fire's discovery date to search for candidate scenes.
# Sentinel-1's revisit interval is roughly 6-12 days depending on
# constellation coverage, so these give several real candidates on each
# side without searching an unreasonably wide window.
BEFORE_WINDOW_DAYS = 21
AFTER_WINDOW_MAX_DAYS = 45
# Padding beyond the fire's own perimeter for the search AOI - reuses the
# existing meter-accurate buffering rather than a crude degree pad.
SEARCH_BUFFER_METERS = 3000

router = APIRouter(prefix="/api")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _get_fire_or_404(db: Session, fire_id: str) -> Fire:
    fire = db.get(Fire, fire_id)
    if fire is None:
        raise HTTPException(status_code=404, detail="Fire not found")
    return fire


def _scene_out(scene: dict, fire_geom_albers, fire_area_albers: float) -> SceneOut:
    coverage_percent = None
    footprint = scene.get("footprint")
    if footprint and fire_area_albers > 0:
        try:
            # Real NIFC perimeters are often topologically invalid (self-
            # intersecting rings from containment lines/unburned islands) -
            # confirmed live this crashes GEOS intersection with a
            # TopologyException on some scene footprints. buffer(0) is the
            # standard shapely repair for this and doesn't meaningfully
            # change the effective area.
            scene_geom_albers = geo.to_albers(shape(footprint)).buffer(0)
            overlap = fire_geom_albers.intersection(scene_geom_albers).area
            coverage_percent = round(100 * overlap / fire_area_albers)
        except Exception:
            coverage_percent = None

    return SceneOut(
        id=scene["id"],
        name=scene["name"],
        date=scene["date"],
        orbit_direction=scene["orbit_direction"],
        relative_orbit=scene["relative_orbit"],
        polarisation=scene["polarisation"],
        aoi_coverage_percent=coverage_percent,
        footprint=footprint,
    )


def _to_acquisition_out(fire: Fire) -> AcquisitionOut:
    return AcquisitionOut(
        status=fire.acquisition_status,
        before_scene=SceneOut(**fire.acquisition_before_scene) if fire.acquisition_before_scene else None,
        after_scene=SceneOut(**fire.acquisition_after_scene) if fire.acquisition_after_scene else None,
        confirmed_at=fire.acquisition_confirmed_at,
    )


@router.get("/fires/{fire_id}/acquisition", response_model=AcquisitionOut)
def get_acquisition(fire_id: str, db: Session = Depends(get_db)):
    fire = _get_fire_or_404(db, fire_id)
    return _to_acquisition_out(fire)


@router.get("/fires/{fire_id}/acquisition/candidates", response_model=AcquisitionCandidatesOut)
def get_acquisition_candidates(fire_id: str, db: Session = Depends(get_db)):
    fire = _get_fire_or_404(db, fire_id)
    if fire.discovered_date is None:
        raise HTTPException(
            status_code=400, detail="Fire has no discovery date on record - cannot determine a search window"
        )

    bounds = geo.buffer_meters(fire.perimeter, SEARCH_BUFFER_METERS).bounds
    discovered = fire.discovered_date

    before_start = (discovered - timedelta(days=BEFORE_WINDOW_DAYS)).date().isoformat()
    before_end = discovered.date().isoformat()
    after_start = before_end
    after_end_dt = min(datetime.now(timezone.utc), discovered + timedelta(days=AFTER_WINDOW_MAX_DAYS))
    after_end = (after_end_dt + timedelta(days=1)).date().isoformat()

    try:
        with httpx.Client(timeout=30.0) as client:
            before_scenes = cdse.search_scenes(bounds, before_start, before_end, client)
            after_scenes = cdse.search_scenes(bounds, after_start, after_end, client)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail=f"CDSE scene search failed (upstream error): {exc}") from exc

    fire_geom_albers = geo.to_albers(shape(fire.perimeter)).buffer(0)
    fire_area_albers = fire_geom_albers.area

    return AcquisitionCandidatesOut(
        before=[_scene_out(s, fire_geom_albers, fire_area_albers) for s in before_scenes],
        after=[_scene_out(s, fire_geom_albers, fire_area_albers) for s in after_scenes],
    )


@router.post("/fires/{fire_id}/acquisition/mark", dependencies=[Depends(require_admin_key)])
def mark_for_acquisition(fire_id: str, db: Session = Depends(get_db)):
    fire = _get_fire_or_404(db, fire_id)
    if fire.discovered_date is None:
        raise HTTPException(
            status_code=400, detail="Fire has no discovery date on record - cannot mark for acquisition"
        )
    fire.acquisition_status = "marked"
    db.commit()
    return {"status": "marked"}


@router.post("/fires/{fire_id}/acquisition/select", dependencies=[Depends(require_admin_key)])
def select_scenes(fire_id: str, body: AcquisitionSelectIn, db: Session = Depends(get_db)):
    fire = _get_fire_or_404(db, fire_id)
    if fire.acquisition_status is None:
        raise HTTPException(status_code=400, detail="Fire is not marked for acquisition yet")

    fire.acquisition_before_scene = body.before.model_dump(mode="json")
    fire.acquisition_after_scene = body.after.model_dump(mode="json")
    db.commit()
    return {"status": "scenes_selected"}


@router.post("/fires/{fire_id}/acquisition/confirm", dependencies=[Depends(require_admin_key)])
def confirm_acquisition(fire_id: str, db: Session = Depends(get_db)):
    fire = _get_fire_or_404(db, fire_id)
    if not fire.acquisition_before_scene or not fire.acquisition_after_scene:
        raise HTTPException(status_code=400, detail="Select both a before and after scene before confirming")

    fire.acquisition_status = "confirmed"
    fire.acquisition_confirmed_at = datetime.now(timezone.utc)
    db.commit()
    return {"status": "confirmed"}


@router.post("/fires/{fire_id}/acquisition/unmark", dependencies=[Depends(require_admin_key)])
def unmark_acquisition(fire_id: str, db: Session = Depends(get_db)):
    fire = _get_fire_or_404(db, fire_id)
    fire.acquisition_status = None
    fire.acquisition_before_scene = None
    fire.acquisition_after_scene = None
    fire.acquisition_confirmed_at = None
    db.commit()
    return {"status": "unmarked"}
