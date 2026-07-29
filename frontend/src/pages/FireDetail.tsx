import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getFire, type FireDetail as FireDetailData } from '../api'
import { StatCard } from '../components/StatCard'
import { FireMap } from '../components/FireMap'
import { BuildingIcon, PeopleIcon } from '../components/icons'

// Matches the ring colors drawn on the map (see FireMap.tsx) - 0m (the
// perimeter itself) shares "red" with the 500m band since both represent
// the most immediate exposure zone.
const BAND_CONFIG: { band: number; label: string; accent: 'red' | 'orange' | 'yellow' }[] = [
  { band: 0, label: 'Within fire perimeter', accent: 'red' },
  { band: 500, label: '500m buffer', accent: 'red' },
  { band: 1000, label: '1,000m buffer', accent: 'orange' },
  { band: 2400, label: '2,400m buffer', accent: 'yellow' },
]

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

      <div className="incident-badges">
        {fire.percent_contained != null && <span className="badge">{fire.percent_contained}% contained</span>}
        {fire.fire_cause && <span className="badge">Cause: {fire.fire_cause}</span>}
        {fire.complexity_level && <span className="badge">{fire.complexity_level}</span>}
        {fire.discovered_date && (
          <span className="badge">
            {Math.max(0, Math.floor((Date.now() - new Date(fire.discovered_date).getTime()) / 86_400_000))} days
            since discovery
          </span>
        )}
      </div>

      <div className="fire-detail-split">
        <div className="fire-detail-map">
          <FireMap fires={[fire]} selectedFireId={fire.id} fitToSelection buffers={fire.buffers} />
        </div>
        <div className="exposure-panel">
          <h2>Exposure</h2>
          {fire.exposure.length === 0 && (
            <p className="page-subtitle">Exposure data pending — this fire hasn't been processed yet.</p>
          )}
          {BAND_CONFIG.map(({ band, label, accent }) => {
            const stat = fire.exposure.find((e) => e.buffer_meters === band)
            if (!stat) return null
            return (
              <div key={band} className="exposure-band">
                <h3>
                  <span className={`band-dot band-dot--${accent}`} />
                  {label}
                </h3>
                <div className="stat-row">
                  <StatCard label="Buildings" value={stat.building_count ?? '—'} accent={accent} icon={BuildingIcon} />
                  <StatCard
                    label="Population est."
                    value={
                      stat.population_est != null ? Math.round(stat.population_est).toLocaleString() : 'Pending'
                    }
                    accent={accent}
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
