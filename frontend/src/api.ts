import { clearStoredAdminKey, getOrPromptAdminKey } from './adminKey'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL

export interface ExposureStat {
  buffer_meters: number
  building_count: number | null
  population_est: number | null
  computed_at: string
}

export interface Fire {
  id: string
  name: string
  source: string
  perimeter: GeoJSON.Geometry
  acres: number | null
  discovered_date: string | null
  source_updated: string
  percent_contained: number | null
  fire_cause: string | null
  complexity_level: string | null
  state: string | null
  priority_score: number
  in_active_fire_weather_warning: boolean
  // True if this fire has ever had at least one SAR acquisition requested
  // (any status - marked, processing, complete, or failed), so the fires
  // table can flag "already worked on this one" at a glance.
  has_acquisition: boolean
  exposure: ExposureStat[]
}

export interface FireDetail extends Fire {
  buildings: GeoJSON.FeatureCollection | null
  // Buffer ring polygons keyed by band ("500" | "1000" | "2400"), computed
  // server-side from the perimeter - excludes "0" (the perimeter itself,
  // already available as `perimeter` above).
  buffers: Record<string, GeoJSON.Geometry>
}

export interface IngestionStatus {
  status: 'live' | 'reconnecting' | 'disconnected'
  last_successful_at: string | null
}

export interface FireAlertProperties {
  event: string
  headline: string | null
  areaDesc: string | null
  effective: string | null
  expires: string | null
}

export interface WindInfo {
  speed_mph: number | null
  direction_degrees: number | null
  direction_text: string | null
}

export interface ForecastPeriod {
  name: string
  start_time: string
  is_daytime: boolean
  temperature: number | null
  temperature_unit: string | null
  short_forecast: string | null
  wind_speed: string | null
  wind_direction: string | null
  probability_of_precipitation: number | null
}

export interface FireWeather {
  wind: WindInfo
  periods: ForecastPeriod[]
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`)
  if (!res.ok) {
    throw new Error(`${path} failed: ${res.status}`)
  }
  return res.json()
}

/** For admin-gated endpoints (mark-for-acquisition, confirm & proceed,
 * etc.) - prompts for the admin key if none is stored yet, and clears it
 * on a 403 so the next attempt re-prompts rather than looping on a stale
 * or wrong key. */
export async function authenticatedRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const key = await getOrPromptAdminKey()
  if (!key) {
    throw new Error('Admin key required')
  }

  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: { ...options.headers, 'x-admin-key': key },
  })

  if (res.status === 403) {
    clearStoredAdminKey()
    throw new Error('Admin key rejected')
  }
  if (!res.ok) {
    throw new Error(`${path} failed: ${res.status}`)
  }
  return res.json()
}

export function listFires(): Promise<Fire[]> {
  return get<Fire[]>('/api/fires')
}

export function getFire(id: string): Promise<FireDetail> {
  return get<FireDetail>(`/api/fires/${id}`)
}

export function getIngestionStatus(): Promise<IngestionStatus> {
  return get<IngestionStatus>('/api/status')
}

export function getFireAlerts(): Promise<GeoJSON.FeatureCollection> {
  return get<GeoJSON.FeatureCollection>('/api/alerts')
}

export function getFireWeather(id: string): Promise<FireWeather> {
  return get<FireWeather>(`/api/fires/${id}/weather`)
}

export interface Scene {
  id: string
  name: string
  date: string
  orbit_direction: string | null
  relative_orbit: number | null
  polarisation: string | null
  aoi_coverage_percent: number | null
  footprint: GeoJSON.Geometry | null
}

export interface ScenePriorUse {
  sequence: number
  side: 'before' | 'after'
  status: 'marked' | 'processing' | 'complete' | 'failed'
}

// A scene as offered by the candidates endpoint - same as Scene, plus
// which of this fire's own prior acquisitions (if any) already used it,
// so the picker can flag "already used in Acquisition #1 (before)"
// without silently pre-selecting or hiding anything.
export interface CandidateScene extends Scene {
  previously_used: ScenePriorUse[]
}

export interface AcquisitionCandidates {
  before: CandidateScene[]
  after: CandidateScene[]
}

// Compact result_summary.json contents - see sar-compute/entrypoint.py for
// exactly what's produced. Honesty fields (threshold/building-dataset
// notes) are carried through as plain strings so the UI renders them
// verbatim rather than re-deriving its own wording.
export interface AcquisitionResultSummary {
  fire_id: string
  mode: 'composite' | 'single_pair'
  before_scenes: string[]
  after_scenes: string[]
  target_crs: number
  total_burn_area_ha: number
  burn_patch_count: number
  // PRIMARY result - this fire's own adaptive threshold when one was
  // found, else the fixed reference value below (see primary_threshold_db).
  building_damage_counts: Record<string, number>
  total_buildings_classified: number
  // Fixed value borrowed from two specific California fires - always
  // computed as a stable, cross-fire-comparable reference and the
  // fallback primary result when a fire has no clean adaptive split.
  threshold_db: number
  threshold_note: string
  building_dataset: string
  building_dataset_note: string
  // Whichever threshold actually produced building_damage_counts above -
  // adaptive_threshold_db if not null, else threshold_db.
  primary_threshold_db?: number | null
  // This fire's own Otsu-derived threshold, computed from its own change-
  // image statistics. Null (not just absent) on results from before this
  // feature existed, or if there was no valid clipped data to derive one
  // from - in which case building_damage_counts falls back to the fixed
  // breakdown below.
  adaptive_threshold_db?: number | null
  // Always-computed fixed-threshold breakdown - the secondary/reference
  // result, not the headline one (renamed from building_damage_counts_
  // adaptive when adaptive became primary).
  building_damage_counts_fixed?: Record<string, number>
  // How many buildings' primary classification agrees ("corroborated")
  // vs. disagrees ("uncertain") vs. wasn't a real comparison at all
  // ("n/a" - no_data/unconfirmed/geometry_limited on either side, or no
  // adaptive threshold to compare against) with the fixed reference one.
  confidence_counts?: Record<string, number>
  // Buildings rescued by a single all_touched retry after the standard
  // centroid-based sample found no pixel at all (small footprint vs.
  // ~20m resolution) - somewhat less precise than buildings that sampled
  // cleanly, but a real reading rather than no answer at all.
  fallback_sampled_count?: number
  // {label: filename} for every file actually produced - fetch via
  // acquisitionDownloadUrl(fireId, filename), not directly (the results
  // bucket is private, this is a label->filename map, not a URL map).
  // Optional: absent (not just empty) on results persisted before this
  // manifest field existed in entrypoint.py - callers must fall back to {}.
  files?: Record<string, string>
}

// Figures worth rendering inline on the Fire Detail page, in display
// order - anything else in `files` (raw GeoTIFFs/GeoJSON, the summary
// itself) is download-only, not inlined. Matches the labels
// sar-compute/pipeline/figures.py actually produces.
export const INLINE_FIGURE_LABELS: { key: string; title: string }[] = [
  { key: 'damage_zoom_map', title: 'Building Damage (highest-concentration area)' },
  { key: 'backscatter_panel', title: 'Backscatter Comparison (full scene)' },
  { key: 'perimeter_change_map', title: 'Change Magnitude (fire perimeter)' },
]

export function acquisitionDownloadUrl(fireId: string, sequence: number, filename: string): string {
  return `${API_BASE_URL}/api/fires/${fireId}/acquisitions/${sequence}/download/${encodeURIComponent(filename)}`
}

export function acquisitionDownloadAllUrl(fireId: string, sequence: number): string {
  return `${API_BASE_URL}/api/fires/${fireId}/acquisitions/${sequence}/download-all`
}

export interface Acquisition {
  // Numbers this fire's own acquisition attempts starting at 1, in
  // creation order - what tabs are labeled/keyed by.
  sequence: number
  created_at: string
  status: 'marked' | 'processing' | 'complete' | 'failed'
  before_scenes: Scene[]
  after_scenes: Scene[]
  // 'composite' (3+3, real median-compositing benefit) | 'single_pair'
  // (1+1, fallback when a track can't support 3) | null if nothing
  // selected yet - deliberately no in-between size, see SAR_METHODOLOGY.md §8.
  mode: 'composite' | 'single_pair' | null
  confirmed_at: string | null
  batch_job_id: string | null
  result: AcquisitionResultSummary | null
  // Already reprojected to EPSG:4326 by the pipeline - render directly
  // alongside the fire's own perimeter/buildings layers. burn_perimeter is
  // null both before completion AND when no burn area was detected at all
  // (a real, valid outcome) - only `status` distinguishes those two cases.
  burn_perimeter: GeoJSON.FeatureCollection | null
  building_damage: GeoJSON.FeatureCollection | null
  error: string | null
}

// All of a fire's acquisition attempts, oldest first - empty if none has
// ever been started. Drives the tab strip in AcquisitionPanel.
export function listAcquisitions(fireId: string): Promise<Acquisition[]> {
  return get<Acquisition[]>(`/api/fires/${fireId}/acquisitions`)
}

export function getAcquisition(fireId: string, sequence: number): Promise<Acquisition> {
  return get<Acquisition>(`/api/fires/${fireId}/acquisitions/${sequence}`)
}

// Fire-wide (not sequence-scoped) - the same candidate window regardless
// of which acquisition attempt is being worked on, annotated with which
// scenes any of this fire's prior acquisitions already used.
export function getAcquisitionCandidates(fireId: string): Promise<AcquisitionCandidates> {
  return get<AcquisitionCandidates>(`/api/fires/${fireId}/acquisition/candidates`)
}

// Starts a new draft acquisition (sequence = previous max + 1). Rejected
// by the backend if this fire already has a non-terminal ('marked' or
// 'processing') acquisition in flight - resolve or unmark that one first.
export function createAcquisition(fireId: string): Promise<Acquisition> {
  return authenticatedRequest(`/api/fires/${fireId}/acquisitions`, { method: 'POST' })
}

export function selectAcquisitionScenes(
  fireId: string,
  sequence: number,
  before: Scene[],
  after: Scene[],
): Promise<unknown> {
  return authenticatedRequest(`/api/fires/${fireId}/acquisitions/${sequence}/select`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ before, after }),
  })
}

export function confirmAcquisition(fireId: string, sequence: number): Promise<unknown> {
  return authenticatedRequest(`/api/fires/${fireId}/acquisitions/${sequence}/confirm`, { method: 'POST' })
}

// Only valid pre-confirmation - deletes the draft outright rather than
// resetting it, matching the backend's "row existence means a real
// attempt was made" rule. Confirmed/processing/complete/failed
// acquisitions can't be unmarked this way; they're real history.
export function unmarkAcquisition(fireId: string, sequence: number): Promise<unknown> {
  return authenticatedRequest(`/api/fires/${fireId}/acquisitions/${sequence}/unmark`, { method: 'POST' })
}

// Permanently deletes an acquisition's DB row and its stored S3 results -
// unlike unmark (drafts only), this works for any terminal status
// ('marked', 'complete', 'failed'), for deliberately discarding an
// outdated or superseded run. Rejected by the backend while 'processing'.
// No undo - callers should confirm with the user before calling this.
export function deleteAcquisition(fireId: string, sequence: number): Promise<unknown> {
  return authenticatedRequest(`/api/fires/${fireId}/acquisitions/${sequence}`, { method: 'DELETE' })
}

export function exposureAtBand(exposure: ExposureStat[], bufferMeters: number): ExposureStat | undefined {
  return exposure.find((e) => e.buffer_meters === bufferMeters)
}
