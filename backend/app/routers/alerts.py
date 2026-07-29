from fastapi import APIRouter

from .. import nws

router = APIRouter(prefix="/api")


@router.get("/alerts")
def get_alerts():
    return nws.get_cached_alerts()
