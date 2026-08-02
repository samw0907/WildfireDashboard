// Shared tooltip copy for InfoHint usages, centralized so the wording
// doesn't drift between the table, fire detail page, and dashboard.

export const PRIORITY_SCORE_HELP =
  "A weighted score combining building exposure, fire scale, containment, and fire-weather warnings - relative to today's fires, not an absolute rating. See Reference for the formula."

export const POPULATION_HELP =
  'Census population, weighted by mapped buildings within the buffer - shown for reference only, not used in the priority score, since building counts are considered the more reliable signal. See Reference for methodology.'

export const COMPLEXITY_HELP =
  'NIMS incident complexity typing - Type 1 is the largest/most complex, Type 5 the smallest (counterintuitively numbered). See Reference for the full scale.'

export const BUILDINGS_HELP =
  'OpenStreetMap building footprints within 2.4km of the fire perimeter - real counts, but OSM mapping completeness varies by region, especially in rural areas.'

export const SOURCE_HELP =
  "NIFC's WFIGS - the official US wildland fire incident feed, polled roughly every 15 minutes. Timestamp is NIFC's own, not our last poll."

export const FORECAST_HELP = "National Weather Service forecast for this fire's location - not fire-behavior specific, just the local outlook."

export const EXPOSURE_BANDS_HELP =
  "Four bands outward from the fire's own edge (0/500/1000/2400m) - closer bands matter more for both emergency response and insurance risk."

export const DAMAGE_DESTROYED_HELP =
  'SAR backscatter change over this building is at or above the damage threshold - the strongest signal this method reports.'

export const DAMAGE_POSSIBLY_AFFECTED_HELP =
  'SAR backscatter change is elevated but below the "destroyed" threshold - a real but weaker signal, not a confirmed loss.'

export const DAMAGE_NO_DAMAGE_HELP =
  'SAR backscatter change is below both thresholds - no detected change, not a guarantee of zero impact.'

export const DAMAGE_THRESHOLD_SENSITIVE_HELP =
  'Classification flips depending on which threshold (fixed vs. adaptive) is used - less certain than a building both agree on.'
