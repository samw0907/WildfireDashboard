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


class WindOut(BaseModel):
    speed_mph: float | None
    direction_degrees: float | None
    direction_text: str | None


class ForecastPeriodOut(BaseModel):
    name: str
    start_time: datetime
    is_daytime: bool
    temperature: int | None
    temperature_unit: str | None
    short_forecast: str | None
    wind_speed: str | None
    wind_direction: str | None
    probability_of_precipitation: int | None


class FireWeatherOut(BaseModel):
    wind: WindOut
    periods: list[ForecastPeriodOut]


class SceneOut(BaseModel):
    id: str
    name: str
    date: datetime
    orbit_direction: str | None
    relative_orbit: int | None
    polarisation: str | None
    # % of the fire's own perimeter actually covered by this scene's real
    # imaged footprint (not just bbox intersection) - IW mode's burst
    # structure means a scene can graze an AOI's bbox while a gap runs
    # through the AOI itself. None if the footprint couldn't be checked.
    aoi_coverage_percent: int | None
    # GeoJSON footprint of the actual imaged area, passed through so the
    # frontend can draw it as a map outline for visual context.
    footprint: dict | None


class SceneIn(BaseModel):
    id: str
    name: str
    date: datetime
    orbit_direction: str | None = None
    relative_orbit: int | None = None
    polarisation: str | None = None
    aoi_coverage_percent: int | None = None
    footprint: dict | None = None


class AcquisitionCandidatesOut(BaseModel):
    before: list[SceneOut]
    after: list[SceneOut]


class AcquisitionSelectIn(BaseModel):
    # Exactly 3 each for Composite mode (median compositing - needs >=3 for
    # real outlier-robustness), or exactly 1 each for Single-pair fallback
    # when a track can't support 3. Deliberately no "2" tier - median of 2
    # is mathematically identical to a mean, so it would look more
    # rigorous than a single pair while providing the same zero
    # outlier-robustness. See SAR_METHODOLOGY.md §8.
    before: list[SceneIn]
    after: list[SceneIn]


class AcquisitionOut(BaseModel):
    status: str | None
    before_scenes: list[SceneOut]
    after_scenes: list[SceneOut]
    # 'composite' (3+3) | 'single_pair' (1+1) | None if nothing selected yet -
    # derived from list length so the frontend doesn't need to reimplement
    # that logic itself.
    mode: str | None
    confirmed_at: datetime | None
    batch_job_id: str | None
    # result_summary.json's contents once status is 'complete' - see
    # sar-compute/entrypoint.py for its exact shape.
    result: dict | None
    # burn_perimeter.geojson / building_damage.geojson contents, already
    # reprojected to EPSG:4326 by the pipeline - ready to render directly
    # as map overlays alongside the fire's perimeter/buildings. burn_perimeter
    # is None both before completion AND when no burn area was detected at
    # all (a real, valid outcome) - the frontend can't distinguish those
    # two cases from this field alone, only from `status`.
    burn_perimeter: dict | None
    building_damage: dict | None
    error: str | None
