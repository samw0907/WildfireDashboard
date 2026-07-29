import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listFires, exposureAtBand, type Fire } from '../api'
import { StatCard } from '../components/StatCard'
import { FireMap } from '../components/FireMap'
import { FlameIcon, AreaIcon } from '../components/icons'

export function Dashboard() {
  const [fires, setFires] = useState<Fire[] | null>(null)
  const [error, setError] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    listFires()
      .then(setFires)
      .catch(() => setError(true))
  }, [])

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

      <div className="dashboard-split">
        <div className="dashboard-map">
          <FireMap fires={fires} onSelectFire={(id) => navigate(`/fires/${id}`)} />
        </div>
        <div className="fire-list">
          {fires.slice(0, 25).map((f) => {
            const exp2400 = exposureAtBand(f.exposure, 2400)
            return (
              <button key={f.id} className="fire-list-item" onClick={() => navigate(`/fires/${f.id}`)}>
                <div className="fire-list-name">{f.name}</div>
                <div className="fire-list-meta">
                  {f.acres ? `${Math.round(f.acres).toLocaleString()} ac` : 'Acreage unknown'}
                  {f.percent_contained != null && ` · ${f.percent_contained}% contained`}
                  {exp2400?.building_count != null && ` · ${exp2400.building_count} buildings within 2.4km`}
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
