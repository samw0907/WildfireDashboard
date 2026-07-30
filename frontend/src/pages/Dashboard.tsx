import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listFires, exposureAtBand, type Fire } from '../api'
import { StatCard } from '../components/StatCard'
import { ImpactStatCard } from '../components/ImpactStatCard'
import { PageLoading } from '../components/PageLoading'
import { FireMap } from '../components/FireMap'
import { FireFilters, EMPTY_FILTERS, applyFilters, type FiltersState } from '../components/FireFilters'
import { FireTable } from '../components/FireTable'
import { FlameIcon, AreaIcon, BuildingIcon, PeopleIcon } from '../components/icons'

function sumBand(fires: Fire[], band: number, field: 'building_count' | 'population_est'): number {
  return fires.reduce((sum, f) => sum + (exposureAtBand(f.exposure, band)?.[field] ?? 0), 0)
}

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
  if (!fires) return <PageLoading label="Loading fires…" />

  const totalAcres = fires.reduce((sum, f) => sum + (f.acres ?? 0), 0)
  const buildingsImpacted = sumBand(fires, 0, 'building_count')
  const buildingsUnderThreat = sumBand(fires, 2400, 'building_count')
  const populationImpacted = sumBand(fires, 0, 'population_est')
  const populationUnderThreat = sumBand(fires, 2400, 'population_est')
  const firesWithPopulation = fires.filter((f) => exposureAtBand(f.exposure, 2400)?.population_est != null).length

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
        <ImpactStatCard
          label="Buildings"
          icon={BuildingIcon}
          accent="red"
          impacted={buildingsImpacted.toLocaleString()}
          underThreat={buildingsUnderThreat.toLocaleString()}
        />
        <ImpactStatCard
          label="Population"
          icon={PeopleIcon}
          accent="red"
          impacted={Math.round(populationImpacted).toLocaleString()}
          underThreat={Math.round(populationUnderThreat).toLocaleString()}
        />
      </div>
      {firesWithPopulation < fires.length && (
        <p className="exposure-note">
          Population totals still filling in ({firesWithPopulation} of {fires.length} fires processed).
        </p>
      )}

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
