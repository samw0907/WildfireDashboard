"""Polls in-flight SAR compute jobs and records terminal outcomes - the
other half of batch.py's submit_sar_job(). Runs on the same asyncio
background-loop pattern as ingestion/exposure/alerts (see main.py), not a
webhook/EventBridge setup, matching this project's existing polling
architecture (see DECISIONS.md "SAR compute dispatch").
"""

import json
import logging

import boto3
from botocore.exceptions import ClientError
from sqlalchemy import select

from .config import get_settings
from .db import SessionLocal
from .models import Fire

logger = logging.getLogger(__name__)

# AWS Batch's DescribeJobs caps at 100 job IDs per call - chunk defensively
# even though this project only ever expects a handful of fires in flight.
DESCRIBE_JOBS_CHUNK_SIZE = 100


def _fetch_json(fire_id: str, bucket: str, region: str, filename: str, required: bool) -> dict | None:
    """Fetch one of the job's JSON/GeoJSON outputs from
    s3://{bucket}/acquisitions/{fire_id}/{filename}. `required=False` is
    for burn_perimeter.geojson specifically - entrypoint.py's s3_sync
    skips uploading it entirely when no burn area was detected at all
    (a real, valid outcome, not a failure), so a missing-key error there
    is expected and shouldn't be logged as one."""
    s3_client = boto3.client("s3", region_name=region)
    key = f"acquisitions/{fire_id}/{filename}"
    try:
        response = s3_client.get_object(Bucket=bucket, Key=key)
        return json.loads(response["Body"].read())
    except ClientError as exc:
        if required:
            logger.error("Job succeeded for fire %s but %s missing at s3://%s/%s: %s",
                         fire_id, filename, bucket, key, exc)
        return None


def run_sar_batch_poll_cycle() -> None:
    settings = get_settings()
    db = SessionLocal()
    try:
        fires = db.scalars(
            select(Fire).where(Fire.acquisition_status == "processing", Fire.acquisition_batch_job_id.isnot(None))
        ).all()
        if not fires:
            return

        by_job_id = {fire.acquisition_batch_job_id: fire for fire in fires}
        client = boto3.client("batch", region_name=settings.aws_region)

        job_ids = list(by_job_id.keys())
        for i in range(0, len(job_ids), DESCRIBE_JOBS_CHUNK_SIZE):
            chunk = job_ids[i : i + DESCRIBE_JOBS_CHUNK_SIZE]
            response = client.describe_jobs(jobs=chunk)
            for job in response["jobs"]:
                fire = by_job_id[job["jobId"]]
                status = job["status"]

                if status == "SUCCEEDED":
                    bucket, region = settings.sar_results_bucket, settings.aws_region
                    fire.acquisition_result = _fetch_json(fire.id, bucket, region, "result_summary.json", required=True)
                    fire.acquisition_burn_perimeter = _fetch_json(
                        fire.id, bucket, region, "burn_perimeter.geojson", required=False
                    )
                    fire.acquisition_building_damage = _fetch_json(
                        fire.id, bucket, region, "building_damage.geojson", required=True
                    )
                    fire.acquisition_status = "complete"
                elif status == "FAILED":
                    fire.acquisition_error = job.get("statusReason") or "SAR compute job failed (no reason given)"
                    fire.acquisition_status = "failed"
                # else: SUBMITTED/PENDING/RUNNABLE/STARTING/RUNNING - still in flight, leave as-is.

        db.commit()
    finally:
        db.close()
