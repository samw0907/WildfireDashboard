import { StatCard } from '../components/StatCard'

export function Reference() {
  return (
    <div className="reference-page">
      <h1>Reference</h1>
      <p className="page-subtitle">Plain-language methodology and data sources</p>

      <section>
        <h2>What this tool does</h2>
        <p>
          WildfireDashboard tracks currently active US wildfires and estimates the buildings and
          population near each fire's perimeter, at three buffer distances (500m, 1,000m,
          2,400m). This is a portfolio/demo project, not an operational emergency response tool —
          figures are dated and sourced below, and gaps in the underlying open data are stated
          rather than hidden.
        </p>
      </section>

      <section>
        <h2>Data sources</h2>
        <ul>
          <li>
            <strong>Fire perimeters</strong> —{' '}
            <a
              href="https://data-nifc.opendata.arcgis.com/datasets/nifc::wfigs-current-interagency-fire-perimeters"
              target="_blank"
              rel="noreferrer"
            >
              NIFC WFIGS Current Interagency Fire Perimeters
            </a>
            , refreshed roughly every 15 minutes. US-only for Phase 1.
          </li>
          <li>
            <strong>Building footprints</strong> —{' '}
            <a href="https://overpass-api.de/" target="_blank" rel="noreferrer">
              OpenStreetMap via the Overpass API
            </a>
            . OSM building coverage varies by region and isn't complete everywhere.
          </li>
          <li>
            <strong>Population estimates</strong> —{' '}
            <a href="https://www.worldpop.org/" target="_blank" rel="noreferrer">
              WorldPop
            </a>{' '}
            gridded population data (2000–2020 — not a live/current figure).
          </li>
        </ul>
      </section>

      <section>
        <h2>Buffer distances</h2>
        <div className="stat-row">
          <StatCard label="Common ('mode') buffer" value="500" unit="m" />
          <StatCard label="Mid-tier buffer" value="1,000" unit="m" />
          <StatCard label="CA Fire Alliance firebrand distance" value="2,400" unit="m" accent="orange" />
        </div>
        <p>
          These bands come from a review of wildfire community-asset-protection buffer studies
          (500m was the most common value across the studies reviewed) and the California Fire
          Alliance's firebrand-travel-distance standard (2,400m / 1.5 miles). No single global
          standard exists for this distance — it varies by country and methodology.
        </p>
      </section>

      <section>
        <h2>Known limitations</h2>
        <ul>
          <li>Population estimates use WorldPop's most recent available year (2020), not a live figure.</li>
          <li>
            Only OSM building footprints mapped as ways are counted; multipolygon "relation"
            buildings (rare, usually large complexes) aren't yet included.
          </li>
          <li>
            Exposure figures are recomputed only when a fire is new, its perimeter changes
            materially, or on a periodic staleness check — not on every page load.
          </li>
        </ul>
      </section>
    </div>
  )
}
