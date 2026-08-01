"""Human-in-the-loop SAR acquisition workflow (see DECISIONS.md): mark a
fire for follow-up, browse real live CDSE candidate scenes for a sensible
pre/post-fire window, let a human pick a before/after pair, then confirm.
Actual compute dispatch (RTC processing, change detection) is a separate
phase - "confirm" here only records the decision and submits the job.

A fire can be acquired more than once over its lifetime (conditions
change, a better after-scene becomes available later) - each attempt is
its own `Acquisition` row, numbered by `sequence` starting at 1. Only one
non-terminal attempt (status 'marked' or 'processing') is allowed per fire
at a time; completed/failed attempts don't block starting a new one.

State-mutating actions (create/select/confirm/unmark) are admin-key gated,
matching the recompute endpoint's pattern - candidate search itself is
free (no CDSE auth needed) so it stays open for browsing.
"""

import io
import zipfile
from datetime import datetime, timedelta, timezone

import boto3
import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse, StreamingResponse
from shapely.geometry import shape
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import cdse, geo
from ..auth import require_admin_key
from ..batch import submit_sar_job
from ..config import get_settings
from ..db import SessionLocal
from ..models import Acquisition, Fire
from ..schemas import (
    AcquisitionCandidatesOut,
    AcquisitionOut,
    AcquisitionSelectIn,
    CandidateSceneOut,
    ScenePriorUseOut,
)

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

# An acquisition in either of these statuses is still "in play" - only one
# per fire at a time, so a new one can't be started until it's resolved.
NON_TERMINAL_STATUSES = ("marked", "processing")

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


def _get_acquisition_or_404(db: Session, fire_id: str, sequence: int) -> Acquisition:
    acquisition = db.scalars(
        select(Acquisition).where(Acquisition.fire_id == fire_id, Acquisition.sequence == sequence)
    ).first()
    if acquisition is None:
        raise HTTPException(status_code=404, detail="Acquisition not found")
    return acquisition


def _list_acquisitions(db: Session, fire_id: str) -> list[Acquisition]:
    return list(
        db.scalars(
            select(Acquisition).where(Acquisition.fire_id == fire_id).order_by(Acquisition.sequence)
        ).all()
    )


def _scene_out(scene: dict, fire_geom_albers, fire_area_albers: float) -> CandidateSceneOut:
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

    return CandidateSceneOut(
        id=scene["id"],
        name=scene["name"],
        date=scene["date"],
        orbit_direction=scene["orbit_direction"],
        relative_orbit=scene["relative_orbit"],
        polarisation=scene["polarisation"],
        aoi_coverage_percent=coverage_percent,
        footprint=footprint,
    )


def _annotate_previous_use(scenes: list[CandidateSceneOut], prior_acquisitions: list[Acquisition]) -> None:
    """Mutates each scene in place, filling in `previously_used` from
    every earlier acquisition on this same fire that selected it - so the
    picker can show "already used in Acquisition #1 (before)" instead of
    silently pre-selecting or hiding anything. A human still picks freely;
    this is informational only."""
    uses_by_id: dict[str, list[ScenePriorUseOut]] = {}
    for acq in prior_acquisitions:
        for side, side_scenes in (("before", acq.before_scenes or []), ("after", acq.after_scenes or [])):
            for s in side_scenes:
                uses_by_id.setdefault(s["id"], []).append(
                    ScenePriorUseOut(sequence=acq.sequence, side=side, status=acq.status)
                )
    for scene in scenes:
        scene.previously_used = uses_by_id.get(scene.id, [])


def _acquisition_mode(before_scenes: list) -> str | None:
    if len(before_scenes) == 3:
        return "composite"
    if len(before_scenes) == 1:
        return "single_pair"
    return None


def _to_acquisition_out(acq: Acquisition) -> AcquisitionOut:
    before_scenes = acq.before_scenes or []
    after_scenes = acq.after_scenes or []
    return AcquisitionOut(
        sequence=acq.sequence,
        created_at=acq.created_at,
        status=acq.status,
        before_scenes=before_scenes,
        after_scenes=after_scenes,
        mode=_acquisition_mode(before_scenes),
        confirmed_at=acq.confirmed_at,
        batch_job_id=acq.batch_job_id,
        result=acq.result,
        burn_perimeter=acq.burn_perimeter,
        building_damage=acq.building_damage,
        error=acq.error,
    )


@router.get("/fires/{fire_id}/acquisitions", response_model=list[AcquisitionOut])
def list_acquisitions(fire_id: str, db: Session = Depends(get_db)):
    _get_fire_or_404(db, fire_id)
    return [_to_acquisition_out(a) for a in _list_acquisitions(db, fire_id)]


@router.get("/fires/{fire_id}/acquisitions/{sequence}", response_model=AcquisitionOut)
def get_acquisition(fire_id: str, sequence: int, db: Session = Depends(get_db)):
    _get_fire_or_404(db, fire_id)
    return _to_acquisition_out(_get_acquisition_or_404(db, fire_id, sequence))


@router.get("/fires/{fire_id}/acquisitions/{sequence}/download/{filename}")
def download_acquisition_file(fire_id: str, sequence: int, filename: str, db: Session = Depends(get_db)):
    """Redirects to a short-lived presigned S3 URL - the results bucket
    blocks all public access (see DECISIONS.md Phase D), so this is the
    only way the frontend can offer a plain <a href>/<img src> download
    link without exposing the bucket itself. Public/read-only, matching
    every other GET here - these are just result files, not anything
    sensitive, and downloading one costs nothing."""
    _get_fire_or_404(db, fire_id)
    acq = _get_acquisition_or_404(db, fire_id, sequence)
    manifest = (acq.result or {}).get("files", {})
    if filename not in manifest.values():
        raise HTTPException(status_code=404, detail="File not found for this acquisition's results")

    settings = get_settings()
    # Explicit regional endpoint_url, not just region_name - boto3's S3
    # client otherwise defaults to the global s3.amazonaws.com endpoint,
    # which S3 answers with its own 307 redirect to the real regional
    # endpoint for a non-us-east-1 bucket. A normal signed request
    # survives that transparently (botocore re-signs and retries), but a
    # *presigned* URL can't - the signature is baked in for whoever
    # fetches it later, and a changed Host header invalidates it,
    # producing SignatureDoesNotMatch on the client's second hop. Caught
    # live: the exact failure mode here, not a hypothetical.
    client = boto3.client(
        "s3", region_name=settings.aws_region, endpoint_url=f"https://s3.{settings.aws_region}.amazonaws.com"
    )
    url = client.generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.sar_results_bucket, "Key": f"acquisitions/{fire_id}/{sequence}/{filename}"},
        ExpiresIn=300,
    )
    return RedirectResponse(url)


@router.get("/fires/{fire_id}/acquisitions/{sequence}/download-all")
def download_all_acquisition_files(fire_id: str, sequence: int, db: Session = Depends(get_db)):
    """Zips every file in this acquisition's result manifest and streams it
    back - a real download convenience given how many files one
    acquisition now produces (raw RTC rasters + GeoJSON + figures), not
    just a nice-to-have. Built in-memory rather than a temp file on disk -
    fine at this project's per-fire result sizes and demo-scale traffic."""
    _get_fire_or_404(db, fire_id)
    acq = _get_acquisition_or_404(db, fire_id, sequence)
    manifest = (acq.result or {}).get("files", {})
    if not manifest:
        raise HTTPException(status_code=404, detail="No result files available for this acquisition")

    settings = get_settings()
    client = boto3.client(
        "s3", region_name=settings.aws_region, endpoint_url=f"https://s3.{settings.aws_region}.amazonaws.com"
    )

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for filename in manifest.values():
            obj = client.get_object(Bucket=settings.sar_results_bucket, Key=f"acquisitions/{fire_id}/{sequence}/{filename}")
            zf.writestr(filename, obj["Body"].read())
    buffer.seek(0)

    return StreamingResponse(
        buffer,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{fire_id}-acquisition-{sequence}-results.zip"'},
    )


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

    before_out = [_scene_out(s, fire_geom_albers, fire_area_albers) for s in before_scenes]
    after_out = [_scene_out(s, fire_geom_albers, fire_area_albers) for s in after_scenes]

    prior_acquisitions = _list_acquisitions(db, fire_id)
    _annotate_previous_use(before_out, prior_acquisitions)
    _annotate_previous_use(after_out, prior_acquisitions)

    return AcquisitionCandidatesOut(before=before_out, after=after_out)


@router.post("/fires/{fire_id}/acquisitions", dependencies=[Depends(require_admin_key)], response_model=AcquisitionOut)
def create_acquisition(fire_id: str, db: Session = Depends(get_db)):
    fire = _get_fire_or_404(db, fire_id)
    if fire.discovered_date is None:
        raise HTTPException(
            status_code=400, detail="Fire has no discovery date on record - cannot mark for acquisition"
        )

    existing = _list_acquisitions(db, fire_id)
    in_flight = next((a for a in existing if a.status in NON_TERMINAL_STATUSES), None)
    if in_flight is not None:
        raise HTTPException(
            status_code=400,
            detail=f"Acquisition #{in_flight.sequence} is still {in_flight.status} - resolve it before starting another",
        )

    next_sequence = (max((a.sequence for a in existing), default=0)) + 1
    acquisition = Acquisition(fire_id=fire_id, sequence=next_sequence, status="marked")
    db.add(acquisition)
    db.commit()
    db.refresh(acquisition)
    return _to_acquisition_out(acquisition)


@router.post("/fires/{fire_id}/acquisitions/{sequence}/select", dependencies=[Depends(require_admin_key)])
def select_scenes(fire_id: str, sequence: int, body: AcquisitionSelectIn, db: Session = Depends(get_db)):
    _get_fire_or_404(db, fire_id)
    acquisition = _get_acquisition_or_404(db, fire_id, sequence)
    if acquisition.status != "marked":
        raise HTTPException(status_code=400, detail=f"Acquisition #{sequence} is {acquisition.status}, not marked")

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

    acquisition.before_scenes = [s.model_dump(mode="json") for s in body.before]
    acquisition.after_scenes = [s.model_dump(mode="json") for s in body.after]
    db.commit()
    return {"status": "scenes_selected", "mode": _acquisition_mode(body.before)}


@router.post("/fires/{fire_id}/acquisitions/{sequence}/confirm", dependencies=[Depends(require_admin_key)])
def confirm_acquisition(fire_id: str, sequence: int, db: Session = Depends(get_db)):
    _get_fire_or_404(db, fire_id)
    acquisition = _get_acquisition_or_404(db, fire_id, sequence)
    if not acquisition.before_scenes or not acquisition.after_scenes:
        raise HTTPException(status_code=400, detail="Select both before and after scenes before confirming")

    acquisition.confirmed_at = datetime.now(timezone.utc)

    # Submitted synchronously in the same request rather than handed off to
    # the polling loop to kick off - the loop's job is only to watch jobs
    # already in flight, not to discover newly-confirmed fires itself,
    # since "confirm" is already an explicit human action with its own
    # admin-gated endpoint. A submission failure here (bad AWS config,
    # Batch unreachable) surfaces immediately to the operator instead of
    # silently sitting in 'confirmed' forever.
    try:
        job_id = submit_sar_job(fire_id, sequence)
    except Exception as exc:
        acquisition.status = "failed"
        acquisition.error = f"Failed to submit compute job: {exc}"
        db.commit()
        raise HTTPException(status_code=502, detail=acquisition.error) from exc

    acquisition.status = "processing"
    acquisition.batch_job_id = job_id
    acquisition.error = None
    db.commit()
    return {"status": "processing", "batch_job_id": job_id}


@router.post("/fires/{fire_id}/acquisitions/{sequence}/unmark", dependencies=[Depends(require_admin_key)])
def unmark_acquisition(fire_id: str, sequence: int, db: Session = Depends(get_db)):
    """Deletes a never-confirmed draft outright, rather than resetting its
    fields - once an acquisition has been confirmed it's real history and
    must never be discarded this way (enforced by the status check below);
    only an abandoned draft can be unmarked."""
    _get_fire_or_404(db, fire_id)
    acquisition = _get_acquisition_or_404(db, fire_id, sequence)
    if acquisition.status != "marked":
        raise HTTPException(
            status_code=400, detail=f"Acquisition #{sequence} is {acquisition.status} - only a draft can be unmarked"
        )
    db.delete(acquisition)
    db.commit()
    return {"status": "unmarked"}


@router.delete("/fires/{fire_id}/acquisitions/{sequence}", dependencies=[Depends(require_admin_key)])
def delete_acquisition(fire_id: str, sequence: int, db: Session = Depends(get_db)):
    """Permanently deletes an acquisition's DB row and its stored S3
    results - unlike unmark (drafts only), this works for any terminal
    status ('marked', 'complete', 'failed'), for deliberately discarding
    an outdated or superseded run. Blocked on 'processing' - a live Batch
    job would keep running with nothing left to report its result to, and
    no way to see whether it succeeded or failed."""
    _get_fire_or_404(db, fire_id)
    acquisition = _get_acquisition_or_404(db, fire_id, sequence)
    if acquisition.status == "processing":
        raise HTTPException(
            status_code=400,
            detail=f"Acquisition #{sequence} is still processing - wait for it to finish before deleting",
        )

    settings = get_settings()
    client = boto3.client("s3", region_name=settings.aws_region)
    prefix = f"acquisitions/{fire_id}/{sequence}/"
    paginator = client.get_paginator("list_objects_v2")
    keys = [
        obj["Key"]
        for page in paginator.paginate(Bucket=settings.sar_results_bucket, Prefix=prefix)
        for obj in page.get("Contents", [])
    ]
    if keys:
        # delete_objects caps at 1000 keys per call - chunk defensively
        # even though one acquisition never produces close to that many.
        for i in range(0, len(keys), 1000):
            chunk = keys[i : i + 1000]
            client.delete_objects(
                Bucket=settings.sar_results_bucket, Delete={"Objects": [{"Key": k} for k in chunk]}
            )

    db.delete(acquisition)
    db.commit()
    return {"status": "deleted", "s3_objects_deleted": len(keys)}
