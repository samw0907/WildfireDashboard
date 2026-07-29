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

export interface Acquisition {
  status: 'marked' | 'confirmed' | null
  before_scene: Scene | null
  after_scene: Scene | null
  confirmed_at: string | null
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

export function selectAcquisitionScenes(id: string, before: Scene, after: Scene): Promise<unknown> {
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
