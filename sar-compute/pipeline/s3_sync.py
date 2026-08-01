"""Result upload to S3 - adapted from LAwildfireSAR's scripts/sync_to_s3.py.
One real change: uses boto3's default credential chain (the Fargate task's
IAM role) rather than explicit AWS_ACCESS_KEY_ID/SECRET env vars - cleaner
and more secure since this runs inside AWS infrastructure that can just be
granted an S3-scoped role, unlike the original standalone script which
had no such role to rely on.
"""

import logging
import os

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)


def get_s3_client(region: str):
    return boto3.client("s3", region_name=region)


def upload_file(s3_client, local_path: str, bucket: str, s3_key: str) -> None:
    size_mb = os.path.getsize(local_path) / (1024 * 1024)
    logger.info("Uploading: %s (%.1f MB)", s3_key, size_mb)
    if size_mb > 100:
        from boto3.s3.transfer import TransferConfig

        config = TransferConfig(multipart_threshold=100 * 1024 * 1024, multipart_chunksize=50 * 1024 * 1024)
        s3_client.upload_file(local_path, bucket, s3_key, Config=config)
    else:
        s3_client.upload_file(local_path, bucket, s3_key)


def run_sync(fire_id: str, sequence: int, bucket: str, region: str, files: dict[str, str]) -> dict[str, str]:
    """Uploads the given {label: local_path} files under
    s3://{bucket}/acquisitions/{fire_id}/{sequence}/{label-derived filename}.
    The sequence keeps a later acquisition on the same fire from silently
    overwriting an earlier one's results. Returns {label: s3_key} for
    whichever files existed and were uploaded (a missing/None local path
    is skipped, not an error - e.g. no burn perimeter was detected at all)."""
    s3_client = get_s3_client(region)

    try:
        s3_client.head_bucket(Bucket=bucket)
    except ClientError as exc:
        logger.error("Cannot access S3 bucket '%s': %s", bucket, exc)
        raise

    prefix = f"acquisitions/{fire_id}/{sequence}"
    uploaded_keys = {}
    for label, local_path in files.items():
        if not local_path or not os.path.exists(local_path):
            logger.info("Skipping %s - no output file produced", label)
            continue
        filename = os.path.basename(local_path)
        s3_key = f"{prefix}/{filename}"
        upload_file(s3_client, local_path, bucket, s3_key)
        uploaded_keys[label] = s3_key

    logger.info("Sync complete: %d files uploaded to s3://%s/%s/", len(uploaded_keys), bucket, prefix)
    return uploaded_keys
