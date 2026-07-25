# WildfireDashboard — Build Progress

Running checklist for Phase 1, kept up to date as we go. Not committed until
you're ready — ask to add it whenever.

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
- [ ] Database schema + Alembic migrations (confirm PostGIS support on Railway
      Postgres first; fall back to JSONB + shapely if unavailable)
- [ ] NIFC WFIGS ingestion job (15-min cadence) + scheduled prune job
      (NIFC's own fall-off thresholds: <10ac/3d, 10-100ac/8d)
- [ ] Exposure computation: one Overpass call per fire (2400m band) +
      WorldPop hosted stats API calls per band; recompute only on new fire /
      material perimeter change / staleness fallback — never on every
      ingestion cycle
- [ ] API endpoints: `GET /api/fires`, `GET /api/fires/{id}`, API-key-gated
      internal recompute trigger

## Frontend core
- [ ] Vite + React skeleton, MapLibre GL map component
- [ ] Four Phase 1 pages: Dashboard, Map, Fire Detail, Reference
- [ ] Responsive nav (sidebar desktop / bottom tab bar mobile)
- [ ] Wired to backend via `VITE_API_BASE_URL`

## Deploy
- [ ] Railway: backend + Postgres, usage alerts set ($5 soft / $10 hard)
- [ ] AWS: S3 + CloudFront, budget alerts ($5 / $10)
- [ ] Custom domain: Route53 + ACM cert wired to CloudFront
- [ ] External uptime monitor on `/health`

## Polish (near end of main phase)
- [ ] Honesty/labeling pass (dated/sourced figures, portfolio disclaimer)
- [ ] Dockerize backend
- [ ] GitHub Actions CI/CD (lint + test backend, build + S3 sync frontend)
- [ ] Unit + integration tests
- [ ] README with architecture + methodology
