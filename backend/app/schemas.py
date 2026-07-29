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
    percent_contained: int | None
    fire_cause: str | None
    complexity_level: str | None
    state: str | None
    priority_score: float
    in_active_fire_weather_warning: bool
    exposure: list[ExposureStatOut]


class FireDetailOut(FireOut):
    buildings: dict | None
    # Buffer ring polygons (500m/1000m/2400m), keyed by band as a string
    # since JSON object keys must be strings. Computed on-the-fly from the
    # perimeter, not stored - cheap (milliseconds) and always consistent
    # with the perimeter, so no reason to persist it.
    buffers: dict[str, dict]
