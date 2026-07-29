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
  const key = getOrPromptAdminKey()
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

export function exposureAtBand(exposure: ExposureStat[], bufferMeters: number): ExposureStat | undefined {
  return exposure.find((e) => e.buffer_meters === bufferMeters)
}
