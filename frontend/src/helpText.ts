// Shared tooltip copy for InfoHint usages, centralized so the wording
// doesn't drift between the table, fire detail page, and dashboard.

export const PRIORITY_SCORE_HELP =
  'A 0-100 relative ranking for today\'s fire list: up to 40 points from building exposure (closer bands count more, log-transformed so one dense outlier fire doesn\'t drown out the rest), up to 40 from fire scale (log-transformed acreage), up to 20 from containment (less contained scores higher), plus +5 if the fire is in an active Red Flag Warning zone. Normalized against the current fire list, not a fixed scale - see Reference for the full formula.'

export const POPULATION_HELP =
  "Census block-group population, divided across each group's mapped OpenStreetMap buildings then counted within the buffer - not a precise measurement, and less accurate for small fires in sparse rural areas. Falls back to simple area-based apportionment for a block group with no mapped buildings. See Reference for methodology."

export const COMPLEXITY_HELP =
  'NIMS incident complexity typing - counterintuitively, Type 1 is the largest/most complex (national resources, can run for months) and Type 5 is the smallest (5 or fewer people needed). See Reference for the full scale.'

export const BUILDINGS_HELP =
  'OpenStreetMap building footprints within 2.4km of the fire perimeter - real counts, but OSM mapping completeness varies by region, especially in rural areas.'

export const SOURCE_HELP =
  "NIFC's WFIGS (Wildland Fire Interagency Geospatial Services) - the US wildland fire community's own official incident feed, polled roughly every 15 minutes. \"Last updated\" reflects NIFC's own record timestamp, not necessarily the moment we last polled it."

export const FORECAST_HELP = "National Weather Service forecast for this fire's location - not fire-behavior specific, just the local weather outlook."

export const EXPOSURE_BANDS_HELP =
  "Four bands from the fire's own edge outward (0/500/1000/2400m) - closer bands matter more for both emergency response (immediate danger) and insurance (direct loss), which is also how they're weighted in the priority score. See Reference for the full building/population methodology."

export const DAMAGE_DESTROYED_HELP =
  "Mean SAR backscatter change over this building's footprint is at or above the threshold - the strongest damage signal this method reports. See Reference for how the threshold itself is chosen."

export const DAMAGE_POSSIBLY_AFFECTED_HELP =
  'Mean SAR backscatter change is elevated but below the full "destroyed" threshold - a real but weaker signal, worth checking, not a confirmed loss.'

export const DAMAGE_NO_DAMAGE_HELP =
  "Mean SAR backscatter change over this building's footprint is below both thresholds - no detected change, not a guarantee of zero impact."

export const DAMAGE_THRESHOLD_SENSITIVE_HELP =
  "This building's classification flips depending on which of the two thresholds (fixed vs. this fire's own adaptive value) is used - shown under the adaptive result above, but flagged as less certain than a building both thresholds agree on. See Reference for the full dual-threshold approach."
