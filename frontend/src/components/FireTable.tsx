import { useEffect, useState } from 'react'
import { exposureAtBand, type Fire } from '../api'
import { AcquisitionBadge } from './AcquisitionBadge'
import { InfoHint } from './InfoHint'
import { RfwBadge } from './RfwBadge'
import { PRIORITY_SCORE_HELP, POPULATION_HELP } from '../helpText'

type SortKey =
  | 'name'
  | 'state'
  | 'acres'
  | 'percent_contained'
  | 'buildings'
  | 'population'
  | 'discovered_date'
  | 'priority_score'
type SortDirection = 'asc' | 'desc'

const PAGE_SIZE = 100

const COLUMNS: { key: SortKey; label: string; hint?: string }[] = [
  { key: 'priority_score', label: 'Priority', hint: PRIORITY_SCORE_HELP },
  { key: 'name', label: 'Name' },
  { key: 'state', label: 'State' },
  { key: 'discovered_date', label: 'Discovered' },
  { key: 'acres', label: 'Acres' },
  { key: 'percent_contained', label: 'Contained' },
  { key: 'buildings', label: 'Buildings (2.4km)' },
  { key: 'population', label: 'Population (2.4km)', hint: POPULATION_HELP },
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
  }
}

interface FireTableProps {
  fires: Fire[]
  onSelectFire: (id: string) => void
}

export function FireTable({ fires, onSelectFire }: FireTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('priority_score')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  // Reset to the first page whenever the underlying (filtered) fire set
  // changes, so "load more" state from a previous filter doesn't carry
  // over and confuse what's actually being shown.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
  }, [fires])

  const sorted = [...fires].sort((a, b) => {
    const av = getSortValue(a, sortKey)
    const bv = getSortValue(b, sortKey)
    const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number)
    return sortDirection === 'asc' ? cmp : -cmp
  })
  const visible = sorted.slice(0, visibleCount)

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
    <div>
      <div className="fire-table-wrap">
        <table className="fire-table">
          <thead>
            <tr>
              {COLUMNS.map(({ key, label, hint }) => (
                <th key={key} onClick={() => handleSort(key)}>
                  {label}
                  {hint && <InfoHint text={hint} />}
                  {sortKey === key && <span className="sort-arrow">{sortDirection === 'asc' ? ' ▲' : ' ▼'}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((f) => {
              const exp2400 = exposureAtBand(f.exposure, 2400)
              const priorityTier = f.priority_score >= 50 ? 'red' : f.priority_score >= 20 ? 'orange' : 'neutral'
              return (
                <tr key={f.id} onClick={() => onSelectFire(f.id)}>
                  <td>
                    <span className={`priority-badge priority-badge--${priorityTier}`}>{f.priority_score}</span>
                  </td>
                  <td>
                    {f.name}
                    {f.in_active_fire_weather_warning && <RfwBadge compact />}
                    {f.has_acquisition && <AcquisitionBadge compact />}
                  </td>
                  <td>{f.state ?? '—'}</td>
                  <td>{f.discovered_date ? new Date(f.discovered_date).toLocaleDateString() : '—'}</td>
                  <td>{f.acres ? Math.round(f.acres).toLocaleString() : '—'}</td>
                  <td>{f.percent_contained != null ? `${f.percent_contained}%` : '—'}</td>
                  <td>{exp2400?.building_count ?? '—'}</td>
                  <td>{exp2400?.population_est != null ? Math.round(exp2400.population_est).toLocaleString() : 'Pending'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {visibleCount < sorted.length && (
        <div className="table-load-more">
          <button onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}>
            Load {Math.min(PAGE_SIZE, sorted.length - visibleCount)} more ({visibleCount} of {sorted.length} shown)
          </button>
        </div>
      )}
    </div>
  )
}
