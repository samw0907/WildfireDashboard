// Shared tooltip copy for InfoHint usages, centralized so the wording
// doesn't drift between the table, fire detail page, and dashboard.

export const PRIORITY_SCORE_HELP =
  'A 0-100 relative ranking for today\'s fire list: up to 40 points from building exposure (closer bands count more, log-transformed so one dense outlier fire doesn\'t drown out the rest), up to 40 from fire scale (log-transformed acreage), up to 20 from containment (less contained scores higher), plus +5 if the fire is in an active Red Flag Warning zone. Normalized against the current fire list, not a fixed scale - see Reference for the full formula.'

export const POPULATION_HELP =
  'Census population, weighted by mapped buildings within the buffer - an estimate, less accurate for small fires in sparse rural areas. See Reference for methodology.'

export const COMPLEXITY_HELP =
  'NIMS incident complexity typing - counterintuitively, Type 1 is the largest/most complex (national resources, can run for months) and Type 5 is the smallest (5 or fewer people needed). See Reference for the full scale.'

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
