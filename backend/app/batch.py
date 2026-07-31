"""AWS Batch job submission for the SAR compute dispatch (see DECISIONS.md
"SAR compute dispatch"). Thin wrapper - the actual pipeline logic lives
entirely in sar-compute/, not here; this module's only job is to start a
job and hand back its ID for the polling loop in main.py to watch.

Credentials come from the backend's own environment via boto3's default
chain (Railway env vars / IAM, matching the "no explicit access keys"
pattern already used for S3 sync elsewhere in this project) - never
passed explicitly.
"""

import boto3

from .config import get_settings


def submit_sar_job(fire_id: str) -> str:
    """Submit one Batch job for a confirmed fire's SAR compute run.
    FIRE_ID is the only per-job override - everything else the container
    needs (scenes, mode, perimeter) it fetches itself from this backend's
    own public API, matching entrypoint.py's design."""
    settings = get_settings()
    if not settings.sar_batch_job_queue or not settings.sar_batch_job_definition:
        raise RuntimeError("SAR_BATCH_JOB_QUEUE and SAR_BATCH_JOB_DEFINITION must both be set")

    client = boto3.client("batch", region_name=settings.aws_region)
    response = client.submit_job(
        jobName=f"sar-compute-{fire_id}",
        jobQueue=settings.sar_batch_job_queue,
        jobDefinition=settings.sar_batch_job_definition,
        containerOverrides={"environment": [{"name": "FIRE_ID", "value": fire_id}]},
    )
    return response["jobId"]
