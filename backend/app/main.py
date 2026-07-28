import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .ingestion import run_ingestion_cycle

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


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_ingestion_loop())
    yield
    task.cancel()


app = FastAPI(title="WildfireDashboard API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allowed_origins_list,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok"}
