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
- [ ] `frontend/`, root `README.md` skeleton

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
  - [ ] WorldPop hosted stats API — no key needed for normal use (confirmed:
        it's optional, for "larger queries and special functionality" only,
        no self-serve key registration exists anyway). But live-tested and
        found the task queue genuinely stuck (`"status":"created"` for 45+s
        with a server-side PHP warning, using WorldPop's own documented
        request format exactly) - see `DECISIONS.md`. Plan: retry later,
        keep the hosted-API approach for now; self-hosted-raster fallback
        stays on the table if this proves persistent, with a cost
        reassessment against Phase 1's US-only scope if we get there.
        `population_est` stays NULL until this is confirmed working.
  - Verified live: buildings fetched and stored in `building_cache`,
    `exposure_stats` rows written with real building counts (0 for two
    remote test fires — plausible, not yet confirmed against a
    building-dense area)
- [ ] API endpoints: `GET /api/fires`, `GET /api/fires/{id}`, API-key-gated
      internal recompute trigger

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
- [ ] Four Phase 1 pages: Dashboard, Map, Fire Detail, Reference
- [ ] Responsive nav (sidebar desktop / bottom tab bar mobile)
- [x] Wired to backend via `VITE_API_BASE_URL` (shared root `.env` via Vite's
      `envDir`)

## Deploy
- [x] Railway: Postgres provisioned, usage limits set ($5 soft alert / $10 hard cap)
- [ ] Railway: backend app itself deployed as a service (DB only so far)
- [ ] AWS: S3 + CloudFront, budget alerts ($5 / $10)
- [ ] Custom domain: Route53 + ACM cert wired to CloudFront
- [ ] External uptime monitor on `/health`

## Polish (near end of main phase)
- [ ] Honesty/labeling pass (dated/sourced figures, portfolio disclaimer)
- [ ] Dockerize backend
- [ ] GitHub Actions CI/CD (lint + test backend, build + S3 sync frontend)
- [ ] Unit + integration tests
- [ ] README with architecture + methodology
