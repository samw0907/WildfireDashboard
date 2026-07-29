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

## Polish (near end of main phase)
- [ ] Honesty/labeling pass (dated/sourced figures, portfolio disclaimer)
- [ ] Dockerize backend
- [ ] GitHub Actions CI/CD (lint + test backend, build + S3 sync frontend)
- [ ] Unit + integration tests
- [x] README core content written early (not deferred - useful throughout
      the build, not just at the end); final pass once WorldPop/custom
      domain/etc. are resolved to update the "Status" section

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
