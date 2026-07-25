import { useEffect, useRef, useState } from 'react'
import { MapLibreMap } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import './App.css'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL

type BackendStatus = 'checking' | 'ok' | 'error'

function useBackendHealth(): BackendStatus {
  const [status, setStatus] = useState<BackendStatus>('checking')

  useEffect(() => {
    let cancelled = false

    fetch(`${API_BASE_URL}/health`)
      .then((res) => {
        if (!cancelled) setStatus(res.ok ? 'ok' : 'error')
      })
      .catch(() => {
        if (!cancelled) setStatus('error')
      })

    return () => {
      cancelled = true
    }
  }, [])

  return status
}

function Map() {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current) return

    // Placeholder demo style - swap for a real basemap once one is chosen
    const map = new MapLibreMap({
      container: containerRef.current,
      style: 'https://demotiles.maplibre.org/style.json',
      center: [-98.5, 39.8], // continental US, matches Phase 1 scope
      zoom: 3,
    })

    return () => map.remove()
  }, [])

  return <div ref={containerRef} className="map" />
}

function StatusBadge({ status }: { status: BackendStatus }) {
  const label =
    status === 'checking' ? 'Checking backend...' : status === 'ok' ? 'Backend: healthy' : 'Backend: unreachable'

  return <div className={`status-badge status-badge--${status}`}>{label}</div>
}

function App() {
  const backendStatus = useBackendHealth()

  return (
    <div className="app">
      <StatusBadge status={backendStatus} />
      <Map />
    </div>
  )
}

export default App
