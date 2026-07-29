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
- Explicitly parked, not planned: "evacuation routes" as a labeled feature
  - no standardized national data source exists for real evacuation
    routes; the basemap already shows roads, so a dedicated OSM-highways
    layer wasn't judged worth adding on its own. The methodologically
    real version (network/isochrone travel-time analysis) is a genuine
    future idea, not a quick add.

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
- [ ] **"Mark for acquisition" + live scene picker**: reuse the CDSE
      `search_scene()`-equivalent function from `LAwildfireSAR` to fetch
      real candidate Sentinel-1 scenes (date, track, direction) across a
      pre-fire and post-fire window. Before/after pickers shown side by
      side; picking a "before" scene filters "after" candidates to the
      same track number (falls back to same direction). Gated by the
      admin key.
- [ ] **Compute dispatch + results display** (deferred design discussion,
      not started): refactor the pipeline's download/process/composite/
      change modules to take explicit scene IDs instead of config-file
      dates; dispatch the existing `LAwildfireSAR` Docker image (Ubuntu +
      ESA SNAP) to ephemeral cloud compute once scenes are human-
      confirmed; store results (reusing `sync_to_s3.py`); surface on Fire
      Detail. Honest schedule read: roughly a week if tightly scoped — the
      science is largely reusable, the real risk is the ephemeral-compute
      dispatch mechanism itself (new infrastructure).
- [ ] Needs `CDSE_USER`/`CDSE_PASSWORD` added to `.env` — reuse the
      existing LAwildfireSAR project's CDSE account rather than creating
      a new one (already a documented placeholder in `.env.example` since
      the start of this project).

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
