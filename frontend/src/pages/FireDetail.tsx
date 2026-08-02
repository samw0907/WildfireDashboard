import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getFire, getFireWeather, type FireDetail as FireDetailData, type FireWeather, type Scene } from '../api'
import { FireMap } from '../components/FireMap'
import { AcquisitionPanel } from '../components/AcquisitionPanel'
import { PageLoading } from '../components/PageLoading'
import { InfoHint } from '../components/InfoHint'
import { RfwBadge } from '../components/RfwBadge'
import { COMPLEXITY_HELP } from '../helpText'
import {
  BuildingIcon,
  PeopleIcon,
  SunIcon,
  CloudIcon,
  RainIcon,
  ThunderstormIcon,
  SnowIcon,
  SmokeIcon,
  WindIcon,
} from '../components/icons'

// Ordered most-specific-first: a forecast like "Smoke then Sunny" should
// read as smoke (the condition someone assessing a wildfire cares about),
// not sunny, even though "sunny" also matches.
function forecastIcon(shortForecast: string) {
  const text = shortForecast.toLowerCase()
  if (text.includes('thunder')) return ThunderstormIcon
  if (text.includes('snow') || text.includes('sleet') || text.includes('ice')) return SnowIcon
  if (text.includes('rain') || text.includes('shower') || text.includes('drizzle')) return RainIcon
  if (text.includes('smoke') || text.includes('haze') || text.includes('fog')) return SmokeIcon
  if (text.includes('wind') || text.includes('breezy')) return WindIcon
  if (text.includes('cloud') || text.includes('overcast')) return CloudIcon
  if (text.includes('sunny') || text.includes('clear')) return SunIcon
  return CloudIcon
}

// Icons themselves stay currentColor (SunIcon is reused as-is for the
// unrelated light/dark theme toggle in Layout.tsx, so color can't be
// baked into the icon component itself) - applied here instead via a
// wrapping element's `color`, just for the forecast column's own context.
function forecastIconColor(shortForecast: string): string {
  const text = shortForecast.toLowerCase()
  if (text.includes('thunder')) return '#a855f7'
  if (text.includes('snow') || text.includes('sleet') || text.includes('ice')) return '#7dd3fc'
  if (text.includes('rain') || text.includes('shower') || text.includes('drizzle')) return '#38bdf8'
  if (text.includes('smoke') || text.includes('haze') || text.includes('fog')) return '#9ca3af'
  if (text.includes('wind') || text.includes('breezy')) return '#2dd4bf'
  if (text.includes('cloud') || text.includes('overcast')) return '#94a3b8'
  if (text.includes('sunny') || text.includes('clear')) return '#fbbf24'
  return '#94a3b8'
}

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
  const [weather, setWeather] = useState<FireWeather | null>(null)
  const [acquisitionScenes, setAcquisitionScenes] = useState<{ before: Scene[]; after: Scene[] }>({
    before: [],
    after: [],
  })
  const [acquisitionResults, setAcquisitionResults] = useState<{
    burnPerimeter: GeoJSON.FeatureCollection | null
    buildingDamage: GeoJSON.FeatureCollection | null
  }>({ burnPerimeter: null, buildingDamage: null })
  const [acquisitionConfirmed, setAcquisitionConfirmed] = useState(false)

  useEffect(() => {
    if (!id) return
    setFire(null)
    setError(false)
    getFire(id)
      .then(setFire)
      .catch(() => setError(true))
  }, [id])

  useEffect(() => {
    if (!id) return
    setWeather(null)
    // Weather is a nice-to-have, not core exposure data - fail silently
    // (no error state) and just omit the wind/forecast UI if it's down.
    getFireWeather(id)
      .then(setWeather)
      .catch(() => setWeather(null))
  }, [id])

  if (error) {
    return <div className="page-error">Fire not found, or the backend is temporarily unavailable.</div>
  }
  if (!fire) return <PageLoading label="Loading fire details… this can take up to 10-15s." />

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
        {fire.in_active_fire_weather_warning && <RfwBadge />}
        {fire.percent_contained != null && <span className="badge">{fire.percent_contained}% contained</span>}
        {fire.fire_cause && <span className="badge">Cause: {fire.fire_cause}</span>}
        {fire.complexity_level && (
          <span className="badge">
            {fire.complexity_level}
            <InfoHint text={COMPLEXITY_HELP} />
          </span>
        )}
        {fire.discovered_date && (
          <span className="badge">
            {Math.max(0, Math.floor((Date.now() - new Date(fire.discovered_date).getTime()) / 86_400_000))} days
            since discovery
          </span>
        )}
      </div>

      <div className="fire-detail-split">
        <div className="fire-detail-map">
          <FireMap
            fires={[fire]}
            selectedFireId={fire.id}
            fitToSelection
            buffers={fire.buffers}
            sceneFootprints={{
              before: acquisitionScenes.before.map((s) => s.footprint).filter((f): f is GeoJSON.Geometry => f != null),
              after: acquisitionScenes.after.map((s) => s.footprint).filter((f): f is GeoJSON.Geometry => f != null),
            }}
            sarResults={acquisitionResults}
            scenesConfirmed={acquisitionConfirmed}
            buildings={fire.buildings}
            enableAlerts
            alertsDefaultVisible={false}
          />
          {weather?.wind.direction_degrees != null && (
            <div
              className="wind-indicator"
              title={`Wind from ${weather.wind.direction_text} at ${weather.wind.speed_mph} mph. Arrow points in the direction the wind is blowing toward - the likely fire-spread direction.`}
            >
              <svg
                className="wind-indicator-arrow"
                viewBox="0 0 24 24"
                style={{ transform: `rotate(${(weather.wind.direction_degrees + 180) % 360}deg)` }}
              >
                <path
                  d="M12 2 L12 22 M12 2 L6 9 M12 2 L18 9"
                  stroke="currentColor"
                  strokeWidth="2"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>{weather.wind.speed_mph} mph</span>
            </div>
          )}
          {(acquisitionScenes.before.length > 0 || acquisitionScenes.after.length > 0) && (
            <div className="scene-legend">
              {acquisitionScenes.before.length > 0 && (
                <span>
                  <span className="scene-legend-swatch scene-legend-swatch--before" /> Before scene(s)
                </span>
              )}
              {acquisitionScenes.after.length > 0 && (
                <span>
                  <span className="scene-legend-swatch scene-legend-swatch--after" /> After scene(s)
                </span>
              )}
            </div>
          )}
          {(acquisitionResults.burnPerimeter || acquisitionResults.buildingDamage) && (
            <div className="scene-legend">
              {acquisitionResults.burnPerimeter && (
                <span>
                  <span className="scene-legend-swatch scene-legend-swatch--burn" /> SAR-detected burn area
                </span>
              )}
              {acquisitionResults.buildingDamage && (
                <>
                  <span>
                    <span className="damage-dot damage-dot--destroyed" /> Destroyed
                  </span>
                  <span>
                    <span className="damage-dot damage-dot--possibly_affected" /> Possibly affected
                  </span>
                  <span>
                    <span className="damage-dot damage-dot--no_damage" /> No damage
                  </span>
                  <span>
                    <span className="damage-dot damage-dot--unconfirmed" /> Unconfirmed signal
                  </span>
                </>
              )}
            </div>
          )}
        </div>
        {weather && weather.periods.length > 0 && (
          <div className="forecast-column">
            <h3>Forecast</h3>
            <div className="forecast-list">
              {/* Capped at 6 (~3 days) rather than every period NWS returns
                  (up to 14) - this is secondary context, not the primary
                  thing on this page, so a compact single-line-per-period
                  layout that reliably fits without a scrollbar matters more
                  here than showing the full 7-day outlook. */}
              {weather.periods.slice(0, 6).map((p) => {
                const Icon = forecastIcon(p.short_forecast ?? '')
                const iconColor = forecastIconColor(p.short_forecast ?? '')
                return (
                  <div key={p.start_time} className="forecast-row" title={p.short_forecast ?? undefined}>
                    <span className="forecast-row-icon" style={{ color: iconColor }}>
                      <Icon />
                    </span>
                    <span className="forecast-row-name">{p.name}</span>
                    {p.temperature != null && (
                      <span className="forecast-row-temp">
                        {p.temperature}&deg;{p.temperature_unit}
                      </span>
                    )}
                    <span className="forecast-row-details">
                      {p.wind_speed && `${p.wind_direction} ${p.wind_speed}`}
                      {!!p.probability_of_precipitation && ` · ${p.probability_of_precipitation}% rain`}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      <div className="exposure-panel">
        <h2>Exposure</h2>
        <p className="exposure-note">
          Population figures are estimates, not precise counts - less accurate for small fires
          in sparse areas. See <Link to="/reference#population-methodology">methodology</Link>.
        </p>
        {fire.exposure.length === 0 && (
          <p className="page-subtitle">Exposure data pending — this fire hasn't been processed yet.</p>
        )}
        <div className="exposure-bands-row">
          {BAND_CONFIG.map(({ band, label, accent }) => {
            const stat = fire.exposure.find((e) => e.buffer_meters === band)
            if (!stat) return null
            return (
              <div key={band} className="exposure-band-card">
                <h3>
                  <span className={`band-dot band-dot--${accent}`} />
                  {label}
                </h3>
                <div className="exposure-band-stats">
                  <div className="exposure-band-stat">
                    <div className={`stat-icon stat-icon--${accent}`}>
                      <BuildingIcon />
                    </div>
                    <div>
                      <div className={`stat-value stat-value--${accent}`}>{stat.building_count ?? '—'}</div>
                      <div className="stat-label">Buildings</div>
                    </div>
                  </div>
                  <div className="exposure-band-stat">
                    <div className={`stat-icon stat-icon--${accent}`}>
                      <PeopleIcon />
                    </div>
                    <div>
                      <div className={`stat-value stat-value--${accent}`}>
                        {stat.population_est != null ? Math.round(stat.population_est).toLocaleString() : 'Pending'}
                      </div>
                      <div className="stat-label">Population est.</div>
                    </div>
                  </div>
                </div>
                <p className="computed-at">Computed {new Date(stat.computed_at).toLocaleString()}</p>
              </div>
            )
          })}
        </div>
      </div>

      <AcquisitionPanel
        fireId={fire.id}
        fireAcres={fire.acres}
        onScenesChange={setAcquisitionScenes}
        onResultsChange={setAcquisitionResults}
        onConfirmedChange={setAcquisitionConfirmed}
      />
    </div>
  )
}
