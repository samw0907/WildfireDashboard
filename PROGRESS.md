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
- [ ] SAR frame-mosaicking: stitch two adjacent Sentinel-1 frames from the
      same track/date into one full-coverage input before RTC processing,
      instead of just ranking around partial-coverage tracks. A genuine
      fix for the structural large-fire-straddles-a-frame-boundary case
      (see `SAR_METHODOLOGY.md` §8.1), not just a workaround - meaningfully
      more complex (raster mosaicking logic in the compute pipeline, not
      picker UI), raised 2026-07-30, not in scope now.
- [x] **SAR compute runtime/cost optimization** (2026-07-31, analyzed from a
      real job's measured timings): Terrain-Flattening is ~88% of
      per-scene RTC processing time (~46 of ~52 min measured on a real
      Aspen Acres run) - everything else (download, other GPT steps) is
      noise by comparison; scene download speed is not the bottleneck.
      **Checked directly rather than left as a hypothesis**: ran
      `gpt -h` inside the actual built image - SNAP's GPT defaults to
      parallelism **20** (`-q 20`), meaning it was already trying to use
      far more threads than the job definition's original 4 vCPUs could
      offer - the container was core-starved, not under-configured.
      **Applied**: bumped the job definition from 4 vCPU/16GB to 8
      vCPU/32GB (revision 4) - a pure resourceRequirements edit, no code
      changes. Cost roughly doubles per-hour but should be close to
      cost-neutral in total if wall-clock drops proportionally (Fargate
      bills per-second); trivial in absolute dollars at this project's
      2-3-demo-fire volume either way. Compute environment's `maxvCpus`
      (already 8) needed no change. Still queued, not done (would need
      real engineering, not a settings tweak, and are lower priority
      given the above already targets the actual measured bottleneck):
      parallelizing across scenes (matters most for Composite mode's 6
      sequential scenes) and EC2 Spot-backed Batch (cheaper per hour, but
      real interruption risk on an hours-long job with no checkpointing).
      Explicitly not worth pursuing: replacing SNAP/GPT itself - would
      break direct methodological comparability with the validated
      original `LAwildfireSAR` pipeline, which is the whole point of
      reusing this stack.
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
  - [x] **Phase B — scene picker rework** (2026-07-30, done + build-tested,
        then refined same day after user caught a real gap): `AcquisitionPanel`
        shows a per-track candidate summary first (computed client-side
        from data `/candidates` already returns), best track obvious
        before touching individual scenes. Clicking a track locks it and
        filters both columns to just that track; multi-select up to the
        track's target count (3 or 1). Reduced-reliability warning shown
        automatically in Single-pair mode. Saved state shows a mode badge.
        `FireMap`'s `sceneFootprints` prop takes arrays per side and draws
        every selected scene's footprint, not just one.
        **Refinement (2026-07-30, same day)**: the first version ranked
        tracks by *count* only (3+ scenes on both sides = "Composite-
        ready") - user caught live that this can recommend a track whose
        scenes only partially cover the fire (27-73% AOI coverage in the
        real example that surfaced this), which is worse than a full-
        coverage single pair. Replaced with a 4-tier ranking: (1) Composite
        using only ≥95%-coverage scenes, (2) Single-pair using ≥95%-
        coverage scenes, (3) Composite using partial-coverage scenes, (4)
        Single-pair using partial-coverage scenes - coverage completeness
        ranked above compositing noise-robustness, since a scene that
        doesn't cover the fire can't tell you anything about it regardless
        of how many dates get averaged. Top-ranked track marked
        "Recommended," all tracks still browsable. 0%-coverage scenes now
        excluded from candidate counts entirely (bbox-touching noise, not
        real candidates). Picker pre-selects the best-covering scenes on
        the chosen track as a sensible default, user can still override.
        **Verified live against a real large fire (Aspen Acres, 101,961
        acres)**: confirms this isn't a hypothetical edge case - one track
        had 100% coverage on all scenes but only enough for Single-pair
        (correctly ranked Tier 2/Recommended), another had enough scenes
        for Composite by count but only 27-73% coverage each (correctly
        ranked Tier 3, below the single-pair option) - exactly the
        large-fire-straddling-a-frame-boundary scenario anticipated in
        `SAR_METHODOLOGY.md`. Frame-mosaicking (stitching adjacent frames
        from the same track/date into one full-coverage input) logged as a
        genuine future technique, not in scope now.
  - [ ] **Flagged for a follow-up review pass later** (2026-07-30): user is
        happy with Phases A/B for now but wants the whole mark-for-
        acquisition + picker flow re-checked once Phases C-E exist and
        there's an end-to-end real result to test against - not signed off
        as final yet, revisit before considering this feature complete.
  - [x] **Phase C — pipeline adaptation** (2026-07-30, written + partially
        verified — **not yet run for real, see caveat below**): new
        `sar-compute/` directory at the repo root (self-contained, own
        Dockerfile/requirements.txt, adapted copies of the pipeline
        modules — does not modify or depend on the separate
        `LAwildfireSAR` repo, which stays untouched as its own portfolio
        piece). `entrypoint.py` takes only `FIRE_ID` as input and fetches
        everything else (perimeter, selected scenes, mode) live from the
        main backend's own public API (`GET /api/fires/{id}` and
        `GET /api/fires/{id}/acquisition`) — no track search/selection
        happens here, a human already picked exact scenes via the picker.
        Flow: `download.py` (simplified — no `search_scene`/
        `select_orbit_direction`, just downloads the exact CDSE product
        IDs already chosen) → `process.py` (RTC via pyroSAR/SNAP,
        unchanged core `geocode()` params from the original) →
        `composite.py`'s median build *only in Composite mode* (Single-
        pair mode skips straight to change detection using the lone RTC
        output per side) → `change.py` (unchanged core math — log-ratio,
        VV+VH combined magnitude, threshold, minimum-mapping-unit filter
        — but now clips to the fire's real perimeter *polygon* via
        `rasterio.mask`, not a rectangular bbox like the original's
        two-fire `combined_bbox`) → `buildings.py` (classifies against
        this fire's already-cached OSM footprints, fetched from the same
        `GET /api/fires/{id}` response the frontend uses — no new
        building-data pipeline; fixed 2.9 dB / 1.74 dB thresholds,
        explicitly marked `"threshold_validated": false` in the output
        JSON itself, not just in docs) → **`validate.py` has no
        equivalent at all** (no ground truth exists for a live fire) →
        writes a compact `result_summary.json` (mode, burn area, damage
        counts, honesty notes) plus the full GeoJSON/raster outputs →
        syncs all of it to S3 under `acquisitions/{fire_id}/` (adapted
        from `sync_to_s3.py`, using the Fargate task's IAM role via
        boto3's default credential chain instead of explicit AWS keys).
        UTM zone for RTC processing is now computed per-fire from its
        centroid longitude (the original hardcoded `EPSG:32611` for LA
        specifically) — **verified this independently reproduces
        `EPSG:32611`** when fed Eaton fire's real coordinates, and
        correctly produces zone 13 for a real Colorado fire's actual
        centroid (queried live from `building_cache`/`fires` tables).
        Also verified the real cached OSM buildings data
        (`building_cache.buildings`) is a valid GeoJSON FeatureCollection
        of real Polygons - the exact shape `buildings.py`'s
        `fetch_osm_buildings()` expects.
        **Honest caveat, not glossed over**: none of `download.py`/
        `process.py`/`composite.py`/`change.py`/`buildings.py` have been
        run for real - that needs the actual Docker image built (ESA SNAP
        install, ~hours) and a real multi-hour job, which is Phase D/the
        "first real test run" territory, not something verifiable in this
        environment (no SNAP, no rasterio/geopandas/pyroSAR installed
        outside the image itself). Verified everything that *could* be
        verified without that: Python syntax on every new file, the
        UTM-zone math against two independent real fire locations, and the
        real OSM building data's shape against what the code expects.
  - [x] **Phase D — AWS infrastructure** (2026-07-31, live and verified):
        ECR repo (`wildfiredashboard-sar-compute`) built and pushed; two
        IAM roles (`wildfiredashboard-sar-execution` — pull image + write
        logs + read the CDSE secret; `wildfiredashboard-sar-task` — S3
        read/write on the results bucket only); Batch compute environment
        (`wildfiredashboard-sar-compute-env`, Fargate, 3 public subnets)
        + job queue (`wildfiredashboard-sar-queue`) + job definition
        (`wildfiredashboard-sar-job`, 4 vCPU/16GB, 1 retry attempt, 6h
        hard timeout as a cost-safety cap); S3 results bucket
        (`wildfiredashboard-sar-results-497537671259`, public access
        blocked, SSE-S3 encrypted); CloudWatch log group
        (`/wildfiredashboard/sar-compute`, 30-day retention); CDSE
        credentials in a Secrets Manager secret
        (`wildfiredashboard/sar/cdse-credentials`), injected into the
        container via the job definition's `secrets` field (never a
        plaintext env var); `/confirm` now calls `batch.submit_job()`
        synchronously and surfaces failures immediately (502) instead of
        silently sitting in `'confirmed'`; new `sar_batch.py` polling loop
        (same `asyncio` pattern as ingestion/exposure/alerts, 2-minute
        cadence) checks `describe_jobs()` and moves fires to
        `'complete'`/`'failed'`, pulling `result_summary.json` from S3 on
        success. All infrastructure confirmed healthy live (compute env +
        job queue both `VALID`/`ENABLED`, job definition ACTIVE).

        **Real bugs hit and fixed along the way** (all in
        `sar-compute/Dockerfile`, none previously testable without an
        actual build):
        - `python3.11` doesn't exist on Ubuntu 24.04 (ships 3.12 as
          `python3`) — switched to the distro's native package.
        - Ubuntu 24.04's system pip refuses unmanaged installs (PEP 668)
          — added `--break-system-packages` (safe here; single-purpose
          container, not a dev environment).
        - The SNAP installer URL inherited from `LAwildfireSAR` (10.0)
          404s — ESA had moved on to 13.0.0 with a renamed installer
          path. **Open item**: the original pipeline's RTC processing was
          only validated against SNAP 10.0's GPT operators; the version
          jump hasn't been independently re-verified to behave
          identically — worth a sanity check on the first real output.
        - `gdal-bin` hard-depends on `python3-gdal`, which apt installs
          its own numpy for for; pip couldn't uninstall it (no RECORD
          file) when resolving the pinned `numpy==2.4.2` — fixed with
          `--ignore-installed`.
        - GDAL's Python bindings are C++, not C — needed `g++` (and
          `gcc` for psycopg2), neither present in a minimal base image.
        - Job definition's Secrets Manager `valueFrom` initially omitted
          the random 6-character suffix AWS appends to every secret ARN
          — ECS/Batch's secret resolution requires either the *exact*
          full ARN or the bare secret name, not a partial one. Caught
          before any job ran, by describe-secret-ing the real ARN and
          diffing against what the job definition had; fixed by
          re-registering the job definition (revision 2).
        - The deployer's inline IAM policy hit AWS's hard 2048-character
          limit as it grew — converted to a standalone customer-managed
          policy (6144-char limit) instead, same permissions.
  - [x] **Phase E — results display** (2026-07-31, built, not yet tested
        against a real result): two new columns
        (`acquisition_burn_perimeter`, `acquisition_building_damage`)
        store `burn_perimeter.geojson`/`building_damage.geojson` verbatim,
        fetched by the same polling loop that already pulls
        `result_summary.json` on `SUCCEEDED` - no presigned URLs or S3
        proxy endpoint needed, matching the existing pattern.
        **Real bug caught before any real job ran**: both files were
        being written in the per-fire UTM CRS (the RTC processing working
        projection), not EPSG:4326 like every other geometry on this map
        (fire perimeters, OSM buildings) - fixed in `change.py`/
        `buildings.py` to reproject to WGS84 right before writing, and
        the already-pushed image was rebuilt and repushed with the fix
        (cache made this near-instant - only the `pipeline/` COPY layer
        needed to redo). `AcquisitionPanel.tsx` now renders per-status:
        marked (unchanged) → processing (spinner, auto-polls every 2
        minutes to match the backend's own cadence, so the tab doesn't
        need to stay open or be manually refreshed) → complete (burn
        area/patch count/buildings-assessed stat cards, a damage-class
        breakdown table, and the threshold/building-dataset honesty notes
        rendered verbatim from `result_summary.json`, not re-worded) →
        failed (error message + Retry button that resubmits via the same
        `/confirm` endpoint). `FireMap.tsx` gained two new overlay layers
        (burn perimeter fill, building-damage fill colored by
        `damage_class` - destroyed/possibly_affected/no_damage/no_data/
        geometry_limited each get a distinct color) with a legend
        alongside the existing scene-footprint one. Frontend build and
        backend imports both verified clean.
  - [ ] **First real end-to-end attempts (2026-07-31, Aspen Acres,
        Single-pair mode)** — three real bugs found and fixed, none
        hypothetical:
        1. GDAL's Python bindings linked against the wrong numpy ABI at
           build time (Dockerfile installed GDAL before `requirements.txt`'s
           numpy==2.4.2) — crashed on the very first import. Fixed by
           installing numpy first, GDAL last (`--no-deps` so it doesn't
           re-pull numpy itself).
        2. CDSE's access token was fetched once upfront and reused for
           every scene download - but RTC processing (~30-50 min/scene,
           mostly the Terrain-Flattening step) outlasts the token's
           lifetime, so later scenes 401'd. Fixed: fetch a fresh token
           immediately before each scene's download, not once for the
           whole job.
        3. **Ran out of disk mid-job**: `java.io.IOException: No space
           left on device` writing the second scene's RTC output - Fargate
           defaults to 20 GiB ephemeral storage, nowhere near enough for
           multiple scenes' raw downloads + RTC intermediates + SNAP's own
           tile cache (the original pipeline's own docs note "tens of GB"
           for a full multi-scene run). Fixed: job definition now requests
           100 GiB (`ephemeralStorage.sizeInGiB`), registered as revision
           3 - negligible cost impact (ephemeral storage beyond the free
           20GiB tier is billed at a fraction of a cent per GB-hour).
        With all three fixed, the retry **succeeded end-to-end** (Aspen
        Acres, Single-pair mode) - first real result. Also applied the
        8vCPU/32GB job definition change discussed separately (revision
        4) - Terrain-Flattening dropped from ~46 min to a measured
        **23 min**, a clean ~2x, better than the conservative 60-75%-
        efficiency estimate given beforehand.

        **Real methodology finding from inspecting the actual result**
        (2026-07-31, caught by the user loading the raw output in QGIS,
        not by anything in the pipeline itself): a meaningful number of
        buildings **outside the fire's own perimeter** were classified
        "destroyed." Root-caused in the code, not assumed: building
        damage classification (`buildings.py`) was sampling
        `change_combined.tif` - the **unclipped, whole-scene** change
        raster - for every building in the cached 2,400m exposure buffer,
        with nothing scoping the check to the fire itself. A building
        2km+ from the fire showing "destroyed" was a real measurement,
        just of unrelated real change (most likely seasonal snowmelt or
        soil-moisture difference between the June 17 → July 17 dates,
        possibly an unrelated fire elsewhere in the same ~250km scene -
        this is the "vegetation/burn-scar confound" gap already flagged
        as unaddressed in `SAR_METHODOLOGY.md` §5, now seen concretely).
        **Fixed**: `change.py` now also writes the perimeter-*clipped*
        combined raster (`change_combined_clipped.tif`) and building
        classification samples that instead - a building outside the
        perimeter has no methodological basis for a fire-attribution
        claim regardless of what real change is measured there. Chose a
        strict clip (not perimeter+buffer) specifically because the
        confound isn't distance-based - a buffered building just outside
        the fire's edge is exposed to the same snowmelt/soil-moisture
        noise as one further away, not meaningfully protected by
        proximity. Image rebuilt and repushed with this fix; not yet
        re-verified against a real re-run.
        **Also flagged, not yet acted on**: the raw `burn_patch_count`
        (2,106 in the Aspen Acres run) is a misleading headline number on
        its own - one patch was 35,699 ha (97% of total detected area,
        plausible given the fire's real ~41,264 ha scale) and the other
        2,105 were speckle noise (median 0.16 ha, barely above the 0.1 ha
        minimum-patch filter) - exactly what Single-pair mode's lack of
        despeckling would be expected to produce, not a bug, but worth
        presenting more honestly than a raw count once the figures/UI
        pass (below) happens.

        **Second real run, a different fire near Boise, ID (2026-07-31),
        confirms the perimeter-clipping fix worked exactly as intended**:
        `building_damage_counts` went from Aspen Acres' 1,059 "destroyed"
        out of 3,244 (33%, dominated by out-of-perimeter false positives)
        to just **2 "destroyed" out of 8,011**, with 7,952 correctly
        landing in `no_data` (outside the clipped raster's extent, no
        longer spuriously classified). Also the first real run with
        figures reinstated (`pipeline/figures.py`, matplotlib/contextily):
        all three (overview map, damage zoom map, backscatter panel)
        generated successfully and were visually verified as real,
        correct output - basemap tiles fetched live, perimeter/damage
        geometry aligned correctly, backscatter imagery and the
        change-magnitude heatmap both rendered as expected.

        **Real bug caught testing the new download endpoint** (not
        hypothetical - reproduced and root-caused before fixing):
        `GET /api/fires/{id}/acquisition/download/{filename}` returned a
        presigned S3 URL that failed with `SignatureDoesNotMatch` when
        fetched. Cause: `boto3.client("s3", region_name=...)` still
        defaults to the *global* `s3.amazonaws.com` endpoint even with
        `region_name` set; S3 replies to that with its own 307 redirect
        to the real regional endpoint for a non-us-east-1 bucket - fine
        for a normal signed request (botocore transparently re-signs and
        retries), fatal for a *presigned* URL, since the signature is
        baked in for whoever fetches it later and a changed `Host` header
        invalidates it on the second hop. Fixed by passing an explicit
        `endpoint_url=f"https://s3.{region}.amazonaws.com"` when building
        the client used for presigned URLs specifically. Verified fixed
        by reproducing the exact failure locally, then confirming the
        corrected client produces a URL that actually fetches (200, valid
        PNG) before considering it done.

        **Real bugs found visually reviewing the actual rendered figures**
        (2026-08-01, user inspected the live site): (1) `make_overview_map`
        never received `burn_gdf` at all - the burn-area fill only ever
        rendered on the zoomed figure, so the overview showed just a bare
        perimeter outline. (2) The "zoomed" figure's bounds came from the
        *full* cached building set (the whole 2,400m exposure buffer -
        often much wider than the fire itself, in one case wide enough to
        include all of Boise), not anything fire-specific, so it wasn't
        meaningfully zoomed to anything. (3) The burn-area fill was
        rendered with no matching legend entry on either figure - a real,
        clearly-visible color with no explanation in the key. **Fixed**:
        overview map now plots `burn_gdf` too; the zoom map now zooms to
        the burn area's own bounds (falling back to classified buildings,
        then the full perimeter, if no burn was detected at all); a "Burn
        area detected" legend swatch (opacity-matched to the actual fill)
        was added to both; `no_data` buildings (now the overwhelming
        majority of the cached set, per the perimeter-clipping fix above)
        are no longer plotted at all - they added visual noise without
        conveying anything. Verified against the real Boise fire's actual
        S3 output (not just re-reading the code) before pushing: reran
        both figure functions inside the built image against the genuine
        `burn_perimeter.geojson`/`building_damage.geojson` from that run
        and visually confirmed the fill, legend, and zoom bounds all now
        look correct.
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

## Population methodology: dasymetric (building-weighted) redistribution (2026-08-01)
Real bug found by the user reviewing a real fire's page: a fire with only 3
buildings in its perimeter showed a population estimate of 564 - the
areal-weighted method (`population × fraction of block group area inside
the buffer`) assumes population is spread uniformly across a whole block
group polygon, which breaks badly when a fire's buffer clips a mostly-empty
sliver of a large, sparse rural block group whose real population lives
elsewhere within that same polygon.
- [x] **Replaced with dasymetric (building-weighted) redistribution**:
      for every block group overlapping a fire's buffer, fetch its real
      OSM building count, divide its Census population evenly across
      those buildings, then only count buildings that actually fall
      inside a given buffer band - population now follows real habitation
      proxies, not raw land area. Not an invented technique - this is the
      standard academic/GIS answer to exactly this failure mode, and the
      same underlying idea (settlement-weighted redistribution) behind why
      WorldPop's gridded data would have handled this case better than
      plain areal weighting, back when WorldPop vs. Census was first
      decided (see `DECISIONS.md`).
- [x] **Real engineering cost, not a formula tweak**: needed each block
      group's *total* building count, not just the portion already cached
      within the fire's 2,400m buffer (block groups routinely extend well
      beyond it in sparse terrain) - a genuinely wider Overpass fetch.
      **Optimized before shipping**: rather than one Overpass call per
      overlapping block group (real risk of many extra round-trips for a
      large fire spanning many block groups), fetches every relevant block
      group's buildings in a single combined-bbox call, then filters the
      same candidate set locally per block group - safe since block
      groups are a non-overlapping partition by construction. Exactly one
      additional Overpass call per fire recompute, not N.
- [x] **Fallback preserved for a real data gap**: a block group with
      Census population but zero OSM buildings mapped at all falls back to
      the original areal-weighted method for that specific block group -
      dasymetric weighting has nothing to distribute against otherwise.
      This makes the final result a genuine hybrid, not a clean
      replacement - documented as such on the Reference page, not glossed
      over.
- [x] **Verified with synthetic tests before deploying** (no real block
      group/building data can be constructed by hand at this precision, so
      this was checked with controlled geometry, not a live fire): a 3-of-
      20-buildings-in-buffer case produced the exact expected proportional
      result (84.6 = 564 × 3/20); the zero-buildings fallback path
      produced a result consistent with the pre-existing (unchanged)
      areal-weighting code; the single-combined-query optimization was
      checked against two non-overlapping synthetic block groups with a
      mocked Overpass response and produced the correct per-block-group
      split (2 and 1 buildings respectively) from one combined fetch.
- [x] Reference page's population methodology section rewritten to
      describe the new approach and its own remaining honest limitations
      (not every OSM building is residential; rural tagging is often too
      inconsistent to filter to just houses; a block group with real
      population but zero mapped buildings still uses the older areal
      method) - not just swapped the formula without updating the
      explanation.
- [ ] **Not yet verified against a real fire's real data** - this rolls
      out gradually as each fire's exposure cache naturally goes stale
      (24h fallback) or its perimeter changes, not instantly for every
      already-computed fire. The user can force an immediate recompute on
      a specific fire via the existing `POST /api/fires/{id}/recompute`
      (their own `RECOMPUTE_API_KEY`, never seen by this session) to
      verify the exact fire that surfaced the original bug.

## ACS vintage bump + priority score redesign (2026-08-01)
Prompted by a broader "are there other similar methodology issues" review
requested after the population fix above - two real findings, both acted
on together:
- [x] **Census ACS vintage bumped from 2022 to 2024** - had been silently
      hardcoded and never revisited. Confirmed live that the 2024 vintage
      is genuinely published (real dataset metadata at
      `api.census.gov/data/2024/acs/acs5.json`, not just a placeholder -
      couldn't verify actual row-level data without a real
      `CENSUS_API_KEY`, since only metadata endpoints are public). Low
      risk either way: the existing graceful-degrade logic already leaves
      `population_est` null for a cycle on any Census API failure, so an
      incomplete vintage would fail the same safe way, not silently.
- [x] **Priority score reweighted, from 25/25/50 to 20/20/40, plus two
      new components** - discussed and agreed before building:
      - **Exposure cut from 25/25 to 20/20** (building/population) -
        population is now itself building-weighted (see the dasymetric
        change above), so the two are no longer as independent a pair of
        signals as they were - reduced combined weight reflects that
        rather than silently double-counting.
      - **Containment added (up to 20 pts, inverted)** - `20 × (1 -
        percent_contained/100)`, so an uncontained fire scores higher
        than an equally-sized contained one, matching the "uncontained =
        bigger ongoing concern" reasoning already logged back when this
        was first floated (2026-07-29) as a future refinement needing a
        null-handling strategy. Missing `percent_contained` now
        deliberately defaults to 0% (fully uncontained, maximum urgency)
        - the same "don't understate risk from a data gap" bias already
        used elsewhere in this project, not a neutral guess.
      - **Red Flag Warning bonus added (+5 flat)** - reuses the RFW zone
        check already computed for the per-fire badge
        (`fires_in_active_warnings`), now passed into
        `compute_priority_scores` too instead of being computed twice.
      - **Deliberately NOT added**: NIMS incident complexity type (1-5) -
        judged too redundant with the acreage/scale component already
        present (both are largely proxies for "how big/serious," and
        adding complexity as a second scored input risked the exact
        double-counting mistake being corrected in exposure above). Still
        shown as its own badge, just not folded into the score.
      - **Deliberately NOT added**: raw wind speed or rain forecast -
        discussed and rejected: wind *direction* relative to exposure
        matters more than speed alone (real geometry this tool doesn't
        compute), a forecast is a prediction not a current condition, and
        properly modeling fire-weather risk is a genuine research problem
        (same category already ruled out of scope for orbit selection),
        not something an additive score term can honestly approximate.
      - **Final score capped at 100** - the RFW bonus can occasionally
        push an already-maxed fire past the nominal range otherwise.
      - **Verified with synthetic fires before shipping** (isolated each
        component in turn): confirmed containment 0%-vs-100% produces
        exactly a 20-point gap at equal acreage; `None` containment
        behaves identically to 0%; the RFW bonus adds exactly +5; a
        maxed-out fire with an RFW bonus correctly caps at 100.0, not
        105.0.
      - Reference page's priority-score section rewritten to describe the
        new formula and explain both "why cut exposure" and "why these
        two things were deliberately left out," not just the new numbers.

## Multi-acquisition support: real history table + tabbed UI (2026-08-01)
Resolved the backlog item below by actually building it, once discussed.
See DECISIONS.md "Multi-acquisition support" for the full design
reasoning. Summary of what changed:
- New `acquisitions` table (migration `5e6f2ea48eea`), one row per
  attempt per fire, keyed by `fire_id` + `sequence` (1-indexed). Replaces
  the old single-slot `acquisition_*` columns on `Fire`, which are now
  dropped; any existing acquisition per fire is preserved as sequence=1.
  A never-confirmed draft is deleted outright on unmark, not reset to
  nulls - row existence now always means a real attempt was made. Only
  one non-terminal (`marked`/`processing`) acquisition allowed per fire
  at a time, enforced server-side.
- `routers/acquisition.py` rewritten around sequence-scoped endpoints:
  `GET/POST /fires/{id}/acquisitions`, `GET/POST .../acquisitions/{seq}`
  + `/select`, `/confirm`, `/unmark`, `/download/{filename}`,
  `/download-all`. `sar_batch.py`'s poller and `batch.py`'s
  `submit_sar_job` both updated to key off `Acquisition` rows instead of
  `Fire` columns, passing `ACQUISITION_SEQUENCE` to the Batch job
  alongside `FIRE_ID`.
- S3 layout changed from `acquisitions/{fire_id}/{filename}` to
  `acquisitions/{fire_id}/{sequence}/{filename}` (`s3_sync.py`,
  `entrypoint.py`) - the old flat layout would have silently overwritten
  an earlier run's results the moment a fire got acquired twice.
- Candidates endpoint now annotates every scene with `previously_used`
  (which prior acquisition(s) on this fire already selected it, as
  before/after-ignition, plus that acquisition's status) - retrigger flow
  is a fully fresh pick every time (no scene selection carried forward
  automatically), but a human can now see prior usage and deliberately
  reuse or avoid a scene instead of picking blind.
- `AcquisitionPanel.tsx` rewritten as a tab strip - one tab per past
  acquisition (label: sequence + before→after date range + status
  badge), a "+ New" tab disabled while any acquisition is non-terminal.
  Scene-picker labels changed from "Before"/"After" to "Before
  ignition"/"After ignition" throughout for clarity.
- Also fixed a real crash found on the live site: `AcquisitionPanel`
  threw `Cannot read properties of undefined (reading 'overview_map')`
  on Aspen Acres specifically - its stored result predates the `files`
  manifest field added earlier this build (Kaiser Canyon had no result
  yet at all, so it never hit the code path). `files` is now typed
  optional and defaulted to `{}` at every use site; a completed
  acquisition with no manifest now shows a plain "predates figure/
  download support" note instead of crashing the page.
- Scene footprints map layer: now auto-hides and the map re-fits to just
  the fire perimeter the moment scenes are confirmed (`FireMap.tsx`'s new
  `scenesConfirmed` prop + `sceneFootprintsVisible` state), since
  footprints matter most during picking - still toggleable back on
  manually via a new `scene-footprints-toggle` checkbox.

## Regression found + fixed: S3 path change broke an existing fire's downloads (2026-08-01)
While spot-checking whether the multi-acquisition migration had deleted
anything (it hadn't - see below), found a real regression the S3 path
change itself introduced: the Idaho fire's (`C255B5C1-...`) Acquisition #1
had a complete, working `files` manifest (RTC rasters, figures, GeoJSON)
from before today's session - but its actual S3 objects still sat at the
*old* flat path (`acquisitions/{fire_id}/{filename}`), while the new
download endpoints now look under `acquisitions/{fire_id}/{sequence}/`.
Every download link and inline figure on that fire's page would have
404'd. Fixed by moving all 11 of that acquisition's S3 objects to the new
`.../1/` path (small files via `aws s3 mv`; the 4 large rasters needed
`aws s3api copy-object --tagging-directive REPLACE` instead, since the
deployer IAM user lacks `s3:GetObjectTagging` and plain `mv`/`cp` on
objects it can't read tags from fails) - verified sizes matched exactly
before deleting the old-path originals. No code change needed; this was a
one-time data migration to match the new convention. Confirmed via S3 and
the live API afterward that the manifest resolves correctly again.

Separately confirmed nothing was deleted by today's schema migration:
Aspen Acres' Acquisition #1 shows "predates figure/download support" not
because anything was removed, but because that run genuinely happened
before `entrypoint.py` started writing a `files` manifest at all (it's
literally the very first successful run this build, from before the
buildings-perimeter-clip fix - the 1059/3244 "destroyed" count on display
is the exact pre-fix bug value). Its 600MB of raw S3 output is still
sitting at the old flat path, untouched, orphaned rather than deleted.

## Frontend copy audit: standalone-project framing (2026-08-01)
Found a real, repeated framing problem across the SAR result honesty
notes: they named an external sibling project ("LAwildfireSAR"), a named
external company's dataset ("Microsoft's building footprints"), and a
specific external validation study ("CAL FIRE DINS ground truth, two
Southern California WUI fires") - all fine as internal engineering
attribution (kept as-is in code comments/SAR_METHODOLOGY.md/DECISIONS.md,
which are genuinely about this codebase's real lineage), but wrong on the
live site, which should read as this project justified on its own terms,
not as "inherited from elsewhere, not independently validated" against a
benchmark this project never claimed to run. Also dropped "validated"/
"not independently validated" language generally - this pipeline was
never designed to include a validation step against ground truth, so
flagging its absence repeatedly mischaracterizes it as a missing step
rather than a deliberate scope boundary.
- `sar-compute/entrypoint.py`: `threshold_note`/`building_dataset_note`
  rewritten to describe this project's own threshold/dataset choices and
  their real limitations (fixed threshold applied uniformly; OSM's
  regional coverage gaps and generic tagging) without naming any other
  project, company, or study. Dropped the now-pointless `threshold_validated`
  boolean (always `False`, never actually rendered).
- `AcquisitionPanel.tsx`: the wrapping prose around `threshold_note`
  rewritten to match (no more "inherited from a prior fire's calibration").
- `Reference.tsx`: removed the "F1 score ≈0.80 (validated conditions)"
  stat card and its Microsoft/California-fires honesty-warning-card
  entirely - that number's whole provenance was the external validation
  study being removed, so displaying it (with or without a caveat) no
  longer has an honest home on this page. Replaced with a plain warning
  card describing the fixed-threshold/OSM tradeoff on its own terms.

## Add: permanent delete for individual acquisitions (2026-08-01)
Raised directly by the Aspen Acres investigation above - that stale,
buggy, pre-fix run is a good first real deletion candidate, and there
was no way to actually remove one short of manual AWS CLI/DB work.
- `DELETE /api/fires/{fire_id}/acquisitions/{sequence}` (admin-gated):
  deletes every S3 object under that acquisition's own
  `acquisitions/{fire_id}/{sequence}/` prefix, then the DB row. Rejected
  with 400 while status is `processing` - a live Batch job would keep
  running with nothing left to report its result to. Unlike `unmark`
  (drafts only), this works for any terminal status, since it's for
  deliberately discarding a real, finished (or failed) run, not just
  abandoning an unconfirmed draft.
- Frontend: a small trash icon on each acquisition tab (disabled + tooltip
  while processing), gated behind a new `ConfirmDialog` component - a
  plain in-page modal, not `window.confirm()`, for the same reason
  `AdminKeyModal` avoided `window.prompt()` earlier in the build (embedded
  browser views like VSCode's preview pane silently no-op native browser
  dialogs). Deletion is permanent with no undo, so the dialog says so
  explicitly before the request fires.

## Backlog: multi-acquisition UX per fire (2026-08-01, raised, then resolved same day)
Current schema/UI assumes exactly one acquisition in flight per fire ever
(`acquisition_status` etc. are columns on `Fire` itself, not a history
table - see the original Phase A schema decision in `DECISIONS.md`). Real
open questions raised, not yet resolved: what happens when a user wants to
run a *second* acquisition on the same fire (it's still active weeks
later, conditions have changed)? Should the UI show a tab/list to flick
between past acquisitions on one fire, and how should each one be labeled
(date? scene dates? sequence number?) so they're distinguishable? Should
"confirm & proceed" ever be re-offered as a one-click retrigger of the
*exact same* scene selection, or does that risk being wrong once the fire
has moved on and different scenes would now make more sense? Whatever the
answer, it likely means `acquisition_before_scenes`/`acquisition_result`/
etc. need to become a real history (a new table, keyed by fire + sequence
or timestamp) rather than mutable columns on `Fire` - a genuine schema
migration, not a quick UI add. Needs its own proper design discussion
before touching any code.

**Resolved same day** - see "Multi-acquisition support" above.

## UI/UX polish round (2026-08-01)
Five small, independent fixes to the Fire Detail page, raised together
after reviewing the live site:
- **Building footprints as a map layer** - `FireMap.tsx` gained a new
  `buildings` prop (already-fetched OSM data, the same cache the
  building-count stat cards use - see `FireDetail.tsx`), rendered as its
  own source/fill/line layer pair in a single flat slate-blue-gray color
  (`#475569`), deliberately distinct from every other hue family already
  on the map (buffer gradient, alerts, scene footprints, burn area,
  damage classes). Default-on per request; a `buildings-toggle` checkbox
  lets it be hidden. Single color is deliberate - which buffer ring a
  building sits inside already tells you its band, so per-band coloring
  would be redundant.
- **Wind indicator/RFW toggle overlap fixed** - both were positioned
  identically at `top: 12px; right: 12px` (a literal DOM collision).
  Wind indicator moved to the top-left (`App.css`); the new buildings
  toggle stacks directly below the alerts toggle on the top-right
  (`top: 54px`) so all three now have distinct positions.
- **Auto-unmark abandoned acquisitions** - `AcquisitionPanel.tsx` now
  calls the existing `unmark` endpoint automatically (via an effect
  cleanup keyed on `fireId`, reading the latest status through a ref) any
  time the component unmounts or the fire changes while status is
  `'marked'` and `confirmed_at` is still null - i.e. a draft that was
  never confirmed. Anything already confirmed (`processing`/`complete`/
  `failed`) is left untouched; those are real submitted jobs, not drafts.
- **Clear "no post-ignition imagery yet" message** - when candidate
  scenes load and *every* after-side scene has zero AOI coverage (a real,
  increasingly common case for very recently discovered fires, since
  Sentinel-1 revisits every ~6-12 days per track), the track/scene picker
  is now replaced with a plain explanatory message instead of presenting
  a picker with an unfillable "after" column.
- **Better processing-time estimates** - replaced the flat, inaccurate
  "Composite mode typically takes 1-3 hours" line with a
  `processingEstimate()` helper keyed on actual mode: Single-pair
  (measured, ~45-100 min end-to-end, based on real ~20-50min/scene RTC
  runs on the current 8vCPU job def) vs. Composite (reasoned, not yet
  measured directly - ~2.5-4 hours, extrapolated from 3x the scene count
  through the same RTC bottleneck). Both explicitly flagged in the UI
  copy as measured vs. estimated so the honesty distinction carries
  through to the user, not just internally.
