# WildfireDashboard — Build Progress

Running checklist for Phase 1, kept up to date as we go. Not committed until
you're ready — ask to add it whenever. See `DECISIONS.md` for the reasoning
behind anything marked as a real choice, not just what got built.

## Planning
- [x] Reviewed scope + CLAUDE.md docs, resolved open gaps (2026-07-25)
- [x] Revisions agreed: decouple ingestion/recompute cadence, Railway budget
      ($5 soft / $10 hard), AWS budget alerts ($5/$10, no auto-stop), WorldPop
      hosted stats API (no self-hosted raster), custom domain, recompute
      endpoint API-key-gated, `ON DELETE CASCADE` on exposure/building FKs
- [x] Confirmed: Docker/CI-CD/tests deferred to end of main phase

## Repo setup
- [x] Local folder connected to `github.com/samw0907/WildfireDashboard`
- [x] `.gitignore` scaffolded
- [x] `.env` (local, gitignored) + `.env.example` (checked-in template) scaffolded
- [x] AWS/CDSE credentials intentionally excluded + documented in `.env.example`
      (AWS → GitHub Actions secrets later; CDSE → Phase 2 only)
- [x] `backend/` scaffolded (FastAPI skeleton below)
- [x] `frontend/` scaffolded, root `README.md` written (overview, live
      links, architecture, data sources, status, local dev setup)

## Backend core
- [x] FastAPI skeleton + `/health` endpoint + `requirements.txt` — verified locally,
      returns `{"status":"ok"}` (`backend/app/main.py`, `backend/app/config.py`)
- [x] Database schema + Alembic migrations — PostGIS confirmed available on
      Railway Postgres, but decided against it: JSONB + shapely chosen
      instead (matches existing portfolio pattern, volume never justifies
      PostGIS's spatial indexing at Phase 1 scale, additive to add later if
      ever needed). `fires`, `building_cache`, `exposure_stats`,
      `ingestion_status` tables live on Railway Postgres now, verified via
      schema inspection incl. `ON DELETE CASCADE` on both FKs
- [x] NIFC WFIGS ingestion job (15-min cadence, asyncio background loop in
      the FastAPI lifespan - no extra scheduler dependency) + prune job
      (NIFC's own fall-off thresholds: <10ac/3d, 10-100ac/8d). Verified
      endpoint: `WFIGS_Interagency_Perimeters_Current` FeatureServer
      (resolved from the ArcGIS Hub dataset item, not guessed - NIFC had
      restructured this since the original plan was written). Live test:
      201 of 210 current fires ingested into Railway Postgres, paginated
      correctly (200/page), `/health` stayed responsive throughout (runs in
      a thread, doesn't block the event loop), `ingestion_status` recording
      success/failure per cycle as designed
- [x] Exposure computation: one Overpass fetch per fire (bbox query around
      the 2400m buffer, exact containment filtered locally in shapely —
      decided over a direct polygon-filter query, which risks oversized
      queries on complex fire perimeters). Buffer bands (500/1000/2400m)
      derived locally from that single fetch. Recompute decoupled from
      ingestion cadence: only runs for new/changed/stale fires
      (`fires_needing_recompute`), not every cycle.
  - [x] Discovered live during testing: Overpass's public instance needs an
        identifying `User-Agent` header (bare 406 without one) and is
        prone to real overload (504s, 429s) - confirmed by hand, not
        hypothetical. Decided: no retry, log and skip, let the next
        scheduled cycle pick a failed fire back up - avoids piling onto an
        already-struggling free service. Added a 2s politeness delay
        between requests too.
  - [x] WorldPop dropped entirely (persistently stuck task queue, confirmed
        on two tests a day apart) in favor of **US Census Bureau data** -
        TIGERweb for block group geometries (no key) + ACS 5-Year Data API
        for population (free key, requested, not yet issued). Areal-
        weighted population-in-buffer via shapely intersection - no raster
        hosting needed at all. See `DECISIONS.md` for full reasoning.
        `backend/app/census.py` built and the geometry half verified live
        (152 block groups fetched for a real bbox); population half not
        yet live-tested, pending the key. Graceful degrade confirmed:
        `population_est` stays null without blocking building counts when
        no key is configured.
  - Verified live: buildings fetched and stored in `building_cache`,
    `exposure_stats` rows written with real building counts (0 for two
    remote test fires — plausible, not yet confirmed against a
    building-dense area)
- [x] API endpoints: `GET /api/fires` (201 fires, full perimeter + latest
      exposure per band), `GET /api/fires/{id}` (adds cached buildings
      GeoJSON), `POST /api/fires/{id}/recompute` (API-key-gated, fails
      closed if no key configured). Bug caught + fixed during testing: the
      recompute endpoint let an Overpass failure bubble up as a raw 500 -
      now returns a clean 503 with a message, matching the same "Overpass
      is unreliable, handle it gracefully" stance as the background loop.
      Also fixed: `recompute_api_key` was used in code but never actually
      added to the `Settings` class - caused every auth check to crash.

## Frontend core
- [x] Vite + React (TS) skeleton, MapLibre GL map component (placeholder demo
      style), backend health-check status badge — verified: both dev servers
      running locally, `frontend/` builds clean, map tiles render and badge
      goes green at `http://localhost:5173` (confirmed in a real browser tab,
      not just an IDE preview)
- [x] Fixed a MapLibre GL JS + Vite incompatibility: Vite's dep pre-bundler
      served MapLibre's web worker with an empty MIME type, browser refused
      to run it ("WebGL context was lost" / worker blocked). Fixed via
      `optimizeDeps: { exclude: ['maplibre-gl'] }` in `vite.config.ts`
- [x] Second, different MapLibre+Vite issue found in the deployed
      (production build) version, not dev: MapLibre resolves its worker via
      `new URL('./maplibre-gl-worker.mjs', import.meta.url)` at runtime,
      but Rollup's production build never emits that as a real file - the
      404 was then masked by CloudFront's SPA fallback (404→index.html) as
      a "wrong MIME type" module-load error. Fixed by copying the real
      worker file from `node_modules/maplibre-gl/dist/` into
      `frontend/public/assets/`, so Vite includes it verbatim at the exact
      path the runtime expects on every build. Turned out to be two files,
      not one - `maplibre-gl-shared.mjs` failed the same way after fixing
      the worker file; checked both files' own source for further chained
      dynamic references (none found) before redeploying a second time.
      Verified live: both now serve as `text/javascript`, not the HTML
      fallback.
- [x] Four Phase 1 pages built with real API data: Dashboard (stat cards +
      map + fire list), Map (full-width), Fire Detail (per-fire map +
      exposure stats per band, "Pending" shown honestly where
      population_est is still null), Reference (real sourced citations,
      no manufactured legitimacy per the anti-TAFP principle). Fire Detail
      reached via clicking a fire, not a standalone nav link (would be a
      dead end with no fire selected) - nav has Dashboard/Map/Reference.
      React Router + a small dark/light theme toggle (localStorage-backed)
      added. `tsc` build clean; verified `/health` and `/api/fires` both
      respond with the dev server up
- [x] Responsive nav: sidebar (desktop) collapses to a bottom tab bar under
      768px, per the mobile-friendly requirement
- [x] First-pass styling matching TAFP screenshots (roughly, not a clone):
      boxed nav active-state with icons, icon-circle stat cards,
      pill-shaped sun/moon theme toggle — small hand-rolled SVG icon set,
      no icon library dependency added. Confirmed: good enough to carry
      the visual direction forward, full polish deferred to the end
      alongside Docker/CI/tests.
- [x] Wired to backend via `VITE_API_BASE_URL` (shared root `.env` via Vite's
      `envDir`)

## Deploy
- [x] Railway: Postgres provisioned, usage limits set ($5 soft alert / $10 hard cap)
- [x] Railway: backend deployed as its own service (root dir `backend`,
      explicit Custom Start Command since the newer "Railpack" builder's
      Procfile auto-detection wasn't verified). Live at
      `wildfiredashboard-production.up.railway.app` — `/health` and
      `/api/fires` both verified returning real data (201 fires, ingestion
      ran independently on Railway)
- [x] AWS: S3 bucket + CloudFront (OAC, default root object, SPA 403/404→
      index.html error pages), dedicated narrowly-scoped IAM deploy user,
      manual build+sync+invalidate (CI/CD automation deferred to end).
      Live at `d3qmrxoydtsnh7.cloudfront.net`, verified root + a client-side
      route both return 200. Bug caught before user-testing: backend's
      `CORS_ALLOWED_ORIGINS` only allowed localhost — needs the CloudFront
      origin added or the deployed frontend can't call the deployed
      backend (browser-enforced, invisible to curl tests)
- [x] AWS budget alerts set ($1 / $10 — even more conservative than the
      $5/$10 planned, that's fine), alerts only per the earlier decision
- [ ] Custom domain: Route53 + ACM cert wired to CloudFront — deferred to
      the final polish pass (2026-07-28); use default CloudFront URL for
      now to unblock frontend deployment
- [x] External uptime monitor set up (UptimeRobot): frontend CloudFront
      URL + backend `/health`. Bug caught immediately: UptimeRobot's HTTP
      monitor defaults to `HEAD` requests, but `/health` only registered
      `GET` (`405 Method Not Allowed` on HEAD) - Railway showed the
      service as healthy while UptimeRobot reported it down, which is
      what surfaced the mismatch. Fixed via `@app.api_route("/health",
      methods=["GET", "HEAD"])`

## Polish (near end of main phase — now explicitly LOWER priority than the
## priority-fire/SAR work below, per 2026-07-29 reprioritization)
- [ ] Honesty/labeling pass (dated/sourced figures, portfolio disclaimer)
- [ ] GitHub Actions CI/CD (lint + test backend, build + S3 sync frontend)
- [ ] Unit + integration tests
- [x] README core content written early (not deferred - useful throughout
      the build, not just at the end); final pass once WorldPop/custom
      domain/etc. are resolved to update the "Status" section
- [x] ~~Dockerize backend~~ — dropped from the plan (2026-07-29): Railway
      deploys the backend fine without one, no purpose found for it here.
      Docker still matters, just specifically for the SAR compute image
      (see below), not the main backend.

## Backlog / future ideas (not started, logged for later)
- [ ] Smoke / air quality overlay (NOAA HMS smoke or EPA AirNow) - extends
      exposure-first framing beyond the fire's physical footprint
- [ ] Satellite imagery basemap toggle (MapTiler), alongside the current
      OpenFreeMap street style - matches TAFP's own Street/Imagery toggle
- [ ] Email notification when a new fire enters the priority-acquisition
      slot (separate from the hard confirm-gate on actually spending money)
- [ ] Building footprints as their own visible map layer (not just used
      internally for exposure counts/SAR damage classification) - raised
      2026-07-30 alongside the OSM-vs-Microsoft building dataset decision
      (see `SAR_METHODOLOGY.md` §6). More work than a quick add - shelved.
- [ ] SAR damage-threshold loose recalibration against publicly reported
      aggregate "structures destroyed" counts (NIFC/state emergency
      management updates), if/when available for a specific fire - a much
      weaker signal than the original pipeline's per-building CAL FIRE
      DINS ground truth (matching a total doesn't confirm the right
      buildings were flagged), but a real idea raised 2026-07-30. See
      `SAR_METHODOLOGY.md` §7 - fixed threshold used for now instead.
- Explicitly parked, not planned: "evacuation routes" as a labeled feature
  - no standardized national data source exists for real evacuation
    routes; the basemap already shows roads, so a dedicated OSM-highways
    layer wasn't judged worth adding on its own. The methodologically
    real version (network/isochrone travel-time analysis) is a genuine
    future idea, not a quick add.
- [ ] **Fire Detail history/timeline** (2026-07-30 idea, shelved - real
      schema work, not a quick add): user asked about scrubbing day-by-day
      through a fire's perimeter/stat changes over its lifetime. Checked
      `ingestion.py`'s `upsert_fires()`: it's a true `ON CONFLICT DO
      UPDATE` - perimeter, acres, containment %, everything gets
      overwritten in place every 15-min cycle, with zero history kept on
      the `fires` table itself. (`ExposureStat` is the one exception -
      already append-only, so a buildings/population-over-time trend is
      comparatively cheap; it's specifically perimeter shape + core fields
      that have no history.) Checked whether NIFC publishes something
      queryable instead of building our own versioning - they have
      historical fire-perimeter datasets (`WFIGS Wildland Fire Perimeters
      Full History`, `InterAgencyFirePerimeterHistory`), but these read as
      archives of past, *closed-out* fire seasons (final perimeter per
      fire, year over year), not a live log of one currently-active fire's
      perimeter changing shape day by day - unconfirmed without live-
      testing the actual endpoint, flagged as unresolved rather than
      assumed. Building this for real needs: a new snapshot table (written
      whenever ingestion detects a change for a tracked fire), new
      ingestion logic, a new API endpoint serving the time series, and new
      frontend UI (a day-by-day scrubber on Fire Detail) - a genuine
      multi-piece feature, not a quick add.

## Fire Detail wind + forecast (2026-07-29)
- [x] `GET /api/fires/{id}/weather` - centroid of the fire's own perimeter
      (shapely `.centroid`) fed into `api.weather.gov`'s `/points/{lat,lon}`
      → `/gridpoints/.../forecast` (same free/no-key NWS API as the Red
      Flag layer). Returns current wind (speed/direction, both as a
      compass-degrees value for the arrow and the original text for
      display) plus 10 twelve-hour periods (~5 days: temp, short
      forecast, wind, precip chance). 30-minute in-process cache per
      rounded lat/lon, matching the alerts cache pattern.
- [x] Wind arrow overlaid in the top-right corner of the Fire Detail map -
      rotated to the direction the wind is blowing *toward* (spread
      direction), not the raw "from" compass bearing NWS reports, since
      that's what's actually relevant to fire behavior. Tooltip spells out
      both directions to avoid ambiguity.
- [x] Forecast panel below the map/exposure split - horizontally
      scrollable day/night cards (temp, conditions, wind, precip chance
      when >0%). Fetched independently from the core fire data and fails
      silently (no error state) if NWS is unavailable - it's a nice-to-
      have on top of the exposure story, not core data.

## Red Flag Warnings layer (2026-07-29)
- [x] Fetch active NWS alerts (`api.weather.gov/alerts/active`, filtered
      to Red Flag Warning / Fire Weather Watch) - verified live before
      building: alert features carry `geometry: null`, the real polygon
      lives on referenced zones (`affectedZones` → `/zones/fire/{id}`),
      deduped and cached in-process (refreshed every ingestion cycle;
      no DB table needed at this scale - 5 alerts / 15 zones nationally
      at time of testing). Toggleable violet dashed layer on Dashboard/Map
      (not Fire Detail - a nationwide layer isn't useful zoomed into one
      fire), same stacking pattern as the buffer rings. Fills the "no US
      danger classification" gap from original planning.
- [x] **Per-fire warning flag** (fast-follow): `nws.fires_in_active_warnings()`
      shapely-intersects each fire's stored perimeter against the cached
      zone geometries; exposed as `in_active_fire_weather_warning` on
      `FireOut`, computed in both `list_fires()` and `get_fire()` from the
      same in-process alert cache (no extra HTTP calls). Surfaced as a
      violet "⚠ RFW" pill in the fire table (next to the name) and a
      "⚠ Active fire weather warning" badge in the Fire Detail incident-
      badges row. Verified live: 7 of 232 tracked fires flagged at time
      of testing.

## Priority-fire identification + SAR acquisition trigger (2026-07-29 —)
Reprioritized above remaining Phase 1 polish - see `DECISIONS.md` for the
full reasoning, the priority-score formula, and the LAwildfireSAR pipeline
reuse audit. Scoped tightly: no automated orbit/scene-selection (assessed
as a genuine ML/geometry research problem, out of scope) - human-in-the-
loop scene picking instead.

- [x] **Priority score**: two equally-weighted pillars - exposure (25
      building + 25 population, weighted 4/3/2/1 across perimeter/500m/
      1000m/2400m bands) + scale (50, log-transformed acreage), each
      normalized against the current fire list → 0-100 score. New
      sortable/filterable table column with a color-coded badge. No auth
      needed (read-only ranking). **Bug found + fixed live (2026-07-29)**:
      first version (exposure only) let a 6-acre fire outrank fires
      1,000x+ larger purely from sitting in a dense area - added the
      acreage/scale pillar, verified the fire dropped from #2 to #134 of
      230. Full reasoning in `DECISIONS.md`.
- [x] **Admin-key access gate**: shared-secret prompt (not a full login
      system) for costly actions, same fail-closed pattern as
      `RECOMPUTE_API_KEY`. Key entered once, stored browser-side, sent as
      a header, validated server-side. Verified: 403/403/200 for no-key/
      wrong-key/correct-key. Frontend helper built, not yet consumed by a
      real feature (next up).
- [x] **"Mark for acquisition" + live scene picker** (2026-07-29): generalized
      the pipeline's `search_scene()` (single forced date+direction) into
      `cdse.search_scenes()` - a date-range search across both orbit
      directions, live-verified against the real CDSE catalogue (no auth
      needed for search itself, confirmed). New `fires` columns
      (`acquisition_status`/`acquisition_before_scene`/`acquisition_after_scene`/
      `acquisition_confirmed_at` - mutable per-fire state, not a history)
      via Alembic migration, applied directly (dev and prod share one
      Railway Postgres). New `/api/fires/{id}/acquisition[...]` endpoints:
      `GET` (state) and `GET /candidates` (live search, before window =
      discovery date − 21 days, after window = discovery date → min(now,
      +45 days)) are public/read-only since search costs nothing; `POST
      /mark`, `/select`, `/confirm`, `/unmark` are admin-key gated
      (state-mutating). Frontend `AcquisitionPanel` on Fire Detail: mark
      button → side-by-side before/after scene picker (after list
      client-side filtered to the before scene's exact relative orbit,
      falling back to same orbit direction if no exact-track match exists
      yet) → save selection → "Confirm & proceed". Confirm only records
      the decision - **no compute dispatch happens yet**, and the UI says
      so explicitly rather than implying otherwise. Verified end-to-end
      live (mark/candidates/select/confirm/unmark all round-tripped
      against the real fire list) before handoff.
- [x] **AOI coverage check per scene** (2026-07-29 fast-follow): user
      flagged that date/track alone doesn't tell you whether a candidate
      scene is actually *usable* - unlike optical, cloud/smoke don't
      matter for SAR, but IW mode's burst structure means a scene can
      touch the search bbox while a gap runs through the fire perimeter
      itself (the literal "Track 137 burst gap" bug from the original
      LAwildfireSAR project). Now computed for real: each candidate's
      actual `GeoFootprint` (already returned by CDSE, previously
      discarded) is intersected against the fire's own perimeter in
      Albers-projected space, giving a genuine `aoi_coverage_percent`
      (color-coded green ≥95% / yellow partial / red 0%) shown right on
      each scene button. Also surfaces `polarisation` (VV/VH) per scene.
      **Real bug hit and fixed during this**: real NIFC fire perimeters
      are frequently topologically invalid (self-intersecting rings from
      containment lines/unburned islands) - confirmed live this crashes
      GEOS intersection with a `TopologyException` on some scenes.
      Fixed with `.buffer(0)` (standard shapely repair), verified live:
      previously-`None` coverage values on a real fire (Aspen Acres, ID)
      resolved to real percentages (31%/69%/100%/0% etc. across its
      candidate scenes) with the fix in place.
- [ ] **Copernicus Browser deep-link per scene** (raised, not built):
      idea was to let a human visually sanity-check a scene before
      picking it. Checked CDSE's own documentation for a reliable
      product-ID deep-link URL scheme and couldn't confirm one exists -
      didn't want to ship a guessed/fragile URL. Lower priority than the
      coverage check anyway, since coverage is the actual decision-driver;
      revisit if a documented scheme turns up.
- [x] **Scene footprint outlines on the map** (2026-07-29): the real
      `GeoFootprint` already being fetched for the coverage check (above)
      is now passed through to the frontend and drawn as an outline-only
      layer (no fill - a full IW swath is ~250km wide and would blot out
      the map otherwise), same source/layer pattern as the buffer rings
      and Red Flag Warnings layer. Blue = before scene, cyan = after
      scene, with a small legend on the map when either is selected.
      `AcquisitionPanel` reports whichever scenes are currently relevant
      (mid-selection, or already saved) up to `FireDetail` via an
      `onScenesChange` callback, which feeds `FireMap`. Verified live:
      real ~250km swath polygon coordinates render correctly.
- [ ] **Compute dispatch + results display** (2026-07-30 — design fully
      settled, see `DECISIONS.md` "SAR compute dispatch — full
      architecture + methodology decisions" and the full reasoning in
      `SAR_METHODOLOGY.md`; **not started**, this is the very next work).
      Architecture: AWS Batch on Fargate, existing `LAwildfireSAR`
      Dockerfile pushed to ECR, `/confirm` endpoint calls `boto3` Batch
      `submit_job`, new `asyncio` polling loop (same pattern as ingestion/
      exposure/alerts) checks job status, results synced to S3. Estimated
      ~$1.50-5 total for 3 demo fires (unmeasured placeholder pending a
      first real run). Broken into five phases, build in this order:
  - [x] **Phase A — data model** (2026-07-30, done + tested live): migrated
        `acquisition_before_scene`/`acquisition_after_scene` (single `Scene`
        each) to `acquisition_before_scenes`/`acquisition_after_scenes`
        (lists) via Alembic migration `68638b5b0811` - existing single-scene
        values preserved as single-element lists, not dropped. `/select`
        validates: both sides must be the same size, size must be exactly
        3 (Composite) or exactly 1 (Single-pair) - no "2" tier - and every
        selected scene on *both* sides must share one relative orbit/track
        (not just before-matches-after as before). Added a 14-day minimum
        floor (`AFTER_WINDOW_MIN_DAYS`) to the "after" search window -
        verified live it correctly produces zero candidates (not a crash)
        for a fire discovered too recently for any valid post-window date
        to exist yet. `AcquisitionOut` now also returns a derived `mode`
        (`'composite'` | `'single_pair'` | `None`) so the frontend doesn't
        need to reimplement that logic from list length.
        **Real bug found + fixed during this**: SQLAlchemy's JSONB column
        type stores a Python `None` as the literal JSON `null` (a real,
        non-SQL-NULL value) unless the column is declared with
        `none_as_null=True` - every prior `unmark` call across this
        feature's whole development had been silently doing this. Invisible
        until `jsonb_build_array()` in the new migration didn't skip a
        JSON-null-but-not-SQL-NULL column the way it skips true SQL NULL,
        producing a `[null]` array instead of `NULL`. Fixed the column
        definitions and cleaned up the one row that had already been
        corrupted by it (confirmed only one fire affected, live-checked
        across the whole table before assuming that).
  - [x] **Phase B — scene picker rework** (2026-07-30, done + build-tested):
        `AcquisitionPanel` now shows a per-track candidate-count summary
        first (computed client-side from data `/candidates` already
        returns - no backend change needed for the counting itself), each
        row labeled "Composite-ready" or "Single-pair only" so the best
        track is obvious before touching individual scenes. Clicking a
        track locks it and filters both columns to just that track;
        multi-select up to the track's target count (3 or 1, derived
        automatically from that track's own eligibility - no manual mode
        toggle). Reduced-reliability warning banner shown automatically in
        Single-pair mode. Saved state shows a mode badge ("Composite (3+3)"
        green / "Single-pair (1+1) — reduced reliability" amber).
        `FireMap`'s `sceneFootprints` prop now takes arrays per side and
        draws every selected scene's footprint, not just one.
  - [ ] **Phase C — pipeline adaptation**: new lightweight entrypoint
        (replacing `scripts/run_processing.py`'s config-file-driven
        orchestration in a copy of the `LAwildfireSAR` codebase used for
        the Docker image) that takes exact scene IDs already chosen by
        the human (no track search/selection needed at compute time) →
        downloads via `download.py` → RTC via `process.py` (unchanged) →
        `composite.py`'s median build *only in Composite mode* (Single-
        pair mode feeds the lone RTC output straight to change detection)
        → `change.py` (unchanged core math, AOI = this fire's perimeter
        instead of the hardcoded LA-events bbox) → `buildings.py` reworked
        to classify against our cached OSM footprints
        (`building_cache.buildings`) instead of Microsoft's dataset, fixed
        2.9 dB / 1.74 dB thresholds (inherited, not independently
        validated — document this in the output) → **skip `validate.py`
        entirely** (no ground truth exists for a live fire) → sync results
        to S3 (`sync_to_s3.py` pattern). Package into the existing
        Dockerfile, push to ECR.
  - [ ] **Phase D — AWS infrastructure**: ECR repo; Batch compute
        environment (Fargate-backed) + job queue + job definition with a
        hard timeout (~6h) as a cost-safety cap; IAM roles scoped to S3
        read/write; extend `/confirm` to call `boto3` `submit_job` with
        the chosen scene IDs + fire ID as container overrides; new
        background polling loop (`asyncio`, matching the existing
        ingestion/exposure/alerts pattern — no new AWS services like
        EventBridge/Lambda) checking `batch.describe_jobs()` and updating
        the DB on `SUCCEEDED`/`FAILED`.
  - [ ] **Phase E — results display**: new acquisition status states
        (processing → complete/failed) with S3 result location stored;
        new Fire Detail UI section for the output (damage summary/map
        overlay); UI copy must visibly label which mode ran ("Composite
        (3+3)" vs. "Single-pair (1+1) — reduced reliability") and frame
        accuracy honestly per `SAR_METHODOLOGY.md` (not "F1 0.80
        validated" — that number doesn't transfer to a new fire, new
        building dataset, or uncalibrated threshold).
- [x] `CDSE_USER`/`CDSE_PASSWORD` added to `.env` by the user (2026-07-29) -
      not yet consumed by any code (scene *search* needs no auth; these
      will be needed once actual scene *download* is built as part of
      compute dispatch, above).
- [ ] **`ADMIN_ACCESS_KEY` still not set in the real `.env`** - confirmed
      live (2026-07-29): all four mutating acquisition endpoints correctly
      fail closed (403) with no key configured, which is safe, but it also
      means "Mark for acquisition" won't work on the deployed site at all
      until the key is added. The key itself was already generated earlier
      this session and given to the user to add manually (never written to
      `.env` directly, per standing rule) - just needs adding.

## Buffer visualization + within-perimeter stats + basemap (2026-07-29)
- [x] Added a 4th "band" (0m = within the fire perimeter itself) to
      `BUFFER_BANDS` - reused the existing generic band machinery rather
      than special-casing it. Self-healing backfill: `fires_needing_recompute`
      now also triggers when a fire is missing any currently-required band,
      so adding this didn't need a one-off migration script.
- [x] Buffer ring polygons (500/1000/2400m) added to the fire-detail API
      response, computed on-the-fly from the perimeter (cheap, always
      consistent, not worth persisting)
- [x] Rings rendered on the Fire Detail map (stacked filled disks, largest
      first, which is what makes them read as concentric rings), color-
      matched to the exposure stat cards (red→orange→yellow outward)
- [x] Swapped the MapLibre placeholder demo style for OpenFreeMap's
      "Liberty" street style (free, no key, no rate limit) - satellite
      imagery toggle (MapTiler) noted as a follow-up, not built yet
- [x] Verified live end-to-end: backend redeployed with new bands/buffers,
      frontend redeployed with rings/basemap, no regression on the
      MapLibre worker-file fix from earlier

## Dashboard redesign + new NIFC fields (2026-07-29)
- [x] Added `percent_contained`, `fire_cause`, `complexity_level`, `state`
      fields from NIFC (data already available, just wasn't being shown) -
      new migration, ingestion upsert, API fields
- [x] Fire Detail: incident badges row (containment %, cause, complexity,
      days-since-discovery computed client-side)
- [x] Collapsible sidebar (icon-only rail), state persisted like the theme
      toggle
- [x] Map hover feedback: thicker outline highlight (feature-state) + info
      popup (name/acres/buildings) on hover - researched standard MapLibre
      patterns first, confirmed applicable, then built
- [x] Dashboard redesigned: full-width map (taller, 68vh) on top, sortable/
      filterable data table below (replacing the old side-by-side
      map+card-list layout) - sort via clickable column headers (no
      dedicated sort UI), slim filter bar (search/state/cause always
      visible, "More filters" expandable for complexity/containment-range/
      acreage-range/population-range) so the default footprint stays slim
- [x] Population column + filters wired in structurally (2400m band) even
      though data is still null pending the Census API key - correctly
      shows "Pending", not blank/zero
- [x] Removed the old artificial `slice(0, 25)` cap on the fire list, now
      that filtering is the real way to narrow the full 226-fire set

## QA pass on the live deployed site (2026-07-29)
- [x] API 404 handling verified (`/api/fires/does-not-exist` → 404)
- [x] All SPA client-side routes return 200 (`/`, `/map`, `/reference`,
      `/fires/:id`)
- [x] Confirmed exposure backfill fully caught up on Railway (224/224
      fires processed) - the "exposure pending" empty state currently has
      no live fire to exercise it against, not a bug
- [x] Real fire's `population_est: null` confirmed rendering as "Pending"
      correctly, not blank/zero
- [x] **Gap found and fixed**: the Live/Reconnecting/No-connection status
      indicator from the original plan never made it into the rebuilt
      four-page frontend - the early skeleton's simple health-check badge
      got dropped during the rebuild and was never replaced with the real
      `ingestion_status`-driven version. Built now: `GET /api/status`
      (live/reconnecting/disconnected based on last successful ingestion
      age) + a status pill in the top bar (pulsing green/amber/red),
      fail-safe to "disconnected" if the backend itself is unreachable.
      Frontend deployed; backend push still pending as of this note.

## Dashboard/table UX polish batch (2026-07-30)
- [x] **Map scroll-zoom fix**: `cooperativeGestures: true` (MapLibre's
      built-in option for exactly this) - scrolling the page with the
      mouse over the embedded map no longer hijacks the scroll as a zoom
      gesture; requires Ctrl/Cmd+scroll to zoom instead, with an on-map
      hint shown on a plain scroll attempt.
- [x] **Table decluttered**: Cause and Complexity columns removed (kept
      on Fire Detail only, where they still show) - not particularly
      NatCat-relevant for the at-a-glance table. Their sort keys and the
      corresponding filter-bar dropdowns were removed too, not just the
      column, to avoid orphaned filters for values no longer visible in
      the table.
- [x] Table horizontal scrollbar made visually obvious (thicker, themed) -
      `overflow-x: auto` was already there, but the default thin OS
      scrollbar was easy to miss entirely.
- [x] **Dashboard running totals**: buildings/population "impacted"
      (within perimeter) and "under threat" (2.4km) added as two-number
      combined cards alongside the existing Active Fires/Total Acres
      cards, rather than four separate cards. Includes a live caveat
      ("Population totals still filling in (X of Y fires processed)")
      that disappears on its own once the Census backfill finishes.
- [x] **Incident complexity explained**: NIMS Type 1-5 scale is
      counterintuitive (Type 1 = biggest/most complex, Type 5 = smallest)
      - added an info-hint on the Fire Detail badge plus a full
      explanation section in Reference.
- [x] **Reusable info-hint ("?") tooltip** - applied only where the field
      genuinely isn't self-explanatory: priority score, population
      methodology, incident complexity. Deliberately not applied to
      self-explanatory fields (acreage, dates) per explicit direction.
- [x] **Table pagination**: loads 100 rows initially, "Load 100 more"
      button below - implemented as a display-window slice over the
      already fully filtered+sorted array (filtering/sorting already
      operate over the complete in-memory list), so correctness against
      filters/sort was never at risk. Resets to the first 100 whenever
      the filtered set changes.
- [x] **Loading spinner**: replaced plain "Loading…" text with a CSS
      spinner (`PageLoading` component) on Dashboard and Fire Detail -
      some fetches take up to ~10s, worth a real indicator.
