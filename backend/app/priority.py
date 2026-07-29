"""Priority-fire scoring: identifies which fires are worth flagging for
follow-up SAR acquisition, for emergency-response/insurance audiences.

See DECISIONS.md for the full reasoning - short version: the score has two
equally-weighted pillars, not one:
  - Exposure (buildings + population) - what's at risk if the fire reaches
    it. Closer bands count for more than distant ones.
  - Scale (fire size, log-transformed) - how real/active a going concern
    the fire itself is. Added after live testing showed a 6-acre fire
    outranking fires 1000x larger purely because it happened to sit in a
    dense area - a small, likely-more-controllable fire's building count
    is largely an artifact of location, not actual danger, so exposure
    alone isn't sufficient; fire size needs to temper it.
Both normalized against the current fire list (not a fixed scale), since
the point is picking today's top candidates, not tracking a score over
time.
"""

import math

from .models import ExposureStat, Fire

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


def _acreage_index(acres: float | None) -> float:
    # Log-transformed: raw acreage is heavily right-skewed (a handful of
    # huge fires vs. most fires being far smaller), so a linear scale would
    # let one outlier fire dominate the normalization for everyone else.
    if not acres or acres <= 0:
        return 0.0
    return math.log(1 + acres)


def compute_priority_scores(fires: list[Fire], exposure_by_fire: dict[str, list[ExposureStat]]) -> dict[str, float]:
    """Returns a 0-100 score per fire_id: up to 50 points from exposure
    (25 building + 25 population), up to 50 points from fire scale."""
    building_indices = {f.id: _weighted_index(exposure_by_fire.get(f.id, []), "building_count") for f in fires}
    population_indices = {
        f.id: _weighted_index(exposure_by_fire.get(f.id, []), "population_est") for f in fires
    }
    acreage_indices = {f.id: _acreage_index(f.acres) for f in fires}

    max_building = max(building_indices.values(), default=0) or 1
    max_population = max(population_indices.values(), default=0) or 1
    max_acreage = max(acreage_indices.values(), default=0) or 1

    scores = {}
    for f in fires:
        exposure_component = 25 * (building_indices[f.id] / max_building) + 25 * (
            population_indices[f.id] / max_population
        )
        scale_component = 50 * (acreage_indices[f.id] / max_acreage)
        scores[f.id] = round(exposure_component + scale_component, 1)
    return scores
