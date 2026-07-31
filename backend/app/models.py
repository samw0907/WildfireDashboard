from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from .db import Base


class Fire(Base):
    """One row per tracked fire, sourced from NIFC WFIGS."""

    __tablename__ = "fires"

    id: Mapped[str] = mapped_column(String, primary_key=True)  # NIFC IRWIN ID or equivalent
    name: Mapped[str] = mapped_column(String, nullable=False)
    source: Mapped[str] = mapped_column(String, nullable=False)  # e.g. 'nifc_wfigs_current'
    perimeter: Mapped[dict] = mapped_column(JSONB, nullable=False)  # GeoJSON geometry
    acres: Mapped[float | None] = mapped_column(Numeric)
    discovered_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    source_updated: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    percent_contained: Mapped[int | None] = mapped_column(Integer)
    fire_cause: Mapped[str | None] = mapped_column(String)
    complexity_level: Mapped[str | None] = mapped_column(String)
    state: Mapped[str | None] = mapped_column(String)  # e.g. "NE" - point of origin state
    ingested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    # Human-in-the-loop SAR acquisition workflow (see DECISIONS.md,
    # SAR_METHODOLOGY.md) - mutable per-fire state, not a history, since
    # only one acquisition request is ever in flight for a given fire at a
    # time. Scene lists, not single scenes: exactly 3 each for Composite
    # mode (median compositing), or exactly 1 each for Single-pair
    # fallback mode when a track can't support 3 - see
    # SAR_METHODOLOGY.md §8 for why there's no "2" tier in between.
    # None | 'marked' | 'confirmed' | 'processing' | 'complete' | 'failed' -
    # 'confirmed' is transient (submit_job is called synchronously right
    # after, in the same request) and should only ever be seen mid-request;
    # the polling loop in main.py moves 'processing' to 'complete'/'failed'
    # once batch.describe_jobs() reports a terminal status.
    acquisition_status: Mapped[str | None] = mapped_column(String)
    # none_as_null=True is required here: SQLAlchemy's JSON/JSONB type
    # otherwise stores a Python None as the literal JSON `null` (a real,
    # non-SQL-NULL value) rather than SQL NULL - confirmed live this broke
    # jsonb_build_array() in a later migration, which doesn't skip a
    # column holding JSON null the way it skips true SQL NULL.
    acquisition_before_scenes: Mapped[list | None] = mapped_column(JSONB(none_as_null=True))
    acquisition_after_scenes: Mapped[list | None] = mapped_column(JSONB(none_as_null=True))
    acquisition_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # AWS Batch job ID for the in-flight/most-recent compute run - the
    # polling loop's only handle back onto the job it's watching.
    acquisition_batch_job_id: Mapped[str | None] = mapped_column(String)
    # result_summary.json's contents, copied in once the polling loop sees
    # SUCCEEDED - see sar-compute/entrypoint.py for exactly what's in it
    # (includes the threshold/building-dataset honesty notes, not just
    # numbers, so Phase E's UI can render them directly from here).
    acquisition_result: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    # burn_perimeter.geojson / building_damage.geojson contents, copied in
    # alongside acquisition_result - kept as separate columns (not nested
    # inside acquisition_result) since they're map-overlay geometry, not
    # summary numbers, mirroring how `perimeter`/`buildings` are already
    # separate top-level columns on this same model. Both already
    # reprojected to EPSG:4326 by the pipeline before upload, matching
    # every other geometry column here - no S3 proxying or presigned URLs
    # needed, the same pattern as acquisition_result. burn_perimeter is
    # None when no burn area was detected at all (a real, valid outcome).
    acquisition_burn_perimeter: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    acquisition_building_damage: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    # Populated on FAILED from the Batch job's own statusReason - shown to
    # the operator rather than a generic "something went wrong".
    acquisition_error: Mapped[str | None] = mapped_column(String)


class BuildingCache(Base):
    """Raw building geometries fetched once per fire at the largest buffer
    band (2400m), so 500m/1000m/2400m exposure counts can all be derived
    locally without repeat Overpass calls."""

    __tablename__ = "building_cache"

    fire_id: Mapped[str] = mapped_column(ForeignKey("fires.id", ondelete="CASCADE"), primary_key=True)
    buildings: Mapped[dict] = mapped_column(JSONB, nullable=False)  # GeoJSON FeatureCollection
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class ExposureStat(Base):
    """Computed exposure per fire, per buffer band. New rows are inserted on
    each recompute rather than updated in place, so this is a history, not
    just a latest-value table - callers should query the max(computed_at)
    row per (fire_id, buffer_meters)."""

    __tablename__ = "exposure_stats"

    fire_id: Mapped[str] = mapped_column(ForeignKey("fires.id", ondelete="CASCADE"), primary_key=True)
    buffer_meters: Mapped[int] = mapped_column(Integer, primary_key=True)  # 500, 1000, or 2400
    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), primary_key=True, server_default=func.now()
    )
    building_count: Mapped[int | None] = mapped_column(Integer)
    population_est: Mapped[float | None] = mapped_column(Numeric)


class IngestionStatus(Base):
    """One row per NIFC ingestion attempt, used to derive the frontend's
    Live / Reconnecting / No-connection status indicator."""

    __tablename__ = "ingestion_status"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    attempted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    succeeded: Mapped[bool] = mapped_column(Boolean, nullable=False)
    error_message: Mapped[str | None] = mapped_column(Text)
