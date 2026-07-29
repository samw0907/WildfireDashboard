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
    ingested_at: Mapped[datetime] = mapped_column(
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
