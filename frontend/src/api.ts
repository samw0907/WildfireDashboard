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

export interface AcquisitionCandidates {
  before: Scene[]
  after: Scene[]
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
  building_damage_counts: Record<string, number>
  total_buildings_classified: number
  threshold_db: number
  threshold_validated: boolean
  threshold_note: string
  building_dataset: string
  building_dataset_note: string
}

export interface Acquisition {
  status: 'marked' | 'confirmed' | 'processing' | 'complete' | 'failed' | null
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

export function getAcquisition(id: string): Promise<Acquisition> {
  return get<Acquisition>(`/api/fires/${id}/acquisition`)
}

export function getAcquisitionCandidates(id: string): Promise<AcquisitionCandidates> {
  return get<AcquisitionCandidates>(`/api/fires/${id}/acquisition/candidates`)
}

export function markForAcquisition(id: string): Promise<unknown> {
  return authenticatedRequest(`/api/fires/${id}/acquisition/mark`, { method: 'POST' })
}

export function selectAcquisitionScenes(id: string, before: Scene[], after: Scene[]): Promise<unknown> {
  return authenticatedRequest(`/api/fires/${id}/acquisition/select`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ before, after }),
  })
}

export function confirmAcquisition(id: string): Promise<unknown> {
  return authenticatedRequest(`/api/fires/${id}/acquisition/confirm`, { method: 'POST' })
}

export function unmarkAcquisition(id: string): Promise<unknown> {
  return authenticatedRequest(`/api/fires/${id}/acquisition/unmark`, { method: 'POST' })
}

export function exposureAtBand(exposure: ExposureStat[], bufferMeters: number): ExposureStat | undefined {
  return exposure.find((e) => e.buffer_meters === bufferMeters)
}
