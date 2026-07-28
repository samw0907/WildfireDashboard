"""NIFC ingestion: fetch current fires, upsert into `fires`, prune fires NIFC
itself has stopped tracking as current, and record the outcome so the
frontend's live-status indicator has something to read."""

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from . import nifc
from .db import SessionLocal
from .models import Fire, IngestionStatus

logger = logging.getLogger(__name__)

SMALL_FIRE_ACRES = 10
MID_FIRE_ACRES = 100
SMALL_FIRE_MAX_AGE = timedelta(days=3)
MID_FIRE_MAX_AGE = timedelta(days=8)


def upsert_fires(session: Session, records: list[dict]) -> None:
    if not records:
        return

    stmt = insert(Fire).values(records)
    stmt = stmt.on_conflict_do_update(
        index_elements=[Fire.id],
        set_={
            "name": stmt.excluded.name,
            "source": stmt.excluded.source,
            "perimeter": stmt.excluded.perimeter,
            "acres": stmt.excluded.acres,
            "discovered_date": stmt.excluded.discovered_date,
            "source_updated": stmt.excluded.source_updated,
            "ingested_at": datetime.now(timezone.utc),
        },
    )
    session.execute(stmt)


def prune_stale_fires(session: Session) -> int:
    """Mirror NIFC's own WFIGS fall-off rules so our DB doesn't accumulate
    fires NIFC itself has stopped tracking as current. Fires >100 acres are
    never pruned this way, matching NIFC's own retention. Fires with unknown
    (NULL) acreage are left alone rather than guessed at."""
    now = datetime.now(timezone.utc)

    result = session.execute(
        delete(Fire).where(
            (
                (Fire.acres < SMALL_FIRE_ACRES)
                & (Fire.source_updated < now - SMALL_FIRE_MAX_AGE)
            )
            | (
                (Fire.acres >= SMALL_FIRE_ACRES)
                & (Fire.acres <= MID_FIRE_ACRES)
                & (Fire.source_updated < now - MID_FIRE_MAX_AGE)
            )
        )
    )
    return result.rowcount


def run_ingestion_cycle() -> None:
    session = SessionLocal()
    try:
        records = nifc.fetch_current_fires()
        upsert_fires(session, records)
        pruned = prune_stale_fires(session)
        session.add(IngestionStatus(succeeded=True))
        session.commit()
        logger.info("NIFC ingestion succeeded: %d fires upserted, %d pruned", len(records), pruned)
    except Exception as exc:
        session.rollback()
        logger.exception("NIFC ingestion failed")
        try:
            session.add(IngestionStatus(succeeded=False, error_message=str(exc)[:1000]))
            session.commit()
        except Exception:
            session.rollback()
            logger.exception("Failed to record ingestion failure status")
    finally:
        session.close()
