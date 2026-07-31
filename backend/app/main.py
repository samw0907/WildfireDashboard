import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .exposure import run_exposure_cycle
from .ingestion import run_ingestion_cycle
from .nws import refresh_alerts_cache
from .routers.acquisition import router as acquisition_router
from .routers.alerts import router as alerts_router
from .routers.fires import router as fires_router
from .routers.status import router as status_router
from .sar_batch import run_sar_batch_poll_cycle

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

settings = get_settings()


async def _ingestion_loop() -> None:
    interval_seconds = settings.nifc_ingestion_interval_minutes * 60
    while True:
        try:
            await asyncio.to_thread(run_ingestion_cycle)
        except Exception:
            # run_ingestion_cycle already records its own failure to
            # ingestion_status - this catch just stops one bad cycle from
            # killing the whole background loop.
            logger.exception("Unexpected error in ingestion loop")
        await asyncio.sleep(interval_seconds)


async def _exposure_loop() -> None:
    # Same polling cadence as ingestion - cheap when there's nothing to do,
    # since fires_needing_recompute() only does real (Overpass) work for
    # fires that are new, changed, or past the staleness fallback.
    interval_seconds = settings.nifc_ingestion_interval_minutes * 60
    while True:
        try:
            await asyncio.to_thread(run_exposure_cycle)
        except Exception:
            logger.exception("Unexpected error in exposure loop")
        await asyncio.sleep(interval_seconds)


async def _alerts_loop() -> None:
    # NWS fire-weather alerts change on their own schedule (issued/expired
    # over hours, not minutes) - same polling cadence as ingestion is
    # plenty fresh and keeps this simple, not because it needs to match.
    interval_seconds = settings.nifc_ingestion_interval_minutes * 60
    while True:
        try:
            await asyncio.to_thread(refresh_alerts_cache)
        except Exception:
            logger.exception("Unexpected error in NWS alerts loop")
        await asyncio.sleep(interval_seconds)


async def _sar_batch_poll_loop() -> None:
    # Fixed 2-minute cadence, not tied to the ingestion interval setting -
    # Batch jobs run for hours, so this only needs to be "responsive
    # enough for a human watching the UI", and the query is a no-op cost
    # (single indexed SELECT) whenever nothing is in flight.
    interval_seconds = 120
    while True:
        try:
            await asyncio.to_thread(run_sar_batch_poll_cycle)
        except Exception:
            logger.exception("Unexpected error in SAR batch poll loop")
        await asyncio.sleep(interval_seconds)


@asynccontextmanager
async def lifespan(app: FastAPI):
    ingestion_task = asyncio.create_task(_ingestion_loop())
    exposure_task = asyncio.create_task(_exposure_loop())
    alerts_task = asyncio.create_task(_alerts_loop())
    sar_batch_task = asyncio.create_task(_sar_batch_poll_loop())
    yield
    ingestion_task.cancel()
    exposure_task.cancel()
    alerts_task.cancel()
    sar_batch_task.cancel()


app = FastAPI(title="WildfireDashboard API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allowed_origins_list,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(fires_router)
app.include_router(status_router)
app.include_router(alerts_router)
app.include_router(acquisition_router)


@app.api_route("/health", methods=["GET", "HEAD"])
def health():
    return {"status": "ok"}
