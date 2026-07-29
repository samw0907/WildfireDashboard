from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import SessionLocal
from ..models import IngestionStatus

router = APIRouter(prefix="/api")

# How long after the last successful ingestion before each state kicks in.
# "Live" window is generous relative to the ingestion cadence itself so a
# single slow cycle doesn't flip the badge; "reconnecting" gives NIFC/network
# blips time to resolve before declaring a real outage.
FRESH_MULTIPLIER = 2
RECONNECTING_GRACE = timedelta(hours=1)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class StatusOut(BaseModel):
    status: str  # "live" | "reconnecting" | "disconnected"
    last_successful_at: datetime | None


@router.get("/status", response_model=StatusOut)
def get_status(db: Session = Depends(get_db)):
    last_success = db.scalars(
        select(IngestionStatus)
        .where(IngestionStatus.succeeded.is_(True))
        .order_by(IngestionStatus.attempted_at.desc())
        .limit(1)
    ).first()

    if last_success is None:
        return StatusOut(status="disconnected", last_successful_at=None)

    now = datetime.now(timezone.utc)
    age = now - last_success.attempted_at
    fresh_window = timedelta(minutes=get_settings().nifc_ingestion_interval_minutes * FRESH_MULTIPLIER)

    if age <= fresh_window:
        status = "live"
    elif age <= RECONNECTING_GRACE:
        status = "reconnecting"
    else:
        status = "disconnected"

    return StatusOut(status=status, last_successful_at=last_success.attempted_at)
