// Shared tooltip copy for InfoHint usages, centralized so the wording
// doesn't drift between the table, fire detail page, and dashboard.

export const PRIORITY_SCORE_HELP =
  'A 0-100 relative ranking for today\'s fire list: up to 40 points from building exposure (closer bands count more, log-transformed so one dense outlier fire doesn\'t drown out the rest), up to 40 from fire scale (log-transformed acreage), up to 20 from containment (less contained scores higher), plus +5 if the fire is in an active Red Flag Warning zone. Normalized against the current fire list, not a fixed scale - see Reference for the full formula.'

export const POPULATION_HELP =
  'Estimated via Census block-group areal apportionment, not a precise measurement - less accurate for small fires in sparse rural areas. See Reference for methodology.'

export const COMPLEXITY_HELP =
  'NIMS incident complexity typing - counterintuitively, Type 1 is the largest/most complex (national resources, can run for months) and Type 5 is the smallest (5 or fewer people needed). See Reference for the full scale.'
