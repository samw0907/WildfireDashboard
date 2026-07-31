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

import boto3
import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from shapely.geometry import shape
from sqlalchemy.orm import Session

from .. import cdse, geo
from ..auth import require_admin_key
from ..batch import submit_sar_job
from ..config import get_settings
from ..db import SessionLocal
from ..models import Fire
from ..schemas import AcquisitionCandidatesOut, AcquisitionOut, AcquisitionSelectIn, SceneOut

# How far around the fire's discovery date to search for candidate scenes.
# Sentinel-1's revisit interval is roughly 6-12 days depending on
# constellation coverage, so these give several real candidates on each
# side without searching an unreasonably wide window.
BEFORE_WINDOW_DAYS = 21
AFTER_WINDOW_MAX_DAYS = 45
# Minimum days after discovery before searching for an "after" scene -
# imagery taken sooner risks picking up active-suppression confounders
# (retardant, emergency vehicles, debris disturbance) rather than the
# structural/vegetation change actually being measured. Matches the
# original LAwildfireSAR pipeline's own reasoning (see SAR_METHODOLOGY.md).
AFTER_WINDOW_MIN_DAYS = 14
# Padding beyond the fire's own perimeter for the search AOI - reuses the
# existing meter-accurate buffering rather than a crude degree pad.
SEARCH_BUFFER_METERS = 3000

# Composite mode needs exactly 3 scenes per side for median compositing to
# provide real outlier-robustness (median of 2 is mathematically identical
# to a mean - no benefit over a single scene). Single-pair fallback mode
# uses exactly 1. Deliberately no size in between - see SAR_METHODOLOGY.md §8.
VALID_SELECTION_SIZES = (1, 3)

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


def _acquisition_mode(before_scenes: list) -> str | None:
    if len(before_scenes) == 3:
        return "composite"
    if len(before_scenes) == 1:
        return "single_pair"
    return None


def _to_acquisition_out(fire: Fire) -> AcquisitionOut:
    before_scenes = fire.acquisition_before_scenes or []
    after_scenes = fire.acquisition_after_scenes or []
    return AcquisitionOut(
        status=fire.acquisition_status,
        before_scenes=[SceneOut(**s) for s in before_scenes],
        after_scenes=[SceneOut(**s) for s in after_scenes],
        mode=_acquisition_mode(before_scenes),
        confirmed_at=fire.acquisition_confirmed_at,
        batch_job_id=fire.acquisition_batch_job_id,
        result=fire.acquisition_result,
        burn_perimeter=fire.acquisition_burn_perimeter,
        building_damage=fire.acquisition_building_damage,
        error=fire.acquisition_error,
    )


@router.get("/fires/{fire_id}/acquisition", response_model=AcquisitionOut)
def get_acquisition(fire_id: str, db: Session = Depends(get_db)):
    fire = _get_fire_or_404(db, fire_id)
    return _to_acquisition_out(fire)


@router.get("/fires/{fire_id}/acquisition/download/{filename}")
def download_acquisition_file(fire_id: str, filename: str, db: Session = Depends(get_db)):
    """Redirects to a short-lived presigned S3 URL - the results bucket
    blocks all public access (see DECISIONS.md Phase D), so this is the
    only way the frontend can offer a plain <a href>/<img src> download
    link without exposing the bucket itself. Public/read-only, matching
    every other GET here - these are just result files, not anything
    sensitive, and downloading one costs nothing."""
    fire = _get_fire_or_404(db, fire_id)
    manifest = (fire.acquisition_result or {}).get("files", {})
    if filename not in manifest.values():
        raise HTTPException(status_code=404, detail="File not found for this fire's acquisition results")

    settings = get_settings()
    client = boto3.client("s3", region_name=settings.aws_region)
    url = client.generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.sar_results_bucket, "Key": f"acquisitions/{fire_id}/{filename}"},
        ExpiresIn=300,
    )
    return RedirectResponse(url)


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
    after_start = (discovered + timedelta(days=AFTER_WINDOW_MIN_DAYS)).date().isoformat()
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

    if len(body.before) not in VALID_SELECTION_SIZES or len(body.after) not in VALID_SELECTION_SIZES:
        raise HTTPException(
            status_code=400,
            detail="Select exactly 3 scenes per side for Composite mode, or exactly 1 per side for Single-pair mode",
        )
    if len(body.before) != len(body.after):
        raise HTTPException(
            status_code=400, detail="Before and after selections must be the same size (both 3, or both 1)"
        )

    # Every scene composited together - on both sides - must share the same
    # relative orbit/track, since compositing assumes consistent viewing
    # geometry throughout (see SAR_METHODOLOGY.md §1.3/§8). Not just
    # before-matches-after: all selected scenes on both sides together.
    all_tracks = {s.relative_orbit for s in body.before} | {s.relative_orbit for s in body.after}
    if len(all_tracks) > 1:
        raise HTTPException(
            status_code=400,
            detail=f"All selected scenes must share the same track (relative orbit) - got {sorted(t for t in all_tracks if t is not None)}",
        )

    fire.acquisition_before_scenes = [s.model_dump(mode="json") for s in body.before]
    fire.acquisition_after_scenes = [s.model_dump(mode="json") for s in body.after]
    db.commit()
    return {"status": "scenes_selected", "mode": _acquisition_mode(body.before)}


@router.post("/fires/{fire_id}/acquisition/confirm", dependencies=[Depends(require_admin_key)])
def confirm_acquisition(fire_id: str, db: Session = Depends(get_db)):
    fire = _get_fire_or_404(db, fire_id)
    if not fire.acquisition_before_scenes or not fire.acquisition_after_scenes:
        raise HTTPException(status_code=400, detail="Select both before and after scenes before confirming")

    fire.acquisition_confirmed_at = datetime.now(timezone.utc)

    # Submitted synchronously in the same request rather than handed off to
    # the polling loop to kick off - the loop's job is only to watch jobs
    # already in flight, not to discover newly-confirmed fires itself,
    # since "confirm" is already an explicit human action with its own
    # admin-gated endpoint. A submission failure here (bad AWS config,
    # Batch unreachable) surfaces immediately to the operator instead of
    # silently sitting in 'confirmed' forever.
    try:
        job_id = submit_sar_job(fire_id)
    except Exception as exc:
        fire.acquisition_status = "failed"
        fire.acquisition_error = f"Failed to submit compute job: {exc}"
        db.commit()
        raise HTTPException(status_code=502, detail=fire.acquisition_error) from exc

    fire.acquisition_status = "processing"
    fire.acquisition_batch_job_id = job_id
    fire.acquisition_error = None
    db.commit()
    return {"status": "processing", "batch_job_id": job_id}


@router.post("/fires/{fire_id}/acquisition/unmark", dependencies=[Depends(require_admin_key)])
def unmark_acquisition(fire_id: str, db: Session = Depends(get_db)):
    fire = _get_fire_or_404(db, fire_id)
    fire.acquisition_status = None
    fire.acquisition_before_scenes = None
    fire.acquisition_after_scenes = None
    fire.acquisition_confirmed_at = None
    fire.acquisition_batch_job_id = None
    fire.acquisition_result = None
    fire.acquisition_burn_perimeter = None
    fire.acquisition_building_damage = None
    fire.acquisition_error = None
    db.commit()
    return {"status": "unmarked"}
