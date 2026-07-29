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
  exposure: ExposureStat[]
}

export interface FireDetail extends Fire {
  buildings: GeoJSON.FeatureCollection | null
}

export interface IngestionStatus {
  status: 'live' | 'reconnecting' | 'disconnected'
  last_successful_at: string | null
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`)
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

export function exposureAtBand(exposure: ExposureStat[], bufferMeters: number): ExposureStat | undefined {
  return exposure.find((e) => e.buffer_meters === bufferMeters)
}
