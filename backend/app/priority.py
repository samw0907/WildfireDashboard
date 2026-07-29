"""Priority-fire scoring: identifies which fires are worth flagging for
follow-up SAR acquisition, for emergency-response/insurance audiences.

See DECISIONS.md for the full reasoning behind the weighting and
normalization approach - short version: closer/more-certain exposure
(inside the perimeter) should count for more than distant/possible
exposure (2400m out), and normalizing against the current fire list
(rather than a fixed scale) keeps this a genuine relative ranking tool
and avoids population's naturally larger raw numbers from swamping the
building signal.
"""

from .models import ExposureStat

# Closer bands weighted higher - matches how both insurance (direct loss)
# and emergency response (immediate danger) would naturally weight exposure.
BAND_WEIGHTS = {0: 4, 500: 3, 1000: 2, 2400: 1}


def _weighted_index(exposure: list[ExposureStat], attr: str) -> float:
    total = 0.0
    for e in exposure:
        weight = BAND_WEIGHTS.get(e.buffer_meters)
        value = getattr(e, attr)
        if weight and value is not None:
            total += weight * value
    return total


def compute_priority_scores(exposure_by_fire: dict[str, list[ExposureStat]]) -> dict[str, float]:
    """Returns a 0-100 score per fire_id. Scores are relative to the
    current fire list, not an absolute scale - by design, since the point
    is picking today's top candidates, not tracking a score over time."""
    building_indices = {fid: _weighted_index(exp, "building_count") for fid, exp in exposure_by_fire.items()}
    population_indices = {fid: _weighted_index(exp, "population_est") for fid, exp in exposure_by_fire.items()}

    max_building = max(building_indices.values(), default=0) or 1
    max_population = max(population_indices.values(), default=0) or 1

    return {
        fid: round(
            50 * (building_indices[fid] / max_building) + 50 * (population_indices[fid] / max_population), 1
        )
        for fid in exposure_by_fire
    }
