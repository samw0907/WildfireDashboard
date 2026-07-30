import { useState } from 'react'
import { exposureAtBand, type Fire } from '../api'

// Population filters use the 2400m band - the widest/most complete
// estimate, same band already used elsewhere (table, popups) as the
// headline exposure figure.
const POPULATION_BAND = 2400

export interface FiltersState {
  search: string
  state: string
  minContained: string
  maxContained: string
  minAcres: string
  maxAcres: string
  minPopulation: string
  maxPopulation: string
}

export const EMPTY_FILTERS: FiltersState = {
  search: '',
  state: '',
  minContained: '',
  maxContained: '',
  minAcres: '',
  maxAcres: '',
  minPopulation: '',
  maxPopulation: '',
}

export function applyFilters(fires: Fire[], f: FiltersState): Fire[] {
  return fires.filter((fire) => {
    if (f.search && !fire.name.toLowerCase().includes(f.search.toLowerCase())) return false
    if (f.state && fire.state !== f.state) return false
    if (f.minContained !== '' && (fire.percent_contained ?? -1) < Number(f.minContained)) return false
    if (f.maxContained !== '' && (fire.percent_contained ?? Infinity) > Number(f.maxContained)) return false
    if (f.minAcres !== '' && (fire.acres ?? -1) < Number(f.minAcres)) return false
    if (f.maxAcres !== '' && (fire.acres ?? Infinity) > Number(f.maxAcres)) return false
    if (f.minPopulation !== '' || f.maxPopulation !== '') {
      const population = exposureAtBand(fire.exposure, POPULATION_BAND)?.population_est
      if (f.minPopulation !== '' && (population ?? -1) < Number(f.minPopulation)) return false
      if (f.maxPopulation !== '' && (population ?? Infinity) > Number(f.maxPopulation)) return false
    }
    return true
  })
}

const MORE_FILTER_KEYS: (keyof FiltersState)[] = [
  'minContained',
  'maxContained',
  'minAcres',
  'maxAcres',
  'minPopulation',
  'maxPopulation',
]

interface FireFiltersProps {
  fires: Fire[]
  filters: FiltersState
  onChange: (filters: FiltersState) => void
}

function uniqueSorted(values: (string | null)[]): string[] {
  return Array.from(new Set(values.filter((v): v is string => !!v))).sort()
}

export function FireFilters({ fires, filters, onChange }: FireFiltersProps) {
  const [expanded, setExpanded] = useState(false)

  const states = uniqueSorted(fires.map((f) => f.state))

  const update = (patch: Partial<FiltersState>) => onChange({ ...filters, ...patch })
  const moreActiveCount = MORE_FILTER_KEYS.filter((k) => filters[k] !== '').length
  const anyActive = Object.values(filters).some((v) => v !== '')

  return (
    <div className="filter-bar-wrap">
      <div className="filter-bar">
        <input
          className="filter-search"
          type="text"
          placeholder="Search fires by name…"
          value={filters.search}
          onChange={(e) => update({ search: e.target.value })}
        />
        <select value={filters.state} onChange={(e) => update({ state: e.target.value })}>
          <option value="">All states</option>
          {states.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button className="filter-more-toggle" onClick={() => setExpanded((e) => !e)}>
          More filters{moreActiveCount > 0 ? ` (${moreActiveCount})` : ''}
        </button>
        {anyActive && (
          <button className="filter-clear" onClick={() => onChange(EMPTY_FILTERS)}>
            Clear all
          </button>
        )}
      </div>
      {expanded && (
        <div className="filter-more-panel">
          <div className="filter-range">
            <span>Contained %</span>
            <input
              type="number"
              placeholder="Min"
              value={filters.minContained}
              onChange={(e) => update({ minContained: e.target.value })}
            />
            <input
              type="number"
              placeholder="Max"
              value={filters.maxContained}
              onChange={(e) => update({ maxContained: e.target.value })}
            />
          </div>
          <div className="filter-range">
            <span>Acres</span>
            <input
              type="number"
              placeholder="Min"
              value={filters.minAcres}
              onChange={(e) => update({ minAcres: e.target.value })}
            />
            <input
              type="number"
              placeholder="Max"
              value={filters.maxAcres}
              onChange={(e) => update({ maxAcres: e.target.value })}
            />
          </div>
          <div className="filter-range">
            <span>Population (2.4km)</span>
            <input
              type="number"
              placeholder="Min"
              value={filters.minPopulation}
              onChange={(e) => update({ minPopulation: e.target.value })}
            />
            <input
              type="number"
              placeholder="Max"
              value={filters.maxPopulation}
              onChange={(e) => update({ maxPopulation: e.target.value })}
            />
          </div>
        </div>
      )}
    </div>
  )
}
