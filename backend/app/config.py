from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# .env lives at the repo root, one level above backend/
ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


class Settings(BaseSettings):
    cors_allowed_origins: str = "http://localhost:5173"

    # Railway provides both: DATABASE_URL (internal hostname, only resolves inside
    # Railway's own network - this is what the deployed backend will use) and
    # DATABASE_PUBLIC_URL (external proxy, needed for local dev / Alembic runs
    # from this machine). Prefer the public one when both are set.
    database_url: str | None = None
    database_public_url: str | None = None

    nifc_ingestion_interval_minutes: int = 15
    # Temporarily lowered from 24 to 3 (2026-08-02) to backfill population
    # data faster after a sustained Census API failure window left ~half
    # of tracked fires with population_est null on their last recompute -
    # a fire only gets retried at all once its own staleness cutoff passes,
    # so 24h meant a bad fire could sit null for a full day. Revert to 24
    # once the table's population columns are solidly repopulated again.
    exposure_staleness_hours: int = 3
    recompute_api_key: str | None = None
    census_api_key: str | None = None
    # Gates frontend-facing admin actions (mark-for-acquisition, confirm &
    # proceed, etc.) - a shared secret prompted once in the browser, not a
    # full login system (single operator, no multi-user need). Separate
    # from recompute_api_key, which is an API-only secret never entered
    # through the UI.
    admin_access_key: str | None = None

    # --- SAR compute dispatch (AWS Batch on Fargate - see DECISIONS.md
    # "SAR compute dispatch") ---
    aws_region: str = "eu-north-1"
    sar_results_bucket: str = "wildfiredashboard-sar-results-497537671259"
    sar_batch_job_queue: str | None = None
    sar_batch_job_definition: str | None = None
    # This backend's own public URL - passed into the Batch container so
    # entrypoint.py can call back into the same public API the frontend
    # uses (fire + acquisition data), rather than needing direct DB access.
    wildfire_api_base_url: str | None = None

    model_config = SettingsConfigDict(env_file=ENV_FILE, env_file_encoding="utf-8", extra="ignore")

    @property
    def cors_allowed_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_allowed_origins.split(",") if origin.strip()]

    @property
    def sqlalchemy_database_url(self) -> str:
        url = self.database_public_url or self.database_url
        if not url:
            raise RuntimeError("DATABASE_URL or DATABASE_PUBLIC_URL must be set")
        return url


@lru_cache
def get_settings() -> Settings:
    return Settings()
