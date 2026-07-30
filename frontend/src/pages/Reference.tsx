import { StatCard } from '../components/StatCard'
import { AreaIcon } from '../components/icons'

export function Reference() {
  return (
    <div className="reference-page">
      <h1>Reference</h1>
      <p className="page-subtitle">Plain-language methodology and data sources</p>

      <section>
        <h2>What this tool does</h2>
        <p>
          WildfireDashboard tracks currently active US wildfires, estimates the buildings and
          population near each fire's perimeter, and surfaces a priority score to help identify
          which fires are worth a closer look. From there, it supports a human-in-the-loop
          workflow for marking a fire for follow-up Sentinel-1 SAR (satellite radar) imagery
          analysis - browsing real candidate before/after scenes and recording a decision, though
          the actual SAR processing step isn't built yet (see below). This is a portfolio/demo
          project, not an operational emergency response tool - figures are sourced and dated
          below, and gaps or accuracy limits in the underlying open data are stated rather than
          hidden.
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
            , refreshed roughly every 15 minutes. US-only.
          </li>
          <li>
            <strong>Building footprints</strong> —{' '}
            <a href="https://overpass-api.de/" target="_blank" rel="noreferrer">
              OpenStreetMap via the Overpass API
            </a>
            . OSM building coverage varies by region and isn't complete everywhere.
          </li>
          <li>
            <strong>Population estimates</strong> — US Census Bureau (
            <a href="https://tigerweb.geo.census.gov/" target="_blank" rel="noreferrer">
              TIGERweb
            </a>{' '}
            block group boundaries +{' '}
            <a href="https://www.census.gov/data/developers/data-sets/acs-5year.html" target="_blank" rel="noreferrer">
              ACS 5-Year
            </a>{' '}
            population). See{' '}
            <a href="#population-methodology">how this is calculated</a> below - the method has a
            real accuracy tradeoff worth understanding, especially for small fires.
          </li>
          <li>
            <strong>Fire-weather alerts</strong> —{' '}
            <a href="https://www.weather.gov/documentation/services-web-api" target="_blank" rel="noreferrer">
              NWS Red Flag Warnings / Fire Weather Watches
            </a>
            , free and no API key. Coverage is regional and day-dependent - it reflects current
            wind/humidity/dryness conditions, not fire counts or size, so a quiet day can show
            almost nothing nationally.
          </li>
          <li>
            <strong>Wind &amp; 5-day forecast</strong> —{' '}
            <a href="https://www.weather.gov/documentation/services-web-api" target="_blank" rel="noreferrer">
              NWS point forecast API
            </a>
            , resolved from each fire's own perimeter centroid.
          </li>
          <li>
            <strong>SAR scene candidates</strong> —{' '}
            <a href="https://dataspace.copernicus.eu/" target="_blank" rel="noreferrer">
              Copernicus Data Space Ecosystem (CDSE)
            </a>{' '}
            Sentinel-1 catalogue, searched live. See{' '}
            <a href="#sar-methodology">the acquisition workflow</a> below for what "mark for
            acquisition" actually does today.
          </li>
        </ul>
      </section>

      <section>
        <h2>Buffer distances</h2>
        <div className="stat-row">
          <StatCard label="Within perimeter" value="0" unit="m" accent="red" icon={AreaIcon} />
          <StatCard label="Common ('mode') buffer" value="500" unit="m" icon={AreaIcon} />
          <StatCard label="Mid-tier buffer" value="1,000" unit="m" icon={AreaIcon} />
          <StatCard
            label="CA Fire Alliance firebrand distance"
            value="2,400"
            unit="m"
            accent="orange"
            icon={AreaIcon}
          />
        </div>
        <p>
          The 0m band counts exposure inside the fire's own perimeter. 500m/1,000m/2,400m come
          from a review of wildfire community-asset-protection buffer studies (500m was the most
          common value across the studies reviewed) and the California Fire Alliance's
          firebrand-travel-distance standard (2,400m / 1.5 miles). No single global standard
          exists for this distance - it varies by country and methodology.
        </p>
      </section>

      <section id="population-methodology">
        <h2>How population estimates are calculated (and where they're weakest)</h2>
        <p>
          Population is <em>not</em> a raster/pixel grid here - each buffer's population estimate
          is built from Census <strong>block groups</strong>: irregular polygons, each carrying a
          single total-population figure from the ACS 5-Year survey. For every block group that
          overlaps a buffer ring, this tool assigns{' '}
          <code>population × (fraction of the block group's area inside the buffer)</code> -
          areal-weighted apportionment. That math assumes population is spread{' '}
          <em>uniformly</em> across the entire block group polygon.
        </p>
        <p>
          Block groups are sized by a <strong>population</strong> target (roughly 600-3,000
          people each), not a land-area target - so in sparse, wildfire-prone terrain (forest,
          high desert, mountains), a single block group can span hundreds of square kilometers
          just to reach that population count. Checked directly against fires in this tool's own
          data: a small fire's entire 2,400m buffer can cover less land area than a{' '}
          <em>single</em> block group overlapping it - in one case checked, over 10x less. If that
          block group's real population sits in a town elsewhere within its boundary rather than
          near the fire, the areal-uniform assumption overstates exposure; if the fire happens to
          sit right on the one populated pocket in an otherwise-empty block group, it understates
          exposure instead. Larger fires are less affected, since their buffers span many block
          groups and individual errors average out more.
        </p>
        <p>
          The alternative originally considered, WorldPop's gridded population data, uses
          dasymetric modeling - satellite-derived building/settlement layers redistributing
          population <em>within</em> each admin unit rather than assuming uniform density - which
          would handle this specific case better. It was dropped for this project over persistent
          hosted-API reliability issues, not because the Census approach was chosen as more
          accurate. The tradeoff: Census data is authoritative and always available, but less
          precise for small perimeters in sparse block groups specifically.
        </p>
      </section>

      <section>
        <h2>How the priority score works</h2>
        <p>
          Each tracked fire gets a 0-100 score from two equally-weighted pillars:{' '}
          <strong>exposure</strong> (up to 50 points: buildings + population, weighted 4/3/2/1
          across the perimeter/500m/1,000m/2,400m bands so closer, more-certain exposure counts
          for more) and <strong>fire scale</strong> (up to 50 points, log-transformed acreage, so
          one outlier-huge fire doesn't dominate the scale). Both are normalized against the{' '}
          <em>current</em> fire list, not a fixed scale - this is a same-day relative ranking tool
          for picking today's top candidates, not an absolute or portable risk certification. A
          score of 50 today and a score of 50 next week don't necessarily represent the same
          underlying risk, since the fire list it's ranked against has changed.
        </p>
      </section>

      <section id="sar-methodology">
        <h2>How the SAR acquisition workflow works</h2>
        <p>
          "Mark for acquisition" triggers a live search of the Copernicus Sentinel-1 catalogue
          across a pre-fire window (discovery date minus 21 days) and a post-fire window
          (discovery date to today, capped at 45 days), returning real candidate scenes - not
          placeholder fields. Each candidate shows its date, orbit direction, relative orbit
          (track) number, and an <strong>AOI coverage %</strong>: the percentage of the fire's
          own perimeter actually covered by that scene's real imaged footprint, not just whether
          the scene's bounding box touches the search area. Sentinel-1's IW acquisition mode is
          captured in bursts, so a scene can graze a search area while a gap in coverage runs
          right through the fire itself - the coverage % catches that before it becomes a bad
          pick, not after.
        </p>
        <p>
          Picking a "before" scene filters the "after" list to the same relative orbit where
          possible (falling back to the same orbit direction otherwise) - matching orbits
          guarantees identical viewing geometry between the two dates, which matters for
          comparing radar backscatter reliably. Choosing <em>which</em> orbit/track actually best
          covers an arbitrary fire is left as a human decision rather than automated - a genuine
          geometry/ML problem, not just an engineering one.
        </p>
        <p>
          <strong>"Confirm &amp; proceed" only records the decision.</strong> No SAR processing is
          dispatched yet - the compute pipeline (downloading and processing the chosen scenes,
          running change detection, publishing results) is a separate, not-yet-built phase.
        </p>
      </section>

      <section>
        <h2>Known limitations</h2>
        <ul>
          <li>
            Population estimates are less accurate for small fires in sparse rural areas - see{' '}
            <a href="#population-methodology">above</a>.
          </li>
          <li>
            Only OSM building footprints mapped as ways are counted; multipolygon "relation"
            buildings (rare, usually large complexes) aren't yet included. OSM coverage itself
            varies by region.
          </li>
          <li>
            Exposure figures are recomputed only when a fire is new, its perimeter changes
            materially, or on a periodic staleness check (currently 24 hours) - not on every page
            load, and not instantly when a data source (like the Census key) changes.
          </li>
          <li>
            Some NIFC fields (discovery date, containment %, cause, complexity) are missing for a
            meaningful fraction of fires - shown as blank/"Pending" rather than a misleading zero.
          </li>
          <li>
            The priority score is a same-day relative ranking, not an absolute or portable risk
            certification - see <a href="#sar-methodology">above</a> for how it's computed.
          </li>
          <li>
            SAR acquisition scene picking shows real, live candidates and a real coverage check,
            but does not automate orbit/track selection, and does not yet dispatch any actual SAR
            processing.
          </li>
        </ul>
      </section>
    </div>
  )
}
