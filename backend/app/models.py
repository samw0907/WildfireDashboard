from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint
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


class Acquisition(Base):
    """One row per SAR acquisition attempt on a fire (see DECISIONS.md,
    SAR_METHODOLOGY.md) - a real history, not mutable per-fire state,
    since a fire can be re-acquired multiple times as it evolves (a later
    after-scene, a redo with better coverage, etc). `sequence` numbers
    each fire's own attempts starting at 1, in creation order - that's
    what tabs/labels in the UI key off, not `id`. A draft (`status ==
    'marked'`) that's abandoned without being confirmed is deleted
    outright rather than kept around empty, so row existence always means
    "a real attempt was made," matching the frontend's auto-unmark
    behavior.

    Scene lists, not single scenes: exactly 3 each for Composite mode
    (median compositing), or exactly 1 each for Single-pair fallback mode
    when a track can't support 3 - see SAR_METHODOLOGY.md §8 for why
    there's no "2" tier in between.
    """

    __tablename__ = "acquisitions"
    __table_args__ = (UniqueConstraint("fire_id", "sequence", name="uq_acquisitions_fire_sequence"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    fire_id: Mapped[str] = mapped_column(ForeignKey("fires.id", ondelete="CASCADE"), nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    # 'marked' | 'processing' | 'complete' | 'failed' - never None: a row's
    # existence already means at least "marked". The polling loop in
    # main.py/sar_batch.py moves 'processing' to 'complete'/'failed' once
    # batch.describe_jobs() reports a terminal status.
    status: Mapped[str] = mapped_column(String, nullable=False)
    # none_as_null=True is required here: SQLAlchemy's JSON/JSONB type
    # otherwise stores a Python None as the literal JSON `null` (a real,
    # non-SQL-NULL value) rather than SQL NULL - confirmed live this broke
    # jsonb_build_array() in an earlier migration, which doesn't skip a
    # column holding JSON null the way it skips true SQL NULL.
    before_scenes: Mapped[list | None] = mapped_column(JSONB(none_as_null=True))
    after_scenes: Mapped[list | None] = mapped_column(JSONB(none_as_null=True))
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # AWS Batch job ID for this acquisition's compute run - the polling
    # loop's only handle back onto the job it's watching.
    batch_job_id: Mapped[str | None] = mapped_column(String)
    # result_summary.json's contents, copied in once the polling loop sees
    # SUCCEEDED - see sar-compute/entrypoint.py for exactly what's in it
    # (includes the threshold/building-dataset honesty notes, not just
    # numbers, so the UI can render them directly from here).
    result: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    # burn_perimeter.geojson / building_damage.geojson contents, copied in
    # alongside `result` - kept as separate columns (not nested inside
    # `result`) since they're map-overlay geometry, not summary numbers.
    # Both already reprojected to EPSG:4326 by the pipeline before upload -
    # no S3 proxying or presigned URLs needed. burn_perimeter is None when
    # no burn area was detected at all (a real, valid outcome).
    burn_perimeter: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    building_damage: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    # Populated on FAILED from the Batch job's own statusReason - shown to
    # the operator rather than a generic "something went wrong".
    error: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


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
