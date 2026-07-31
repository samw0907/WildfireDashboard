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
  - **Sanity-checked the "is this real data" question (2026-07-29):** live
    map showed all active warnings clustered tightly in ID/MT with nothing
    elsewhere, which looked suspicious enough to verify rather than assume.
    Hit `api.weather.gov/alerts/active` directly: nationwide feed genuinely
    returned only 5 active alerts at that moment, all issued by NWS
    Missoula/Pocatello/Boise. Confirmed this is expected behavior, not a
    bug — Red Flag Warnings are issued per local NWS office based on
    synoptic-scale fire-weather conditions (wind, humidity, dryness), not
    on fire counts or fire size, so coverage is legitimately regional and
    day-dependent (could be nationwide during a widespread dry/wind event,
    or a single-region cluster like this on a quiet day). Added a tooltip
    on the map toggle explaining this so it doesn't read as broken to a
    recruiter looking at it on a sparse day.
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

**Key persistence tightened, `localStorage` → `sessionStorage` (2026-07-29):**
user noticed the key survived a full frontend redeploy and, surprisingly,
kept working in what they believed was a fresh incognito window - flagged
this to understand and tighten the security model before going further.
Clarified: redeploy surviving is expected and harmless (redeploying only
replaces static files served from the origin; browser storage is tied to
the origin, not any particular build). The incognito result is unresolved
- true private-browsing storage isolation in a real browser shouldn't
carry a value over, so this is most likely explained by the VSCode
preview pane (already the source of the window.prompt bug) not fully
isolating storage the way a real browser tab does, not a flaw in the app
itself. Regardless, `localStorage`'s indefinite persistence was more than
this needed - **switched to `sessionStorage`**: the key is now forgotten
when the tab/browser closes rather than cached forever, while still
avoiding a re-prompt on every action within one sitting. Explicitly still
a shared secret, not per-person auth: the server has no notion of "who"
presented the key, only whether the string matches - anyone holding the
key value, or anyone with access to a browser tab where it's already
cached for that session, can use it. A full login system was reconsidered
and rejected again for the same reason as the original decision above.

**Compute credentials needed:** the existing LAwildfireSAR pipeline
already has a CDSE (Copernicus Data Space Ecosystem) account/credentials
from that project — reuse those rather than creating new ones. Needs
`CDSE_USER`/`CDSE_PASSWORD` added to this project's env (already
documented as a Phase 2 placeholder in `.env.example` since the very
start of this project).

## Mark-for-acquisition implementation details (2026-07-29)
Filling in the specifics not already nailed down in the design discussion
above, live-verified before committing to them:
- **CDSE search needs no auth at all** - verified directly against
  `catalogue.dataspace.copernicus.eu/odata/v1/Products`: bbox+date-range
  queries return full results including `relativeOrbitNumber` and
  `orbitDirection` with zero credentials. The pipeline's original
  `get_access_token()` is only needed for the actual scene *download*
  step (compute-dispatch phase, not this one) - so this phase doesn't
  touch `CDSE_USER`/`CDSE_PASSWORD` at all yet.
- **Schema: columns on `fires`, not a separate table.** An
  `AcquisitionRequest` table (with its own id/fire_id FK) would be the
  "proper" normalized shape, but a fire only ever has one acquisition
  request in flight at a time (no history requirement, unlike
  `exposure_stats`) - four nullable columns
  (`acquisition_status`/`acquisition_before_scene`/`acquisition_after_scene`/
  `acquisition_confirmed_at`) is simpler and avoids a join for what's
  fundamentally mutable per-fire state, not a time series.
- **Search windows:** before = discovery date minus 21 days; after =
  discovery date to min(today, discovery date + 45 days). Picked from
  Sentinel-1's ~6-12 day revisit interval (enough real candidates on each
  side without an unreasonably wide search), not from anything in the
  original pipeline - these are tunable constants in
  `routers/acquisition.py`, not deeply justified.
- **Search AOI:** fire perimeter buffered 3km (reusing the project's
  existing meter-accurate `geo.buffer_meters()`, not a crude degree pad),
  bounding box taken from that.
- **Auth split:** `GET` endpoints (state, candidates) are public/read-only
  - live scene search costs nothing, so there's no reason to gate
  browsing. `POST` endpoints (mark/select/confirm/unmark) are admin-key
  gated even though none of them spend money yet either - consistent with
  gating `RECOMPUTE_API_KEY` already does for a similarly "free but
  shouldn't be public-writable" action, and simple vandalism-prevention
  for a public demo site.
- **"Confirm & proceed" only records the decision right now** - it does
  not, and cannot yet, dispatch any compute (that's the separate,
  not-yet-designed phase below). The UI says this explicitly rather than
  implying a real dispatch happens, matching the project's honesty bar.

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

## SAR compute dispatch — full architecture + methodology decisions (2026-07-30)

**Context for a future session picking this up**: this is the very next
build phase after everything in "Priority-fire identification + SAR
acquisition trigger" above. The mark-for-acquisition workflow (live CDSE
scene search, before/after picker, AOI coverage %, footprint outlines on
the map) is fully built and deployed. What's described below is the
**next thing to build**: actually dispatching SAR processing compute when
"Confirm & proceed" is clicked, and displaying results. **See
`SAR_METHODOLOGY.md` for the full scientific reasoning behind every
decision below** — that doc is long and deliberately thorough (read it
fully before touching this feature); this entry is the shorter
decisions-log version for quick reference. Do not skip reading
`SAR_METHODOLOGY.md` — it contains critical analysis (§5) and the
building-footprint/threshold/fallback reasoning (§6-8) that isn't
repeated in full here.

### Compute platform: AWS, not Google Earth Engine
Google Earth Engine was seriously considered (user has prior experience
with it from MatoGrossoCarbon/PreyLangCambodia). Verified live against
Earth Engine's own dataset docs: GEE's native `COPERNICUS/S1_GRD` applies
thermal noise removal, radiometric calibration, and **geometric** terrain
correction only — not radiometric terrain flattening (gamma0/RTC), which
is exactly what the existing `LAwildfireSAR` pipeline's pyroSAR/SNAP step
does and is a meaningful accuracy difference in mountainous wildfire
terrain. GEE's noncommercial compute is free with a monthly quota that
throttles (doesn't bill) past the limit — genuinely safer than AWS in that
one respect, but not the deciding factor once the user confirmed AWS cost
is a non-issue at demo scale (2-3 fires, fully human-triggered, nothing
auto-runs). **Decision: AWS**, specifically to preserve the RTC step the
original pipeline was actually validated with, not re-derive a simpler
approach for a use case where cost wasn't the binding constraint anyway.

### Architecture: AWS Batch on Fargate
- **Compute**: AWS Batch, **Fargate-backed** (not EC2-backed) — the
  existing Dockerfile (Ubuntu 24.04 + SNAP headless GPT + GDAL + Python
  3.11) has no GPU/kernel-module requirements, so there's no reason to
  manage EC2 AMIs ourselves. Fargate's resource ceiling (up to 16 vCPU /
  120GB memory) comfortably covers a single job. Batch (vs. raw
  `boto3.run_instances`) gives job timeouts, retries, and CloudWatch Logs
  for free.
- **Hard job timeout** (recommend ~6 hours) as a safety cap — belt-and-
  suspenders on top of "nothing auto-triggers," so even a genuinely stuck
  job can't silently run/cost forever.
- **Registry**: push the existing Dockerfile to ECR (one-time setup).
- **Trigger**: the already-admin-gated `/confirm` endpoint calls
  `boto3.client('batch').submit_job(...)`, passing the 6 (or 2, see
  fallback design below) scene product IDs + fire ID as container
  overrides/env vars.
- **Pipeline adaptation**: a new lightweight entrypoint replaces
  `scripts/run_processing.py`'s config-file-driven orchestration — it
  takes exact scene IDs already chosen by the human via the picker (no
  track search/selection needed at compute time, that already happened in
  the UI), downloads just those, RTC-processes, composites (or skips
  compositing — see fallback design), change-detects, classifies
  buildings, and skips `validate.py` entirely (no ground truth exists for
  a live fire — see `SAR_METHODOLOGY.md` §3/§7).
- **Results**: sync to S3 (reusing the `sync_to_s3.py` pattern already
  built in `LAwildfireSAR`). A **new background polling loop** — same
  `asyncio` pattern already used for ingestion/exposure/alerts, not a new
  AWS service (no EventBridge/Lambda/webhooks) — checks
  `batch.describe_jobs()` for in-progress acquisitions and updates the DB
  once a job reaches `SUCCEEDED`/`FAILED`.
- **Cost estimate**: ~$0.30-0.55/hour Fargate-equivalent sizing, ~1.5-3
  hours per fire scaled from the original pipeline's "4-6 hours for 6
  scenes across 2 events" baseline → **roughly $1.50-5 total for 3 demo
  fires**. No measured runtime exists yet — first real run should be
  treated as the number to actually trust, this is a placeholder estimate.

### Composite size: fixed 3 scenes per side, not flexible
Median compositing requires **at least 3** dates to provide any real
outlier-robustness — median of 2 values is mathematically identical to
their average, so a "flexible 2-5" option (raised and corrected during
discussion) would have silently included a tier that buys nothing over a
single scene. Fixed 3 was chosen over flexible 3-5 for simplicity: it
matches exactly what the original pipeline validated, keeps the picker UI
and cost/runtime estimate constant across every fire, and the "not enough
candidates" edge case has to be handled either way (see fallback design
below) so fixed doesn't carry more real risk than flexible would have.

### Building footprint dataset: OpenStreetMap, not Microsoft Global ML Building Footprints
The original pipeline's validated F1 ≈ 0.80 is tied to Microsoft's
footprint geometries specifically (zonal-stats sampling is sensitive to
exact polygon edges) and does not transfer to OSM even in principle.
Decided to use OSM anyway because: (a) using a different building dataset
than the dashboard's existing exposure feature would mean two different
building inventories for the same fire visible on the same page — a
coherence problem worse than the F1 loss for a portfolio piece; (b)
Microsoft's footprints are large per-state static files, not a queryable
API, and would require new download/storage infrastructure this project
has deliberately avoided; (c) **confirmed we already have what's needed**
— `overpass.py` builds real `shapely.Polygon` geometries (not just
points/counts) from OSM way data, already cached per fire in
`building_cache` at the 2400m buffer extent, comfortably covering
anything near the perimeter. No new building-data pipeline is needed at
all, just reuse of what the existing exposure feature already fetches.
The F1 loss is judged acceptable specifically because §3 of
`SAR_METHODOLOGY.md` already means that number can't be fully claimed for
a new fire regardless of building dataset (no per-fire ground truth
either way) — document this wherever SAR results are surfaced: not "this
achieves F1 0.80" but "this method achieved F1 0.80 in validated
conditions against a different building dataset; applied here without
per-fire validation."

### Damage threshold: fixed inherited value, no auto-calibration
The original pipeline's 2.9 dB / 1.74 dB thresholds were empirically
calibrated against **CAL FIRE DINS** — real human building-inspection
records, available only weeks after containment and only for California.
No equivalent ground truth exists for an arbitrary new fire in real time,
anywhere in the US, ever, in most cases. An "auto-recalibrate" button was
proposed and discussed in depth — rejected for now specifically because
threshold calibration requires something to calibrate *against*
(precision/recall computation needs known-true labels), not because it's
too much engineering effort. **Decision: use the fixed 2.9 dB / 1.74 dB
values inherited from the original pipeline, explicitly documented
everywhere as not independently validated for whatever new fire they're
applied to.** Two weaker future substitutes were discussed and logged to
`PROGRESS.md` backlog rather than built now: (1) loose recalibration
against publicly reported aggregate "structures destroyed" counts, if/when
available for a specific fire (much weaker than DINS — confirms total
count, not that the *right* buildings were flagged); (2) a manual
"reprocess with a different threshold" control for later, if real outcome
data for a specific fire ever surfaces.

### Fallback design: not every track will have 3 scenes available on both sides
Real risk, discussed in depth rather than assumed away. Empirical
grounding: live tests this session (Aspen Acres fire) showed ~12
candidate scenes across 4 tracks in a 21-day "before" window — averaging
~3 dates/track, consistent with Sentinel-1's current ~6-day effective
revisit with two operational satellites (S1C/S1D) sharing the same ground
tracks 180° out of phase. So 3-per-track is often achievable today, but
not guaranteed — satellite outages, edge-of-swath geography, or timing
luck relative to a fire's discovery date will occasionally leave a track
short, especially on the "after" side for a very recently discovered fire.

**Decided mechanism** (built and verified live 2026-07-30 — see `PROGRESS.md` Phase A/B for the full build/test record):
1. **Surface track sufficiency proactively in the picker**, before
   individual scene selection — a per-track summary computed client-side
   from the candidates the API already returns (`relative_orbit` is
   already in the response, no backend change needed for this part):
   e.g. "Track 64 (ASCENDING): 3 before, 4 after" / "Track 151
   (ASCENDING): 2 before, 1 after." Lets the user spot the best track at a
   glance instead of counting manually.
2. **Exactly two supported modes, no ambiguous middle tier**: **Composite**
   (exactly 3+3, preferred, real median-compositing benefit) or
   **Single-pair** (exactly 1+1, fallback). Deliberately no "2" tier — it
   would look more rigorous than a single pair while providing the exact
   same zero outlier-robustness as median-of-2 (see composite-size
   reasoning above).
3. Picker auto-switches into Single-pair mode (select exactly 1 each side
   instead of 3) when the chosen track can't support Composite, with a
   visible warning: *"Only single before/after scenes available on this
   track — results won't benefit from multi-date noise averaging and may
   be less reliable."*
4. **Backend `/select` schema** needs to accept either exactly 3 or
   exactly 1 scene per side (same track across whichever count) — not
   always-3 as originally scoped before this discussion.
5. **Compute pipeline branches on mode**: Composite mode runs
   `composite.py`'s median build before change detection; Single-pair mode
   skips compositing entirely and feeds the one RTC-processed scene per
   side straight into `change.py`'s log-ratio step. Everything downstream
   (buildings classification, thresholding) is identical either way.
6. **Results must visibly label which mode ran** — "Composite (3+3)" vs.
   "Single-pair (1+1) — reduced reliability" — never ambiguous after the
   fact once a job completes.

### Search window: 14-day minimum floor added to the "after" window
The original pipeline deliberately avoided any post-fire scene earlier
than 14 days after ignition — imagery taken sooner picks up confounding
signals from active firefighting (retardant, emergency vehicles, debris
disturbance) rather than the structural change being measured. **Our
current `AFTER_WINDOW` in `routers/acquisition.py` starts at the fire's
discovery date (day 0) with no floor — this needs the same 14-day minimum
added** before the fallback/picker rework ships, not after.

### Confirmed out of scope / explicitly not building right now
- Automated orbit/track selection (confirmed weeks ago — genuine
  geometry/ML research problem, human-in-the-loop by design).
- SAR interferometric coherence as an alternative/supplement to intensity
  change detection (real methodological alternative per
  `SAR_METHODOLOGY.md` §5, needs SLC data + interferometric
  co-registration, a substantially bigger technical lift, not in scope).
- Vegetation/burn-scar confound mitigation (identified as a real gap in
  `SAR_METHODOLOGY.md` §5, not addressed by the original pipeline either,
  logged as a known limitation rather than solved).
- Any masking/reweighting of the flat single-threshold-for-all-buildings
  approach by building size (identified as a real limitation, not fixed).

## SAR compute pipeline implementation (Phase C, 2026-07-30)

New `sar-compute/` directory at the repo root - self-contained (own
Dockerfile/requirements.txt), does not modify or depend on the separate
`LAwildfireSAR` repo, which stays untouched as its own portfolio piece.
Full build detail is in `PROGRESS.md`'s Phase C entry; the genuine
engineering decisions worth logging here:

- **The compute job fetches its own inputs by `FIRE_ID` from the main
  backend's public API**, rather than the trigger passing perimeter/scene
  data as job parameters. Simpler Batch job definition (one env var, not a
  growing pile of parameters), and the job always reads current data
  rather than a snapshot from whenever it was submitted.
- **IAM task role over explicit AWS credentials** for S3 access - the
  original `LAwildfireSAR` script needed `AWS_ACCESS_KEY_ID`/`SECRET` env
  vars since it ran standalone with no AWS-native identity; this job runs
  inside Fargate, which can just be granted an S3-scoped role directly.
  More secure, no credential management at all.
- **Per-fire UTM zone**, not a hardcoded one. The original pipeline fixed
  `EPSG:32611` because both its fires were in the same LA-area location;
  an arbitrary new fire needs its own zone computed from its centroid
  longitude. Verified this reproduces `EPSG:32611` exactly when fed
  Eaton's real coordinates, and correctly gives zone 13 for a real
  Colorado fire.
- **Clip to the fire's actual perimeter polygon, not a bounding box**, in
  `change.py`'s burn-mask step (`rasterio.mask` on the reprojected
  perimeter geometry). The original used a bbox because its
  `combined_bbox` covered two whole fire study areas as one unit; a single
  arbitrary fire's real footprint is available and more precise to use.
- **`validate.py` has no equivalent at all** - not simplified, dropped
  entirely, since there's no CAL FIRE DINS-style ground truth for a live
  fire (§3/§7 in `SAR_METHODOLOGY.md`). The output JSON itself carries
  `threshold_validated: false` and an explanatory note, not just this doc.
- **Honest status**: none of the actual RTC/compositing/change-detection
  code has been run for real yet - that needs the built Docker image
  (ESA SNAP install) and a real multi-hour job, not something verifiable
  without SNAP/rasterio/geopandas/pyroSAR installed, which only exist
  inside the image. Verified what could be verified without that: syntax
  on every file, the UTM-zone math against two independent real fire
  locations, and the real cached OSM building data's shape against what
  the code expects.

## SAR compute Phase D — AWS infrastructure, live (2026-07-31)

Everything designed in "SAR compute dispatch" above is now actually
provisioned and verified healthy, not just planned. Real resource names/IDs
(needed by anyone picking this up cold):

- **ECR**: `wildfiredashboard-sar-compute` repo, `:latest` tag pushed.
- **IAM roles**: `wildfiredashboard-sar-execution` (pulls the image, writes
  CloudWatch logs, reads the CDSE secret via a scoped inline policy),
  `wildfiredashboard-sar-task` (S3 read/write on the results bucket only).
- **Batch**: compute environment `wildfiredashboard-sar-compute-env`
  (Fargate, the account's 3 default public subnets, default security
  group), job queue `wildfiredashboard-sar-queue`, job definition
  `wildfiredashboard-sar-job` (4 vCPU / 16GB, `retryStrategy.attempts: 1` —
  a stuck/broken run should surface as a clear failure, not silently
  double-run and double the cost — 6h `attemptDurationSeconds` hard cap).
- **S3**: `wildfiredashboard-sar-results-497537671259` (account-ID-suffixed
  for guaranteed global-namespace uniqueness), public access blocked,
  SSE-S3 encryption on by default.
- **Secrets Manager**: `wildfiredashboard/sar/cdse-credentials`
  (username/password key-value secret), created by the user directly
  through the console — CDSE credentials never passed through this
  session, matching the existing `.env`-handling boundary.
- **IAM policy structure changed mid-setup**: the deployer's inline policy
  hit AWS's hard 2048-non-whitespace-character limit for inline policies as
  permissions accumulated (ECR, Batch, scoped IAM role management, Secrets
  Manager, S3, CloudWatch Logs, the Batch service-linked-role grant). Fixed
  by converting it to a standalone customer-managed policy
  (`WildfireDashboardSarComputeInfrastructure`, 6144-char limit) rather
  than trimming permissions — same access, different container. Anyone
  extending this further should expect to hit the same wall again
  eventually and know the fix is the same.
- **New dedicated IAM user for the backend itself**:
  `wildfiredashboard-backend-runtime`, scoped to only
  `batch:SubmitJob`/`batch:DescribeJobs` (API doesn't support finer
  resource scoping for these) + `s3:GetObject` on the results bucket's
  `acquisitions/*` prefix. Needed because the backend runs on Railway, not
  AWS — unlike the Fargate task, it has no IAM role for boto3's default
  credential chain to pick up automatically, so it needs its own static
  access key (stored in Railway's env vars, entered by the user directly,
  never seen by this session). Deliberately a separate identity from both
  `wildfiredashboard-deployer` (setup-time, broader/more sensitive) and
  `wildfiredashboard-frontend-deploy` (a different purpose entirely) —
  least-privilege means one identity per purpose, not one shared key.

### Real bugs found only once actually building/wiring this (not
### hypothetical — each blocked a real `docker build` or would have
### silently broken at job-run time)
- Ubuntu 24.04 ships Python 3.12 as `python3`; `python3.11` isn't a
  package at all on this release — the Dockerfile (copied from
  `LAwildfireSAR`, built on an older Ubuntu release's assumptions) needed
  updating to the distro's native package name.
- Ubuntu 24.04's system pip refuses unmanaged installs by default (PEP
  668) — needs `--break-system-packages`. Safe here specifically because
  this container has exactly one purpose and one pinned dependency set,
  not a general dev environment where that override would be dangerous.
- The inherited SNAP installer URL (version 10.0) 404s — ESA had already
  moved the current release to 13.0.0 with a renamed installer file
  (`_unix_10_0.sh` → `_linux-13.0.0.sh`). Fixed by pointing at the current
  URL. **This is a genuine open methodological question, not just a build
  fix**: the original pipeline's RTC output was validated using SNAP
  10.0's GPT operators specifically; nothing guarantees a 3-major-version
  jump produces bit-identical (or even equivalent-quality) RTC output.
  Flagging this explicitly rather than assuming it's fine — worth a sanity
  check against the first real job's output once one exists.
- `gdal-bin` hard-depends on `python3-gdal` (not just a Recommends —
  confirmed by testing `--no-install-recommends`, which didn't remove it),
  and apt's own numpy install for that package conflicted with pip trying
  to install the pinned `numpy==2.4.2` (pip can't uninstall a dpkg-managed
  package — no RECORD file to work from). Fixed with `--ignore-installed`
  rather than fighting the apt dependency tree.
- GDAL's Python bindings compile C++ extensions, not just C — needed
  `g++` in addition to `gcc` (needed for psycopg2). Neither was present in
  the minimal base image; this only surfaces once you actually try to
  build the wheel, not from reading the Dockerfile.
- The job definition's Secrets Manager `valueFrom` ARN was missing the
  random 6-character suffix AWS appends to every secret
  (`...cdse-credentials` vs. the real `...cdse-credentials-F3xPeG`).
  ECS/Batch's secret injection requires either the *exact* full ARN or the
  bare secret name — a partial ARN silently fails to resolve at container
  start. Caught by describing the real secret and diffing against the job
  definition before ever submitting a job against it; fixed by
  re-registering the job definition (now revision 2 — Batch keeps job
  definition revisions automatically, so the backend's
  `SAR_BATCH_JOB_DEFINITION=wildfiredashboard-sar-job` setting needed no
  change, since submitting by name always resolves to the latest active
  revision).

### Reassessment: does the original plan still hold?
Yes, with one caveat worth carrying forward rather than one that changes
the plan. The architecture, resource shapes, and cost-safety guards
(fixed timeout, no auto-retry, least-privilege everywhere) all match what
was designed in "SAR compute dispatch" above — nothing about the actual
provisioning forced a redesign, only build-environment fixes (Ubuntu
24.04 package/pip specifics) and one AWS-account-quota workaround (inline
→ managed policy), both mechanical, neither touching methodology. The one
thing that *is* new information, not just implementation detail: the
SNAP 10.0→13.0 version jump. It doesn't change anything about Phase E's
design, but it does mean the "first real run" (next step) is now also the
first check that RTC processing on the newer SNAP version behaves the way
the original pipeline's validated methodology assumed. If that first run
produces obviously wrong output (e.g. change-detection values wildly
inconsistent with the fixed 2.9 dB threshold's expected behavior), that's
the signal to actually dig into SNAP version differences rather than
assume the pipeline logic itself is broken.

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
