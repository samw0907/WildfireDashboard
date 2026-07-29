import { useState } from 'react'
import { exposureAtBand, type Fire } from '../api'

type SortKey =
  | 'name'
  | 'state'
  | 'acres'
  | 'percent_contained'
  | 'fire_cause'
  | 'complexity_level'
  | 'buildings'
  | 'population'
  | 'discovered_date'
  | 'priority_score'
type SortDirection = 'asc' | 'desc'

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'priority_score', label: 'Priority' },
  { key: 'name', label: 'Name' },
  { key: 'state', label: 'State' },
  { key: 'discovered_date', label: 'Discovered' },
  { key: 'acres', label: 'Acres' },
  { key: 'percent_contained', label: 'Contained' },
  { key: 'fire_cause', label: 'Cause' },
  { key: 'complexity_level', label: 'Complexity' },
  { key: 'buildings', label: 'Buildings (2.4km)' },
  { key: 'population', label: 'Population (2.4km)' },
]

function getSortValue(fire: Fire, key: SortKey): string | number {
  switch (key) {
    case 'priority_score':
      return fire.priority_score
    case 'buildings':
      return exposureAtBand(fire.exposure, 2400)?.building_count ?? -1
    case 'population':
      return exposureAtBand(fire.exposure, 2400)?.population_est ?? -1
    case 'acres':
      return fire.acres ?? -1
    case 'percent_contained':
      return fire.percent_contained ?? -1
    case 'discovered_date':
      return fire.discovered_date ? new Date(fire.discovered_date).getTime() : -1
    case 'name':
      return fire.name.toLowerCase()
    case 'state':
      return fire.state ?? ''
    case 'fire_cause':
      return fire.fire_cause ?? ''
    case 'complexity_level':
      return fire.complexity_level ?? ''
  }
}

interface FireTableProps {
  fires: Fire[]
  onSelectFire: (id: string) => void
}

export function FireTable({ fires, onSelectFire }: FireTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('priority_score')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')

  const sorted = [...fires].sort((a, b) => {
    const av = getSortValue(a, sortKey)
    const bv = getSortValue(b, sortKey)
    const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number)
    return sortDirection === 'asc' ? cmp : -cmp
  })

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDirection('desc')
    }
  }

  if (sorted.length === 0) {
    return <p className="page-subtitle">No fires match the current filters.</p>
  }

  return (
    <div className="fire-table-wrap">
      <table className="fire-table">
        <thead>
          <tr>
            {COLUMNS.map(({ key, label }) => (
              <th key={key} onClick={() => handleSort(key)}>
                {label}
                {sortKey === key && <span className="sort-arrow">{sortDirection === 'asc' ? ' ▲' : ' ▼'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((f) => {
            const exp2400 = exposureAtBand(f.exposure, 2400)
            const priorityTier = f.priority_score >= 50 ? 'red' : f.priority_score >= 20 ? 'orange' : 'neutral'
            return (
              <tr key={f.id} onClick={() => onSelectFire(f.id)}>
                <td>
                  <span className={`priority-badge priority-badge--${priorityTier}`}>{f.priority_score}</span>
                </td>
                <td>
                  {f.name}
                  {f.in_active_fire_weather_warning && (
                    <span className="warning-badge" title="Fire perimeter is inside an active NWS Red Flag Warning or Fire Weather Watch zone">
                      ⚠ RFW
                    </span>
                  )}
                </td>
                <td>{f.state ?? '—'}</td>
                <td>{f.discovered_date ? new Date(f.discovered_date).toLocaleDateString() : '—'}</td>
                <td>{f.acres ? Math.round(f.acres).toLocaleString() : '—'}</td>
                <td>{f.percent_contained != null ? `${f.percent_contained}%` : '—'}</td>
                <td>{f.fire_cause ?? '—'}</td>
                <td>{f.complexity_level ?? '—'}</td>
                <td>{exp2400?.building_count ?? '—'}</td>
                <td>{exp2400?.population_est != null ? Math.round(exp2400.population_est).toLocaleString() : 'Pending'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
