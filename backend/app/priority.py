"""Priority-fire scoring: identifies which fires are worth flagging for
follow-up SAR acquisition, for emergency-response/insurance audiences.

See DECISIONS.md for the full reasoning - short version, four components:
  - Building exposure (40, log-transformed - reworked 2026-08-02, was 20
    building + 20 population, linear) - what's at risk if the fire reaches
    it. Population dropped as a separate component entirely, not just
    reweighted: population is itself now building-weighted (dasymetric
    redistribution, see exposure.py), so scoring both double-counted the
    same underlying signal rather than adding an independent one.
    Building's own weight doubled to fill that gap, per a direct real-data
    finding: a fire with ~700 buildings within 2.4km (Bench) was scoring
    *below* one with 14 (Little Giant) almost entirely because a single
    outlier fire elsewhere in the list (13,604 buildings) dominated the
    max-normalization denominator and crushed every other fire's raw
    building index toward zero - not because buildings weren't a real
    factor, but because the un-transformed linear index had exactly the
    same right-skew problem acreage's own log-transform below already
    exists to solve. Log-transforming the building index the same way
    fixed it: confirmed on the real Bench/Little Giant pair that this
    flips the ranking the way a human reviewer (more buildings, from an
    emergency-response/insurance point of view, is the bigger concern
    even at a somewhat smaller/more-contained fire) would expect.
  - Scale (40, fire size log-transformed) - how real/active a going
    concern the fire itself is. Added after live testing showed a 6-acre
    fire outranking fires 1000x larger purely because it happened to sit
    in a dense area - a small, likely-more-controllable fire's building
    count is largely an artifact of location, not actual danger.
  - Containment (20) - an uncontained fire is a bigger ongoing concern
    than a mostly-contained one of similar size/exposure, since it's
    still actively threatening damage that hasn't happened yet. Missing
    NIFC data defaults to 0% contained (maximum urgency contribution) -
    deliberately the same "don't understate risk from a data gap" bias
    already used elsewhere in this project, not a neutral guess.
  - Red Flag Warning bonus (+5) - NWS's own designation that current
    wind/humidity/dryness favor rapid spread. Deliberately NOT also
    scoring raw wind speed/rain forecast here - wind direction relative
    to exposure matters more than speed alone (real geometry this doesn't
    have), a forecast is a prediction not a current condition, and fully
    modeling fire weather risk is a genuine research problem (same
    category already ruled out of scope for orbit selection), not
    something a simple additive term can honestly claim.
  Deliberately NOT scoring NIMS incident complexity type (1-5) alongside
  these - it's largely a categorical restatement of fire scale (already
  captured via acreage), and adding it as a second scored input risked
  exactly the same double-counting mistake being corrected in exposure
  above. Still shown as its own badge, just not folded into the score.
Exposure/scale/containment are all normalized/scaled against the current
fire list or a natural 0-100 basis (not a fixed absolute scale), since the
point is picking today's top candidates, not tracking a score over time.
Final score is capped at 100 (the RFW bonus can occasionally push a
fire that's already maxed on every other component past the nominal
0-100 range otherwise).
"""

import math

from .models import ExposureStat, Fire

# Closer bands weighted higher - matches how both insurance (direct loss)
# and emergency response (immediate danger) would naturally weight exposure.
BAND_WEIGHTS = {0: 4, 500: 3, 1000: 2, 2400: 1}
RFW_BONUS = 5.0


def _weighted_index(exposure: list[ExposureStat], attr: str) -> float:
    total = 0.0
    for e in exposure:
        weight = BAND_WEIGHTS.get(e.buffer_meters)
        value = getattr(e, attr)
        if weight and value is not None:
            # population_est is a Postgres Numeric column, which SQLAlchemy
            # returns as decimal.Decimal - float(total) += Decimal raises
            # TypeError. Was dead code until real Census data landed and
            # broke every /api/fires response in production.
            total += weight * float(value)
    return total


def _acreage_index(acres: float | None) -> float:
    # Log-transformed: raw acreage is heavily right-skewed (a handful of
    # huge fires vs. most fires being far smaller), so a linear scale would
    # let one outlier fire dominate the normalization for everyone else.
    if not acres or acres <= 0:
        return 0.0
    return math.log(1 + acres)


def compute_priority_scores(
    fires: list[Fire], exposure_by_fire: dict[str, list[ExposureStat]], fires_in_warning: set[str]
) -> dict[str, float]:
    """Returns a 0-100 score per fire_id: up to 40 points from building
    exposure (log-transformed, population no longer scored separately -
    see module docstring), up to 40 from fire scale, up to 20 from
    containment (inverted - less contained scores higher), plus a flat +5
    if the fire currently sits in an active NWS fire-weather warning zone.
    `fires_in_warning` is the fire_id set already computed by
    nws.fires_in_active_warnings() - not recomputed here, to avoid a
    second pass over the same alert-zone geometry."""
    building_indices_raw = {f.id: _weighted_index(exposure_by_fire.get(f.id, []), "building_count") for f in fires}
    # Log-transformed for the same reason as acreage below: a small number
    # of dense-urban fires can otherwise dominate the max-normalization
    # denominator and crush every other fire's real building signal toward
    # zero (see module docstring for the concrete Bench/Little Giant case
    # that surfaced this).
    building_indices = {fid: math.log(1 + v) for fid, v in building_indices_raw.items()}
    acreage_indices = {f.id: _acreage_index(f.acres) for f in fires}

    max_building = max(building_indices.values(), default=0) or 1
    max_acreage = max(acreage_indices.values(), default=0) or 1

    scores = {}
    for f in fires:
        exposure_component = 40 * (building_indices[f.id] / max_building)
        scale_component = 40 * (acreage_indices[f.id] / max_acreage)
        # Missing percent_contained defaults to 0% (fully uncontained,
        # maximum urgency contribution) - a real NIFC data gap should
        # never quietly downrank a fire that might still be very active.
        containment_pct = f.percent_contained if f.percent_contained is not None else 0
        containment_component = 20 * (1 - containment_pct / 100)
        rfw_bonus = RFW_BONUS if f.id in fires_in_warning else 0.0
        scores[f.id] = round(
            min(100.0, exposure_component + scale_component + containment_component + rfw_bonus), 1
        )
    return scores
