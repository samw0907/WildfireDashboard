import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listFires, type Fire } from '../api'
import { StatCard } from '../components/StatCard'
import { FireMap } from '../components/FireMap'
import { FireFilters, EMPTY_FILTERS, applyFilters, type FiltersState } from '../components/FireFilters'
import { FireTable } from '../components/FireTable'
import { FlameIcon, AreaIcon } from '../components/icons'

export function Dashboard() {
  const [fires, setFires] = useState<Fire[] | null>(null)
  const [error, setError] = useState(false)
  const [filters, setFilters] = useState<FiltersState>(EMPTY_FILTERS)
  const navigate = useNavigate()

  useEffect(() => {
    listFires()
      .then(setFires)
      .catch(() => setError(true))
  }, [])

  const filteredFires = useMemo(() => (fires ? applyFilters(fires, filters) : []), [fires, filters])

  if (error) {
    return (
      <div className="page-error">
        Could not load fire data. The backend may be temporarily unavailable — try again shortly.
      </div>
    )
  }
  if (!fires) return <div className="page-loading">Loading fires…</div>

  const totalAcres = fires.reduce((sum, f) => sum + (f.acres ?? 0), 0)

  return (
    <div className="dashboard">
      <h1>Dashboard</h1>
      <p className="page-subtitle">Current US wildfire perimeters, sourced from NIFC WFIGS</p>

      <div className="stat-row">
        <StatCard label="Active fires tracked" value={fires.length} icon={FlameIcon} />
        <StatCard
          label="Total acres"
          value={Math.round(totalAcres).toLocaleString()}
          accent="orange"
          icon={AreaIcon}
        />
      </div>

      <div className="dashboard-map-full">
        <FireMap fires={fires} onSelectFire={(id) => navigate(`/fires/${id}`)} enableAlerts />
      </div>

      <FireFilters fires={fires} filters={filters} onChange={setFilters} />
      <p className="filter-result-count">
        Showing {filteredFires.length} of {fires.length} fires
      </p>
      <FireTable fires={filteredFires} onSelectFire={(id) => navigate(`/fires/${id}`)} />
    </div>
  )
}
