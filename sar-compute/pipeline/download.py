"""CDSE scene download - adapted from LAwildfireSAR's src/pipeline/download.py.

Deliberately simpler than the original: `search_scene()` and
`select_orbit_direction()` are dropped entirely, because the exact scene
(product ID) and track were already chosen by a human via the
mark-for-acquisition picker UI - there's nothing left to search for or
decide here, just download exactly what was picked.
"""

import logging
import os

import httpx

logger = logging.getLogger(__name__)

TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token"
DOWNLOAD_URL_TEMPLATE = "https://download.dataspace.copernicus.eu/odata/v1/Products({product_id})/$value"


def get_cdse_credentials() -> tuple[str, str]:
    user = os.environ.get("CDSE_USER")
    password = os.environ.get("CDSE_PASSWORD")
    if not user or not password:
        raise EnvironmentError("CDSE_USER or CDSE_PASSWORD not set in environment")
    return user, password


def get_access_token(user: str, password: str) -> str:
    """Authenticate with CDSE and return an access token - unchanged from
    the original, only needed for the actual download, not for search."""
    response = httpx.post(
        TOKEN_URL,
        data={
            "client_id": "cdse-public",
            "username": user,
            "password": password,
            "grant_type": "password",
        },
        timeout=30.0,
    )
    response.raise_for_status()
    return response.json()["access_token"]


def download_scene(product_id: str, product_name: str, token: str, output_dir: str) -> str:
    """Download a single Sentinel-1 scene, identified by the exact CDSE
    product ID already chosen via the picker UI. Skips download if the
    file already exists (matches original behavior - useful if a job
    retries after a partial failure)."""
    output_path = os.path.join(output_dir, f"{product_name}.zip")

    if os.path.exists(output_path):
        logger.info("Already exists, skipping download: %s", product_name)
        return output_path

    logger.info("Downloading: %s", product_name)
    url = DOWNLOAD_URL_TEMPLATE.format(product_id=product_id)

    os.makedirs(output_dir, exist_ok=True)
    with httpx.stream(
        "GET", url, headers={"Authorization": f"Bearer {token}"}, timeout=None, follow_redirects=True
    ) as response:
        response.raise_for_status()
        with open(output_path, "wb") as f:
            for chunk in response.iter_bytes(chunk_size=8192):
                f.write(chunk)

    logger.info("Downloaded: %s", product_name)
    return output_path
