from datetime import datetime

from pydantic import BaseModel


class ExposureStatOut(BaseModel):
    buffer_meters: int
    building_count: int | None
    population_est: float | None
    computed_at: datetime

    model_config = {"from_attributes": True}


class FireOut(BaseModel):
    id: str
    name: str
    source: str
    perimeter: dict
    acres: float | None
    discovered_date: datetime | None
    source_updated: datetime
    exposure: list[ExposureStatOut]


class FireDetailOut(FireOut):
    buildings: dict | None
