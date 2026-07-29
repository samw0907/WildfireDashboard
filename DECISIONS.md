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

## Basemap (2026-07-29)
**Issue:** MapLibre placeholder demo style (`demotiles.maplibre.org`) was
never meant to ship - flagged by the user as looking bare/unfinished
compared to the TAFP reference screenshots, which include a Street/Imagery
toggle button on their map.
**Research before deciding (burned twice already this session by assuming
API mechanics instead of verifying):** OpenFreeMap confirmed genuinely
free, no API key, no rate limit, OSM-based vector style - clean, no
ambiguity. ESRI World Imagery (satellite) has conflicting signals in what
was found - one source says it's a plain usable tile endpoint, another
says it requires an ArcGIS Online/Enterprise license and isn't licensed
for commercial use. Ambiguous enough not to build against without reading
Esri's actual terms page directly.
**Decision:** Ship OpenFreeMap's "Liberty" street style now (zero risk,
zero setup, covers the roads/evacuation-route value directly). **Revisit
later:** add a Street/Imagery toggle matching TAFP's own pattern, using
MapTiler for the satellite half (confirmed clean free-tier licensing,
just needs a free API key) - deferred, not because it's a bad idea, just
lower priority than shipping something solid now.

## Additional data sources reviewed for the "bigger NatCat picture" (2026-07-29)
Stepped back from feature-by-feature building to ask what else would
strengthen the exposure-first NatCat story. Reviewed against the same
honesty/authoritative-source bar as everything else in this project:
- **NWS Red Flag Warnings** — confirmed real, free, no-key GeoJSON polygons
  via `api.weather.gov/alerts/active`. **Decision: build it** — fills the
  "no US equivalent to a danger classification" gap identified all the way
  back in original planning. Toggleable map layer, same pattern as the
  buffer rings; the useful derived value is flagging whether a fire's own
  location currently sits inside an active warning.
- **Evacuation routes** — **decision: park this, not building it.** No
  standardized national data source exists for actual evacuation routes
  (those are decided by local emergency management in real time, not
  published as open data). The buildable proxy (major OSM highways near a
  fire, same Overpass pipeline as buildings) was judged not worth adding
  on its own merits — the basemap already shows roads, so a dedicated
  layer for the same information add little. The methodologically "real"
  version (network/isochrone travel-time analysis) is a legitimate bigger
  undertaking, logged as a future idea, not attempted now.
- **Smoke / air quality** (NOAA Hazard Mapping System or EPA AirNow) —
  **added to the backlog, not built yet.** Genuinely extends the
  exposure-first differentiator in a direction TAFP doesn't touch at all —
  smoke can expose orders of magnitude more people than anything within a
  2.4km buffer. Real open data, honestly-statable forecast-vs-observed
  uncertainty. Queued behind the priority-fire/SAR work below.
- Reviewed and deprioritized: FEMA National Risk Index (static/county-
  level, not fire-specific or live), historical fire-frequency layers,
  parcel-level property values (not available as US open data at all).

## Reference site re-examined: TAFP is FIRMS-detection-based, not perimeter-based (2026-07-29)
Fetched the live TAFP site (not just the earlier screenshots) to confirm
what it actually does: NASA FIRMS thermal detections (MODIS/VIIRS) →
DBSCAN clustering → concave-hull perimeter delineation, refreshed same-day
per country/province/date-range selection. No exposure, building, or
population data at all. Confirms the differentiation this project is
built around (exposure-first, not detection-first) is real, not just a
claim — the two approaches are complementary (same-day detection vs.
authoritative-but-slower perimeters), which is worth keeping in mind once
Phase 2's own Sentinel-1 work starts, since that's where this project
would start doing detection-adjacent work too.

## Priority-fire identification + SAR acquisition trigger — major scope addition (2026-07-29)
**Context:** stepping back to the project's original motivation (built off
the ICEYE GIS Operational Analyst application) — the core idea was never
just "display exposure stats," it was "identify the highest-priority fires
for follow-up SAR imagery analysis, for emergency response and insurance
audiences." This was partially captured in the original plan's "Settings
page" concept (buffer/population/area thresholds as "the decision layer
Phase 2's SAR tasking will use") but never actually built. Revisited now
as a first-class feature, and **reprioritized above the remaining Phase 1
polish bucket** (custom domain, honesty pass, CI/CD, tests) — this is
closer to the project's actual point than deployment polish is.

**Existing asset discovered/reused:** a separate already-built SAR
wildfire pipeline (`c:\Users\swill\dev\LAwildfireSAR`, built for the
January 2025 LA fires) was audited in depth before designing anything
here. Findings that shaped every decision below:
- The core science — CDSE scene search, the pyroSAR/SNAP RTC wrapper,
  composite alignment, change-detection math — is genuinely reusable as
  parameterized functions, not LA-specific. Roughly 40-50% of the
  substantive pipeline carries over close to as-is.
- The hardest part for a live/automated system — determining which
  Sentinel-1 track covers an arbitrary AOI and finding a geometrically
  clean before/after scene pair (the real "Track 137 burst gap → Track 64"
  fix in that project) — was done entirely by hand via disposable
  debugging scripts. It does not exist as callable, general code. This is
  the one part of the whole feature that's a genuine ML/geometry research
  problem, not an engineering-effort problem.
- The actual RTC processing takes 4-6 hours per event, needs a full ESA
  SNAP install, and consumes tens of GB of disk — cannot run on Railway.
  Needs a separate, ephemeral, heavier compute environment. The existing
  repo's Dockerfile (Ubuntu + SNAP GPT) is already built for exactly this
  and is a strong reuse candidate for that compute environment specifically
  — this does NOT imply the main WildfireDashboard backend needs
  Dockerizing (see the Docker reassessment entry below).

**Decision: do not attempt automated orbit/scene-selection.** Confirmed
with the user that even the original LA pipeline's track/date choices
leaned on AI-assisted human judgment in the moment, not a standing
algorithm — automating that reasoning is a genuine geometry/ML problem,
correctly assessed as beyond a few days' scope. Scoped down instead to a
**human-in-the-loop "mark for acquisition" workflow**:
- Automatic weighted priority score (below) surfaces the top 1-2 fires
- A "mark for acquisition" action triggers a *live* CDSE scene search
  (reusing the confirmed-reusable `search_scene()`-equivalent function)
  across a sensible pre-fire and post-fire window, returning **real
  candidate scenes** (date, track/relative orbit, ascending/descending),
  not blank fields requiring external research
- Before/after scene pickers shown side by side; selecting a "before"
  scene filters the "after" list to the same relative orbit/track number
  where available (falls back to same direction if no same-track after-
  scene exists yet) — same track guarantees identical viewing geometry,
  which is what the original project's real bug was actually about, not
  just "same direction." Confirmed correct by the user, who recalled the
  ascending/descending constraint from the original project.
- The human judgment this preserves (avoiding burst-edge/coverage issues)
  is exactly the part that was never going to be safely automatable
  anyway — this design keeps that judgment where it belongs rather than
  pretending it can be removed.
- Once scenes are human-confirmed, the remaining engineering shrinks back
  to the genuinely-reusable pipeline code — this is what makes "roughly a
  week if tightly scoped" a plausible estimate, with the real schedule
  risk being the ephemeral-compute dispatch mechanism (new infrastructure),
  not the science.

**Priority scoring formula (built to be explainable, not just computed):**
```
building_index    = 4×(within perimeter) + 3×(500m) + 2×(1,000m) + 1×(2,400m)   [building counts]
population_index  = 4×(within perimeter) + 3×(500m) + 2×(1,000m) + 1×(2,400m)   [population estimates]
acreage_index     = log(1 + acres)                                              [log-transformed fire size]
normalized_x      = x_index / max(x_index across current fire list)             → 0-1 each
exposure_component = 25×normalized_building + 25×normalized_population           → 0-50
scale_component    = 50×normalized_acreage                                      → 0-50
priority_score     = exposure_component + scale_component                       → 0-100
```
Reasoning: closer/more-certain exposure (already inside the perimeter)
should count for more than distant/possible exposure (2,400m out) —
matches how both insurance (direct loss) and emergency response
(immediate danger) would naturally weight it. Normalizing each component
against the *current* fire list rather than a fixed scale keeps this a
genuine relative ranking tool (exactly what "pick today's top 1-2" needs)
and avoids population's naturally larger raw numbers from swamping the
building signal.

**Bug found via live testing, fixed same day (2026-07-29):** the initial
version (exposure only, no scale term) let a 6-acre fire ("CLARKE") rank
#2 overall, ahead of fires 1,000x+ larger, purely because it happened to
sit in a dense area (7,628 buildings within 2.4km - the single highest
building count of any tracked fire). A small fire's high building count is
largely an artifact of location, not a sign of real danger, since a small
perimeter's 2.4km buffer just reflects local density regardless of fire
behavior - exposure alone wasn't sufficient, fire scale needed to temper
it. Added the acreage/scale component (log-transformed, since raw acreage
is heavily right-skewed and a linear scale would let one outlier fire
dominate the normalization for everyone else) as an equally-weighted
second pillar. Verified live: CLARKE dropped from #2 to #134 of 230;
large, genuinely-exposed fires (Aspen Acres, Kaiser Canyon) now correctly
top the list. The exposure/scale 50/50 split and the internal 25/25
building/population split are reasonable defaults, not deeply justified —
revisit if real population data (once the Census key lands) or containment
percent (a natural further refinement - an uncontained fire is a bigger
going concern than a mostly-contained one of the same size, though
`percent_contained` has enough NIFC data gaps to need a null-handling
strategy before using it) suggest a different balance.

**Access control for the "Confirm & Proceed" action:** the deployed site
has no authentication at all today — anyone could otherwise trigger a
real-money compute dispatch. **Decision: a single shared admin-key
prompt, not a full login/user system.** Reasoning: no multi-user need
exists (single operator), so password hashing/sessions/login pages would
be real complexity for no benefit over a shared secret. Same fail-closed
pattern already used for `RECOMPUTE_API_KEY`: the public site stays fully
open for browsing (matches the portfolio-demo framing), the key is only
requested when a user reaches a costly action, stored browser-side after
first entry, sent as a header, validated server-side. **The confirm
action itself is a hard gate, not just a rate limit or after-the-fact
email** — nothing dispatches compute until a human clicks it, which is
stronger protection against overspend (including from a bug) than a
weekly cap would be. Email notification on a new fire entering the
priority slot is a reasonable future add but explicitly sequenced after
the core flow, since it's a new external service dependency (transactional
email API/account) and not required for the cost-control property itself.

**Compute credentials needed:** the existing LAwildfireSAR pipeline
already has a CDSE (Copernicus Data Space Ecosystem) account/credentials
from that project — reuse those rather than creating new ones. Needs
`CDSE_USER`/`CDSE_PASSWORD` added to this project's env (already
documented as a Phase 2 placeholder in `.env.example` since the very
start of this project).

## Docker reassessment (2026-07-29)
**Issue:** original plan carried over "Dockerize backend" as a generic
near-end polish item from the existing portfolio's conventions, without
specifically asking whether it serves a purpose *for this project*.
**Reassessed:** the main FastAPI backend deploys to Railway successfully
today without a Dockerfile at all (Railway's own Railpack builder handles
it directly from `requirements.txt`) — Dockerizing it would add a
maintenance surface with no corresponding benefit, since there's no
second deployment target that would need it. **Decision: drop generic
backend Dockerization from the plan.** Docker still matters, but for a
different, more specific reason: the SAR compute-dispatch piece above
needs the *existing* LAwildfireSAR Dockerfile (Ubuntu + ESA SNAP) as the
ephemeral compute image — that's a real, purpose-built need, not the
generic "containerize the web backend" task that was originally listed.

## Standing process decisions (ongoing, not one-time)
- Never commit or push on the user's behalf — always end a working turn
  with copy-pasteable `git add` / `git commit` / `git push` commands
  (2026-07-25, reconfirmed 2026-07-28).
- Present any decision with genuine multiple options and real tradeoffs
  before proceeding, with clear pros/cons; only act unprompted on fixes
  with no realistic alternative (2026-07-28).
- CI/CD and formal test scaffolding deferred to near the end of the main
  build phase, not built alongside early features (2026-07-25, matches the
  same pattern already used on SARFloodAnalysis). Generic backend
  Dockerization dropped from this list entirely (2026-07-29) — Docker only
  matters here for the SAR compute-dispatch image, a specific need, not a
  generic polish task.
- Priority-fire/SAR acquisition work reprioritized above the remaining
  Phase 1 polish bucket (custom domain, honesty pass, CI/CD, tests)
  (2026-07-29) — closer to the project's original point than deployment
  polish is.
