# WildfireDashboard

A live, on-demand dashboard tracking current US wildfires and estimating
the buildings and population near each fire's perimeter. Portfolio
project — not an operational emergency response tool.

**Live**: https://d3qmrxoydtsnh7.cloudfront.net
**API**: https://wildfiredashboard-production.up.railway.app (see `/docs` for interactive API docs)

## What this is

Most open wildfire tools stop at "where is the fire." This one adds the
part that actually matters for response prioritization: what buildings and
population are near or within a fire's perimeter, at three buffer
distances (500m / 1,000m / 2,400m). It's the differentiator over similar
open-source hotspot-mapping projects, which generally don't do exposure
analysis at all.

This is a genuine live web app — separate from the rest of the portfolio's
batch analytical pipelines (SAR flood mapping, wildfire building-damage
assessment, deforestation monitoring), built specifically to show a
different skill set: API design, frontend/backend separation, and cloud
deployment, alongside the existing geospatial-analysis depth.

## Architecture

- **Frontend**: React + Vite, MapLibre GL JS, hosted on AWS S3 + CloudFront
- **Backend**: FastAPI (Python), hosted on Railway
- **Database**: PostgreSQL (Railway), JSONB geometry columns + shapely for
  spatial math — see `DECISIONS.md` for why PostGIS wasn't used despite
  being available
- Background jobs (NIFC ingestion every 15 min, exposure recomputation)
  run as asyncio tasks inside the FastAPI process, not a separate worker

## Data sources

- **Fire perimeters**: [NIFC WFIGS Current Interagency Fire Perimeters](https://data-nifc.opendata.arcgis.com/datasets/nifc::wfigs-current-interagency-fire-perimeters) — US only
- **Building footprints**: OpenStreetMap via the Overpass API
- **Population estimates**: US Census Bureau — [TIGERweb](https://www.census.gov/data/developers/data-sets/TIGERweb-map-service.html) block group geometries + [ACS 5-Year](https://www.census.gov/data/developers/data-sets/acs-5year.html) population, areal-weighted against each buffer

Full plain-language methodology is on the app's Reference page.

## Status

Phase 1 (exposure/impact) is live and deployed. One known gap: population
estimates are currently `null` — the Census population lookup is built
and its geometry half is verified live, but the ACS Data API key was only
just requested and hasn't arrived yet (see `DECISIONS.md`).

Phase 2 (Sentinel-1 SAR confirmation) and Phase 3 (wind/fuel risk) are
documented but not started.

## Local development

```bash
# Backend
cd backend
python -m venv .venv
.venv/Scripts/activate  # or source .venv/bin/activate on macOS/Linux
pip install -r requirements.txt
uvicorn app.main:app --reload

# Frontend (separate terminal)
cd frontend
npm install
npm run dev
```

Copy `.env.example` to `.env` at the repo root and fill in `DATABASE_URL`
(a Postgres instance — Railway or local) at minimum.

## Project history

- `PROGRESS.md` — step-by-step build checklist, what's done and what's next
- `DECISIONS.md` — every design decision with real alternatives: the
  reasoning, the options considered, and why each call was made
