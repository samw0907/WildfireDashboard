# WildfireDashboard — Design Decisions Log

Every decision here that involved real options and tradeoffs, in the order
they came up. Not a changelog of code changes — see git history for that.
This is the "why," kept separate from the day-to-day build checklist in
`PROGRESS.md` specifically so it's easy to revisit later (e.g. for
interview prep, or before touching something that was decided for a
non-obvious reason).

---

## Ingestion cadence vs. exposure recompute cadence (2026-07-25, planning)
**Issue:** The original plan didn't explicitly separate "refresh fire
perimeters" (cheap) from "recompute exposure" (Overpass + WorldPop calls,
expensive). Running both on the same 15-min cycle for every active fire
would mean ~9,300 Overpass calls/day for just 97 fires — blowing the "one
call per fire" cost model and risking the shared public Overpass instance
rate-limiting or banning the whole site.
**Decision:** Decoupled. NIFC ingestion runs every 15 min. Exposure
recompute only runs for a fire that's new, has a changed perimeter since
last computed, or has passed a staleness fallback window — never on every
ingestion cycle. See `fires_needing_recompute()` in `exposure.py`.

## Railway budget enforcement (2026-07-25/28)
**Issue:** An alert-only budget doesn't stop an unexpected bill or a
mid-month suspension — unacceptable given the site must work instantly for
a cold recruiter visit.
**Options:** (a) soft alert only, (b) soft alert + hard spend cap.
**Decision:** Both — $5 soft alert (email only), $10 hard cap (workloads
taken offline). Confirmed Railway's Hobby plan genuinely supports this via
the workspace "Set Usage Limits" page (not Pro-only, as one source
ambiguously suggested). Set live in the Railway dashboard 2026-07-28.

## AWS budget enforcement (2026-07-28)
**Issue:** AWS has no Railway-equivalent single "hard cap" toggle. A real
enforced cap needs AWS Budget Actions (an IAM-policy/Lambda auto-response
to a budget alarm) — genuine extra implementation work.
**Options:** (a) alerts only at $5/$10, no auto-stop, (b) full Budget
Actions enforcement.
**Decision:** Alerts only. Reasoning: a static S3 + CloudFront site has a
naturally low cost ceiling at portfolio traffic levels — the realistic
overage risk is a scraping/bot spike, not normal use, so the added
Lambda/IAM complexity wasn't judged worth it right now.

## Population data source: WorldPop hosted API vs. self-hosted raster (2026-07-25, revisited 2026-07-28)
**Issue:** Computing population-within-buffer needs either (a) downloading
and hosting a WorldPop population raster ourselves and running zonal stats
locally, or (b) using WorldPop's own hosted stats API and letting them do
the raster work server-side.
**Decision (2026-07-25):** Hosted API (`api.worldpop.org/v1/services/stats`)
— no key required for normal use, eliminates the Railway Volume/S3 raster
storage question entirely.
**New finding (2026-07-28):** The hosted API's task queue appears to
genuinely hang — a correctly-formatted request (matching WorldPop's own
documented example exactly) sat at `"status":"created"` for 45+ seconds
with a server-side PHP warning (`TasksController.php` line 40) in the
response. This is WorldPop's bug, not a request-format issue on our side.
**Decision:** Keep the hosted-API plan for now and retry later — this may
be a transient incident rather than a structural problem, and free
academic-hosted APIs (Overpass showed the same pattern) do have rough
patches. `population_est` stays NULL in `exposure_stats` until this is
confirmed working.
**Retested 2026-07-29:** still stuck at `"status":"created"` after ~48s of
polling, same pattern as the first test a day earlier. Two failed tests a
day apart confirmed this as a persistent issue, not a one-off incident.
**Final decision (2026-07-29): dropped WorldPop entirely, switched to US
Census Bureau data** - not just as a fallback, but as a better fit than
WorldPop was ever going to be, given Phase 1 is explicitly US-only:
- TIGERweb (block group geometries) needs no key at all - confirmed live
- Census ACS 5-Year Data API (population) requires a free key as of a May
  2026 policy change - confirmed live via a "Missing Key" response before
  building against it, rather than assuming
- Population-in-buffer computed as an areal-weighted intersection
  (shapely, already a dependency) between block groups and buffer
  polygons - no raster hosting, no `rasterio`, no new infrastructure at
  all, unlike the self-hosted-WorldPop-raster fallback that was the
  other option on the table
- Reuses patterns already in the codebase: bbox-based ArcGIS REST queries
  (same shape as `nifc.py`), shapely intersection math (same as buffer
  containment checks)
- Stronger methodology story for a US-only tool too - authoritative
  government source beats a global gridded estimate for this use case
- Built with a graceful degrade: if `CENSUS_API_KEY` isn't set yet (true
  as of writing - key requested, not yet issued), or if the Census API
  call fails at runtime, population_est stays null for that cycle without
  blocking the building-count computation, which is independent of it
**Contingency, if the hosted API turns out persistently unreliable:** fall
back to self-hosting a WorldPop raster after all (Railway Volume ~$0.15/GB-
month, or S3). Before making that call, re-derive the actual storage size
needed given Phase 1 is **US/North America-scoped only** (matches the NIFC
WFIGS US-only decision) — a CONUS-clipped raster is a small fraction of a
global WorldPop layer's size, so the cost picture the first time this was
considered (assuming global coverage) was almost certainly an
overestimate. Reassess with that narrower scope in mind rather than
reusing the original global-size cost intuition.

## Custom domain (2026-07-28, revisited same day)
**Original decision:** Custom domain via Route53 + ACM certificate, rather
than the default CloudFront URL. Small extra setup and a small annual
registration cost, judged worth it for a recruiter-facing link.
**Revisited:** No domain currently owned to base a subdomain on, and
registering a new one now would block frontend deployment on DNS/ACM
propagation. Deferred to the final polish pass — use the default
CloudFront URL for now, add the custom domain once everything else is
running well, for a more professional final look.

## Fire geometry storage: PostGIS vs. JSONB (2026-07-28)
**Issue:** PostGIS confirmed available on Railway's managed Postgres (just
`CREATE EXTENSION postgis`), which reopened a real question: native
PostGIS geometry columns + spatial SQL, or plain JSONB (GeoJSON) with
shapely doing spatial math in Python.
**Concern raised:** worry about underestimating long-term data volume,
given prior experience is with large-scale satellite imagery processing.
**Reasoning that resolved it:** the volume/scale concern doesn't actually
apply here — a fire perimeter is a small vector polygon (KBs) regardless of
storage format, and even a full multi-thousand-fire season stays trivially
small either way. The genuinely large-scale part of this project (Phase 2
Sentinel-1 SAR processing) never touches this table at all — like the LA
wildfire pipeline, it processes scenes as files and writes back a small
result record, not raw pixels in Postgres.
**Decision:** JSONB + shapely. Matches the pattern already proven across
the existing portfolio (Mato Grosso, LA wildfire, Baltic algae), keeps one
fewer unfamiliar piece in an already-new stack, and remains a legitimate
industry-standard choice at this data volume. Not a one-way door — adding
PostGIS later, if a genuine spatial-query need shows up (e.g. Phase 3 wind
overlays), would be additive, not a rewrite.

## Dev Postgres source (2026-07-28)
**Decision:** Provision the real Railway Postgres immediately and develop
against it directly, rather than installing Postgres natively for local-
only dev. Reasoning: it's infrastructure needed for deployment anyway, and
avoids installing something else on the machine that will just be
re-verified against the real thing before deploy regardless.

## Postgres driver: psycopg2 vs. psycopg3 (2026-07-28)
**Issue:** Initial `psycopg[binary]` (psycopg3) install didn't match the
plain `postgresql://` URL scheme Railway provides (SQLAlchemy defaults
that scheme to the psycopg2 dialect).
**Decision:** Swapped to `psycopg2-binary` rather than rewriting the
connection string to force the psycopg3 dialect — simpler fix, avoids
touching Railway's own provided values. Minor compatibility call, not a
deep architectural tradeoff.

## Background job scheduling: asyncio loop vs. APScheduler (2026-07-28)
**Issue:** Needed a way to run NIFC ingestion and exposure computation on a
recurring schedule inside the FastAPI backend.
**Decision:** Plain `asyncio` background task in the FastAPI `lifespan`
(loop + `asyncio.sleep`), not the APScheduler library. Made directly
without raising it as a formal choice — judged as a minor implementation
detail (a ~15-line stdlib loop vs. a new dependency for the same result at
this project's scale), not a strategic tradeoff. Noted here per the
standing instruction to log design decisions, even ones settled without a
formal question.

## NIFC WFIGS endpoint (2026-07-28)
**Issue:** The original plan flagged that NIFC restructures dataset URLs
periodically and said to verify at implementation time rather than trust
the doc.
**Finding:** That caution was justified — resolving the ArcGIS Hub dataset
item live led to `WFIGS_Interagency_Perimeters_Current` (a single
consolidated "Perimeters" layer), not the two-layer current/to-date split
originally described.
**Decision:** Used the live-verified endpoint, confirmed against a real
query (210 current records at time of check) rather than guessing from the
planning doc.

## Overpass query shape (2026-07-28)
**Issue:** How to query Overpass for buildings within a fire's 2400m
buffer without query size/complexity scaling with how complicated a fire's
perimeter is (some fires, e.g. "Morrill," have huge multi-part geometries).
**Options:** (a) bounding-box query + exact local shapely containment
filtering, (b) a precise/simplified `poly:` filter sent to Overpass
directly.
**Decision:** Bounding box + local filtering. Query size stays constant
regardless of perimeter complexity (protects the shared public Overpass
instance from an oversized query), at the cost of transferring a slightly
larger candidate set and more local geometry processing — an easy trade
given Phase 1's fire counts are small.

## Overpass resilience: retry vs. no-retry (2026-07-28)
**Issue:** Live testing during development showed the public Overpass
instance genuinely overloaded (sustained 504s, then a 429 once we pushed
it) — a demonstrated reliability risk, not a hypothetical one. Also found
and fixed separately: Overpass rejects requests with no identifying
`User-Agent` (bare 406).
**Options:** (a) no retry — log failure, let the next scheduled recompute
cycle pick the fire back up, (b) bounded retry with backoff (e.g. 5s/15s/
45s) within the same cycle before giving up.
**Decision:** No retry. Reasoning: exposure recompute already runs on its
own decoupled cadence (doesn't block page loads), so a failed fire just
gets retried next cycle for free. Retrying harder against an already-
overloaded free public service is worse fair-use citizenship for
uncertain benefit — confirmed live that a sustained overload doesn't
resolve within a single cycle's worth of retries anyway. Added a 2-second
politeness delay between per-fire Overpass requests regardless.

## CI/CD timing, revisited after manual-redeploy friction (2026-07-29)
**Issue:** After two rounds of manual frontend redeploys (build, sync,
invalidate) to chase the MapLibre worker bug, asked whether to move
GitHub Actions automation up from "end of main phase" to now.
**Decision:** Keep deferring. The friction is real but manageable while
still actively iterating on frontend features; building the workflow now
would divert time from remaining Phase 1 work (WorldPop retry, README,
AWS budget alerts) for a convenience win that matters more once frontend
changes become less frequent. Confirms the original [[feedback_infra_later]]
pattern still holds even under real friction, not just in the abstract.

## Standing process decisions (ongoing, not one-time)
- Never commit or push on the user's behalf — always end a working turn
  with copy-pasteable `git add` / `git commit` / `git push` commands
  (2026-07-25, reconfirmed 2026-07-28).
- Present any decision with genuine multiple options and real tradeoffs
  before proceeding, with clear pros/cons; only act unprompted on fixes
  with no realistic alternative (2026-07-28).
- Docker, CI/CD, and formal test scaffolding deferred to near the end of
  the main build phase, not built alongside early features (2026-07-25,
  matches the same pattern already used on SARFloodAnalysis).
