import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getFire, type FireDetail as FireDetailData } from '../api'
import { StatCard } from '../components/StatCard'
import { FireMap } from '../components/FireMap'
import { BuildingIcon, PeopleIcon } from '../components/icons'

const BANDS = [500, 1000, 2400]

export function FireDetail() {
  const { id } = useParams<{ id: string }>()
  const [fire, setFire] = useState<FireDetailData | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!id) return
    setFire(null)
    setError(false)
    getFire(id)
      .then(setFire)
      .catch(() => setError(true))
  }, [id])

  if (error) {
    return <div className="page-error">Fire not found, or the backend is temporarily unavailable.</div>
  }
  if (!fire) return <div className="page-loading">Loading…</div>

  return (
    <div className="fire-detail">
      <Link to="/" className="back-link">
        ← Back to dashboard
      </Link>
      <h1>{fire.name}</h1>
      <p className="page-subtitle">
        {fire.acres ? `${Math.round(fire.acres).toLocaleString()} acres` : 'Acreage unknown'} · Source:{' '}
        {fire.source} · Last updated {new Date(fire.source_updated).toLocaleString()}
      </p>

      <div className="fire-detail-split">
        <div className="fire-detail-map">
          <FireMap fires={[fire]} selectedFireId={fire.id} fitToSelection />
        </div>
        <div className="exposure-panel">
          <h2>Exposure</h2>
          {fire.exposure.length === 0 && (
            <p className="page-subtitle">Exposure data pending — this fire hasn't been processed yet.</p>
          )}
          {BANDS.map((band) => {
            const stat = fire.exposure.find((e) => e.buffer_meters === band)
            if (!stat) return null
            return (
              <div key={band} className="exposure-band">
                <h3>{band}m buffer</h3>
                <div className="stat-row">
                  <StatCard label="Buildings" value={stat.building_count ?? '—'} icon={BuildingIcon} />
                  <StatCard
                    label="Population est."
                    value={
                      stat.population_est != null ? Math.round(stat.population_est).toLocaleString() : 'Pending'
                    }
                    accent="orange"
                    icon={PeopleIcon}
                  />
                </div>
                <p className="computed-at">Computed {new Date(stat.computed_at).toLocaleString()}</p>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
