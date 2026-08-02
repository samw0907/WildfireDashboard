import { StatCard } from '../components/StatCard'
import { AreaIcon } from '../components/icons'
import { PipelineDiagram, type PipelineStep } from '../components/PipelineDiagram'
import { ParamChips } from '../components/ParamChips'

const SAR_PIPELINE_STEPS: PipelineStep[] = [
  {
    number: '01',
    eyebrow: 'Input',
    title: 'Scene download',
    bullets: ['Sentinel-1 IW GRD, VV+VH', 'Human-picked via the acquisition workflow'],
    accent: 'red',
  },
  {
    number: '02',
    eyebrow: 'Process',
    title: 'RTC processing (SNAP)',
    bullets: ['Radiometric terrain correction (gamma0)', '20m pixel spacing, per-fire UTM zone'],
    accent: 'orange',
  },
  {
    number: '03',
    eyebrow: 'Combine',
    title: 'Composite or single-pair',
    bullets: ['Median of 3 dates (Composite)', 'or 1 date directly (Single-pair fallback)'],
    accent: 'yellow',
  },
  {
    number: '04',
    eyebrow: 'Detect',
    title: 'Change detection',
    bullets: ['Log-ratio, VV+VH combined magnitude', 'Fixed threshold → burn mask + building damage'],
    accent: 'yellow',
  },
  {
    number: '05',
    eyebrow: 'Output',
    title: 'Results',
    bullets: ['Burn perimeter + building damage GeoJSON', "Shown on the fire's own page"],
    accent: 'green',
  },
]

const SAR_PARAMS = [
  { label: 'Damage threshold', value: 'Adaptive (per fire), 2.9 dB fixed reference' },
  { label: 'Pixel spacing', value: '20 m' },
  { label: 'Min patch size', value: '1.0 ha' },
  { label: 'Composite size', value: '3 scenes/side' },
]

export function Reference() {
  return (
    <div className="reference-page">
      <h1>Methodology &amp; References</h1>
      <p className="page-subtitle">Plain-language methodology and data sources</p>

      <section>
        <h2>What this tool does</h2>
        <p>
          WildfireDashboard tracks currently active US wildfires, estimates the buildings and
          population near each fire's perimeter, and surfaces a priority score to help identify
          which fires are worth a closer look. From there, it supports a human-in-the-loop
          workflow for marking a fire for follow-up Sentinel-1 SAR (satellite radar) imagery
          analysis - browsing real candidate before/after scenes, and once confirmed, dispatching
          real compute (AWS Batch) that runs change detection and building-damage classification
          - see <a href="#sar-methodology">how the SAR workflow works</a> below. This is a
          portfolio/demo project, not an operational emergency response tool - figures are sourced
          and dated below, and gaps or accuracy limits in the underlying open data are stated
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

      <section>
        <h2>Incident complexity levels</h2>
        <p>
          Fire pages show a "Type" badge (Type 1 through Type 5) sourced directly from NIFC -
          this is the standard NIMS/ICS incident complexity scale used across US wildland fire
          agencies, and the numbering is counterintuitive: <strong>lower is bigger</strong>.
        </p>
        <ul>
          <li>
            <strong>Type 1</strong> - the most complex: a nationally significant incident,
            national resources committed, can run for weeks or months.
          </li>
          <li>
            <strong>Type 2</strong> - a regionally significant incident, beyond local control,
            expected to run multiple operational periods.
          </li>
          <li>
            <strong>Type 3</strong> - an extended-attack incident, larger than an initial
            response but not requiring the full command structure of Type 1/2.
          </li>
          <li>
            <strong>Type 4</strong> - an initial-attack incident, managed with local resources
            only.
          </li>
          <li>
            <strong>Type 5</strong> - the smallest: typically 5 or fewer people needed to manage
            it.
          </li>
        </ul>
      </section>

      <section id="population-methodology">
        <h2>How population estimates are calculated (and where they're weakest)</h2>
        <p>
          Population is <em>not</em> a raster/pixel grid here - each buffer's population estimate
          is built from Census <strong>block groups</strong>: irregular polygons, each carrying a
          single total-population figure from the ACS 5-Year survey. Block groups are sized by a{' '}
          <strong>population</strong> target (roughly 600-3,000 people each), not a land-area
          target - so in sparse, wildfire-prone terrain (forest, high desert, mountains), a single
          block group can span hundreds of square kilometers just to reach that population count.
        </p>
        <p>
          <strong>Population is distributed to real OSM buildings, not spread evenly across the
          block group's land area (dasymetric weighting).</strong> For every block group that
          overlaps a fire's buffer, this tool fetches its actual OSM building count, divides the
          block group's Census population evenly across those buildings, then counts only the
          buildings that actually fall inside a given buffer band. A small fire's buffer clipping
          a mostly-empty corner of a huge rural block group is no longer credited with a share of
          population proportional to <em>land area</em> - it only gets credit for the population
          attributed to whichever real buildings happen to sit inside it.
        </p>
        <p>
          This replaced a simpler areal-weighted method (
          <code>population × fraction of the block group's area inside the buffer</code>) after it
          produced a genuinely implausible real result - a fire with only 3 buildings in its
          perimeter was attributed 564 people, because its buffer happened to clip a sliver of a
          huge, sparse block group whose real population lived elsewhere within that same polygon.
          Dasymetric mapping (building- or settlement-weighted redistribution, rather than assuming
          uniform density) is the standard answer to exactly this failure mode - not something
          invented for this project, and in fact the same idea behind why WorldPop's gridded
          population product (considered earlier, dropped over hosted-API reliability issues, not
          accuracy) would have handled this case better than plain Census areal weighting.
        </p>
        <p>
          <strong>Real limitations that remain, even with this improvement:</strong> not every OSM
          "building" is a residence - barns, sheds, and commercial/industrial structures all
          typically carry the same generic <code>building=yes</code>-style tag, and rural OSM
          tagging is usually too inconsistent to reliably filter down to just houses, so building{' '}
          <em>count</em> is a proxy for occupancy, not a direct measure of it. A block group with
          real population but zero OSM buildings mapped at all (a genuine coverage gap, not
          hypothetical) has nothing for dasymetric weighting to distribute against, so that specific
          block group falls back to the older areal-weighted method instead - this tool is
          honestly a hybrid, not a clean replacement. And fundamentally, this is still a modeled
          estimate with no ground truth to check it against for any specific fire, same as before.
        </p>
      </section>

      <section>
        <h2>How the priority score works</h2>
        <ParamChips
          params={[
            { label: 'Exposure weight', value: '40 pts' },
            { label: 'Fire-scale weight', value: '40 pts' },
            { label: 'Containment weight', value: '20 pts' },
            { label: 'Red Flag bonus', value: '+5 pts' },
            { label: 'Band weighting', value: '4 : 3 : 2 : 1' },
          ]}
        />
        <p>
          Each tracked fire gets a 0-100 score from four components: <strong>exposure</strong> (up
          to 40 points: 20 building + 20 population, weighted 4/3/2/1 across the perimeter/500m/
          1,000m/2,400m bands so closer, more-certain exposure counts for more), <strong>fire
          scale</strong> (up to 40 points, log-transformed acreage, so one outlier-huge fire
          doesn't dominate the scale), <strong>containment</strong> (up to 20 points, inverted - a
          0%-contained fire scores the full 20, a fully-contained one scores 0 - an uncontained
          fire is a bigger ongoing concern than a similarly-sized contained one, since it's still
          actively threatening damage that hasn't happened yet), and a flat{' '}
          <strong>+5 bonus</strong> if the fire currently sits in an active NWS Red Flag Warning /
          Fire Weather Watch zone. Missing containment data defaults to 0% (fully uncontained,
          maximum urgency) rather than a neutral guess or excluding the fire - a real NIFC data gap
          shouldn't quietly downrank a fire that might still be very active. The total is capped at
          100 (the Red Flag bonus can occasionally push an already-maxed fire past the nominal
          range otherwise).
        </p>
        <p>
          Exposure was reduced from 25/25 to 20/20 points (2026-08-01) specifically because
          population is now itself computed from local building density (see{' '}
          <a href="#population-methodology">above</a>) - the two are no longer as independent a
          pair of signals as they used to be, so their combined weight was trimmed to reflect that,
          rather than silently double-counting the same underlying signal at full strength.
          Deliberately <strong>not</strong> scored: NIMS incident complexity type (1-5, still shown
          as its own badge) - it's largely a categorical restatement of fire scale already captured
          via acreage, and folding it in as a second scored input risked the same double-counting
          problem being corrected in exposure. Also deliberately excluded: raw wind speed or rain
          forecast - wind direction relative to exposure matters more than speed alone (real
          geometry this tool doesn't compute), a forecast is a prediction rather than a current
          condition, and fully modeling fire-weather risk is a genuine research problem on its own,
          not something a simple additive score term can honestly claim to approximate.
        </p>
        <p>
          Exposure/scale/containment are all normalized or scaled against the{' '}
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
          <strong>"Confirm &amp; proceed" dispatches real compute</strong> on AWS Batch/Fargate -
          the selected scenes are downloaded, radiometrically terrain-corrected, compared for
          change, and classified against nearby buildings. Below is that pipeline, and the fixed
          parameters it runs with:
        </p>
        <PipelineDiagram steps={SAR_PIPELINE_STEPS} />
        <ParamChips params={SAR_PARAMS} />
        <p>
          See <a href="#sar-design-choices">why the pipeline is built this way</a> below for the
          reasoning behind each of these choices, not just the parameters themselves.
        </p>
        <p>
          <strong>Every building is classified against two thresholds, not one.</strong> The
          headline result for each fire uses an <em>adaptive</em> threshold - computed
          automatically from that fire's own change-image statistics (Otsu's method, a standard
          unsupervised technique that needs no ground truth to run). A single fixed value, tuned
          once and applied identically everywhere, has no particular reason to transfer to a fire
          with very different vegetation, terrain, or climate than whatever it was originally tuned
          on - and in practice, the two can disagree substantially. The fixed value (shown above) is
          still computed for every fire, both as a stable, cross-fire-comparable reference and as
          the automatic fallback when a fire's own signal doesn't produce a clean adaptive split to
          begin with (too little real change for a genuine two-population divide to exist). Where a
          building's classification agrees under both, that's a corroborated result. Where the two
          disagree, the building is flagged <em>threshold-sensitive</em> rather than asserted with
          full confidence - a real, visible signal of exactly which classifications are robust to
          the threshold choice and which aren't.
        </p>
        <p>
          A small but real share of buildings - mostly small, rural structures near Sentinel-1's
          ~20m pixel size - contain no single pixel centered inside their footprint under the
          standard sampling rule, and would otherwise go entirely unclassified even sitting in the
          middle of real, confirmed damage. These are rescued with a one-time looser retry (any
          pixel the footprint touches, not just one whose center falls inside it) rather than left
          unassessed - their readings are averaged over a slightly larger area than most buildings,
          which sample cleanly, and the count of buildings sampled this way is shown alongside the
          results.
        </p>
        <div className="honesty-warning-card">
          <span aria-hidden="true">⚠️</span>
          <span>
            Even a corroborated result is still not validated against real damage-inspection
            records, which aren't available in a live response setting for an arbitrary fire, and is
            classified against OpenStreetMap building footprints (see{' '}
            <a href="#known-limitations">known limitations</a> for OSM's own coverage gaps).{' '}
            <strong>Treat every SAR result on this site as a rapid triage signal, not a certified
            damage assessment.</strong>
          </span>
        </div>
      </section>

      <section id="sar-design-choices">
        <h2>Why the SAR pipeline is built this way</h2>
        <p>
          The pipeline above is the <em>what</em>. This section is the <em>why</em> - the real
          tradeoffs behind each non-obvious choice, not just the parameters that resulted from them.
        </p>
        <ul>
          <li>
            <strong>This is a damage assessor for a known fire, not a fire detector.</strong> Fire
            location and timing come entirely from NIFC - the pipeline never independently confirms
            that a detected change is actually fire-caused. Run the same threshold logic on an
            arbitrary patch of this same Sentinel-1 scene with no fire anywhere nearby (a mountain
            range mid-snowmelt, for instance) and it would very plausibly come back looking just as
            "damaged" - nothing in the backscatter signal itself distinguishes fire from snowmelt,
            vegetation growth, or any other land-cover change. This isn't a shortcut unique to this
            project: real operational systems mostly work the same way, since "is a fire happening,
            right now, here" is usually solved by an entirely different sensor family - thermal-
            anomaly detection (e.g. MODIS/VIIRS active-fire hotspots), which directly senses heat and
            genuinely can't be confused with snowmelt. NIFC's own incident data sits downstream of
            exactly that kind of detection. SAR/optical change detection is then dispatched{' '}
            <em>to an already-identified location</em> to assess extent and damage, not to discover
            fires blindly. Where this could genuinely be strengthened without abandoning the
            approach: a single before/after pair can't distinguish fire's own temporal signature (an
            abrupt drop, then a slow, partial <em>recovery</em> over following weeks as vegetation
            regrows) from a smoother, often-reversible seasonal shift like snowmelt - a real
            multi-date time series, not just two snapshots, is what the wider literature uses to
            tell these apart, alongside fusing in independent thermal-anomaly data directly rather
            than relying solely on an already-known perimeter.
          </li>
          <li>
            <strong>Sentinel-1, not ICEYE's own commercial constellation.</strong> Sentinel-1 is
            free and openly accessible, which is what makes this project buildable at all - but it's
            a real tradeoff, not a free lunch: Sentinel-1's IW mode resolves ~20m per pixel, vs.
            ICEYE's own Strip (3m) or Spot (down to 0.5m) products. A typical house footprint
            (~100-300m²) spans dozens to hundreds of ICEYE pixels, but is often{' '}
            <em>smaller than one single Sentinel-1 pixel</em>. That one fact is the root cause behind
            several other choices below, not an isolated footnote.
          </li>
          <li>
            <strong>No spatial despeckling filter (Lee, Refined Lee, etc.), by design, not by
            oversight.</strong> A despeckling filter works by averaging a pixel with its
            neighborhood - correct for a large, homogeneous target where the true signal doesn't
            vary much within the filter window (a forest canopy, a grassland), wrong for a target
            smaller than the filter window itself. Given the resolution gap above, applying a
            spatial filter to building-level classification risks blending a building's own already-
            marginal signal into unrelated adjacent ground, which can erase real damage as easily as
            it removes noise. The safe lever for noise reduction here is temporal, not spatial:
            multi-date median compositing (Composite mode) and spatial corroboration against
            MMU-surviving burn patches (both described below) - not a pixel-neighborhood filter.
          </li>
          <li>
            <strong>Median compositing across 3 dates, not 2 and not a mean.</strong> A median can
            outvote a single anomalous scene (a rain event, a soil-moisture spike) in a way a mean of
            the same dates can't - but median of only 2 values is mathematically identical to their
            mean, so 3 is the minimum where that protection actually exists. Single-pair mode (one
            scene per side) is the deliberate fallback for a fire whose track can't yet support 3,
            not a silently-degraded version of the same thing - it's always labeled as reduced
            reliability, never presented with the same confidence.
          </li>
          <li>
            <strong>Minimum mapping unit raised to 1.0ha.</strong> Real burned-area practice
            commonly runs 1-6+ hectares as a noise floor; a much finer value inherited early in this
            project's build let far more small noise fragments survive the filter than standard
            practice would, visible directly as a "checkerboard" burn-area appearance before this was
            corrected.
          </li>
          <li>
            <strong>Two thresholds, not one, with the adaptive value leading.</strong> A single fixed
            dB cutoff, once calibrated, has no particular reason to transfer to a fire with different
            vegetation, terrain, or climate than whatever it was tuned on - confirmed concretely on
            real data, where the fixed and adaptive thresholds disagreed on roughly half of
            comparably-classified buildings for one fire. The adaptive (Otsu) threshold, computed
            fresh from each fire's own change statistics, leads; the fixed value stays as a stable
            cross-fire reference and the automatic fallback when a fire's own signal has no clean
            split to adapt to.
          </li>
          <li>
            <strong>Spatial corroboration - the "unconfirmed" class.</strong> A single pixel crossing
            the threshold isn't by itself proof of real damage - it can just as easily be a noisy
            pixel with no real signal behind it, especially given the resolution gap above. Any
            building whose positive reading isn't backed by a real, MMU-surviving burn patch nearby
            is downgraded to "unconfirmed" rather than asserted as damage - a deliberately separate
            class from "no damage detected", since an uncorroborated positive reading and a genuine
            negative reading aren't the same claim.
          </li>
          <li>
            <strong>OpenStreetMap buildings, not Microsoft's Global ML Building Footprints.</strong>{' '}
            Microsoft's dataset is what the original methodology this project adapted from was
            validated against, but adopting it would mean two different building inventories on the
            same page (this tool's own exposure feature already uses OSM) and real new
            infrastructure for a static, large per-state download. The honest cost: any validated
            accuracy figures tied to Microsoft's exact footprint geometries don't transfer to OSM's
            different polygons - judged an acceptable tradeoff since this project doesn't carry
            forward a specific validated accuracy claim either way (see below).
          </li>
        </ul>
      </section>

      <section id="known-limitations">
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
            but does not automate orbit/track selection - a human still picks the scenes. Once
            confirmed, real compute runs on AWS (see <a href="#sar-methodology">above</a>).
          </li>
          <li>
            SAR RTC processing currently takes on the order of an hour per scene, dominated by the
            terrain-flattening step - a few architecture options exist to speed this up (more
            parallelism, tuned SNAP settings) but weren't worth building for a demo processing a
            handful of fires rather than a production volume.
          </li>
        </ul>
      </section>

      <section id="references">
        <h2>References</h2>
        <p>
          The SAR methodology above wasn't invented from scratch - it's adapted from the practices
          and literature below, checked directly rather than assumed. Blog posts and social media
          aside, everything here is either published research or a documented operational source.
        </p>
        <ul>
          <li>
            <a href="https://forest-fire.emergency.copernicus.eu/about-effis/technical-background/rapid-damage-assessment" target="_blank" rel="noopener noreferrer">
              EFFIS — Rapid Damage Assessment
            </a>{' '}
            — the EU's own operational wildfire-mapping methodology (optical-primary, human-verified);
            the basis for framing SAR's real niche as seeing through smoke/cloud, not replacing optical.
          </li>
          <li>
            <a href="https://docs.copernicuslac.terradue.com/services/fire/intro/" target="_blank" rel="noopener noreferrer">
              Copernicus — Fire (CopernicusLAC Platform)
            </a>{' '}
            — background on the EU's broader operational fire-monitoring service context.
          </li>
          <li>
            <a href="https://arxiv.org/pdf/2501.09129" target="_blank" rel="noopener noreferrer">
              Deep Self-Supervised Disturbance Mapping with the OPERA Sentinel-1 RTC Product
            </a>{' '}
            — RTC-based (radiometric terrain-corrected) Sentinel-1 change detection, the same product
            family this pipeline builds on.
          </li>
          <li>
            <a href="https://www.sciencedirect.com/science/article/pii/S0034425719303645" target="_blank" rel="noopener noreferrer">
              Burned area detection and mapping using Sentinel-1 backscatter coefficient and thermal
              anomalies
            </a>{' '}
            — core literature behind detecting burned area directly from SAR backscatter change.
          </li>
          <li>
            <a href="https://www.tandfonline.com/doi/full/10.1080/15481603.2021.1907896" target="_blank" rel="noopener noreferrer">
              A workflow based on Sentinel-1 SAR data and open-source algorithms for unsupervised
              burned area detection in Mediterranean ecosystems
            </a>{' '}
            — a real open-source, ground-truth-free SAR burned-area workflow precedent.
          </li>
          <li>
            <a href="https://rslab.disi.unitn.it/papers/R34-TGARS-change-detection-SAR-kittler.pdf" target="_blank" rel="noopener noreferrer">
              An Unsupervised Approach Based on the Generalized Kittler-Illingworth Algorithm for SAR
              Change Detection
            </a>{' '}
            — the academic basis for adaptive (ground-truth-free) thresholding of SAR change images,
            the family of method behind this site's own adaptive threshold.
          </li>
          <li>
            <a href="https://www.sciencedirect.com/science/article/pii/S2212420926000609" target="_blank" rel="noopener noreferrer">
              Assessing the transferability of post-disaster building damage assessment using SAR and
              machine learning
            </a>{' '}
            — directly on point for this project's central open question: whether a threshold
            calibrated on one event transfers to another.
          </li>
          <li>
            <a href="https://www.sciencedirect.com/science/article/abs/pii/S2212420925006338" target="_blank" rel="noopener noreferrer">
              A rapid and quantitative post-wildfire damage assessment of buildings in the 2025
              Palisades fire based on InSAR
            </a>{' '}
            — a very recent, wildfire-specific precedent using InSAR deformation rather than
            backscatter intensity - a genuinely different signal, noted as a real alternative not
            currently built here.
          </li>
          <li>
            <a href="https://link.springer.com/article/10.1186/s40623-016-0513-2" target="_blank" rel="noopener noreferrer">
              Detection of damaged urban areas using interferometric SAR coherence change with
              PALSAR-2
            </a>{' '}
            — the interferometric-coherence alternative family for building-level damage, explicitly
            out of scope here (needs SLC data and precise co-registration) but grounded in real
            earthquake-damage literature.
          </li>
          <li>
            <a href="https://essd.copernicus.org/articles/13/5353/2021/" target="_blank" rel="noopener noreferrer">
              Refined burned-area mapping protocol using Sentinel-2 data
            </a>{' '}
            — standard-practice grounding for minimum-mapping-unit (MMU) sizing.
          </li>
          <li>
            <a href="https://www.iceye.com/gov/building-level-wildfire-insights" target="_blank" rel="noopener noreferrer">
              Building level | Wildfire Insights for government | ICEYE
            </a>{' '}
            — ICEYE's real commercial building-level wildfire product; this site's binary
            destroyed/undamaged-per-building output shape is modeled on the same real-world pattern.
          </li>
          <li>
            <a href="https://www.iceye.com/blog/wildfire-monitoring-with-sar" target="_blank" rel="noopener noreferrer">
              Revolutionizing Wildfire Monitoring with ICEYE's SAR Technology
            </a>{' '}
            — ICEYE's own account of their operational approach and resolution advantages over
            Sentinel-1.
          </li>
        </ul>
      </section>
    </div>
  )
}
