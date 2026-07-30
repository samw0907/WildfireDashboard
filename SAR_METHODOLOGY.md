# SAR Change-Detection Methodology — Deep Reference

Purpose: understand the *LAwildfireSAR* pipeline's actual science in enough
depth to adapt it responsibly for arbitrary new fires, not just reuse its
code mechanically. Written before touching the scene-picker rework or
compute-dispatch architecture, per explicit direction — this is the
"understand it properly first" document, not a decision log (see
`DECISIONS.md` for that once choices are actually made).

Everything below is grounded either in the actual `LAwildfireSAR` source
code/README/handoff doc (read in full — not assumed) or in external
literature verified via search, cited inline. Nothing here is from memory
alone.

---

## 1. What the pipeline actually does, stage by stage

### 1.1 Scene search & selection
Sentinel-1 IW GRD, dual-pol (VV+VH), a single fixed orbit direction and
relative orbit ("track") for the *entire* multi-date set on both sides.
Track 64 was chosen over the alternative ascending pass (Track 137) after
discovering Track 137's IW3 burst boundary cuts through the Eaton fire
area, leaving no valid data there — this is exactly the "AOI coverage %"
problem our own scene picker already checks for, confirming that check is
directionally correct, not a nice-to-have.

### 1.2 RTC processing (pyroSAR/SNAP)
`process.py` calls pyroSAR's `geocode()` with `terrainFlattening=True,
refarea="gamma0"` — full **radiometric** terrain correction (gamma-nought
backscatter), not just geometric orthorectification. This matters:
geometric-only correction (e.g. Google Earth Engine's default
`COPERNICUS/S1_GRD`, confirmed via Earth Engine's own dataset docs) fixes
*where* a pixel sits on the map but not the fact that backscatter
intensity itself still depends on local incidence angle — a slope facing
the sensor reads brighter than one facing away, for purely geometric
reasons unrelated to any real change on the ground. Radiometric terrain
flattening corrects for that. In wildfire terrain (mountains, complex
topography — common across the western US), skipping this step risks
mistaking terrain-geometry artifacts for fire-related change.

No AOI clipping happens at this stage (`shapefile=None` — "clip in
analysis") — the **entire scene** gets RTC-processed, which is why disk
usage is large (tens of GB) regardless of how small the fire itself is.

A **local incidence angle (LIA) raster** is also produced per scene,
later used to flag buildings on radar-unreliable terrain (§1.6).

### 1.3 Multi-temporal compositing — the piece we hadn't built
`composite.py` builds a **pixel-wise median** across multiple dates on
each side (3 pre-fire, 3 post-fire in the original run), not a
single-date comparison. Median was a deliberate upgrade from mean
(`nanmean` → `nanmedian`, logged in the handoff doc as "Improvement 1"),
specifically because median can outvote a single anomalous scene — the
code comment gives the concrete example of a rain event causing a
wet-soil backscatter spike in one acquisition. **Median of 2 values is
mathematically identical to their average — it provides no such
protection.** At least 3 dates are needed for median to do anything a
mean wouldn't already do.

Every scene composited together — on both the pre and post side — must
share the same relative orbit. Compositing scenes from different tracks
would mix genuinely different viewing geometries into one "average,"
undermining the whole point of RTC in the first place.

All four composites (pre/post × VV/VH) are aligned to one master
reference grid (first pre-event VV scene) — a real bug was found and
fixed here during the original build (~136m/7-pixel misregistration
between pre/post composites before this was added).

**External corroboration**: multi-temporal stacking/averaging for
speckle reduction is established, actively-researched SAR practice —
literature describes ratio-based multi-temporal filtering, temporal
averaging combined with spatial filtering, and median operators
specifically for outlier robustness while preserving edges. This is not
a one-off choice specific to this pipeline.

### 1.4 Change detection
```
Change_VV = post_VV − pre_VV     (subtraction in dB space = log-ratio in linear space)
Change_VH = post_VH − pre_VH
Combined  = √(Change_VV² + Change_VH²)
```
VV is more sensitive to surface-roughness change (rubble, debris); VH is
more sensitive to structural/double-bounce scattering loss (walls).
Combining both is meant to improve separability between damaged and
undamaged buildings versus using either polarization alone.

### 1.5 Thresholding — the single most important finding in this whole review
```
Destroyed:          mean change ≥ 2.9 dB
Possibly affected:   mean change ≥ 1.74 dB (= 2.9 × 0.6)
No damage:           below 1.74 dB
```
**These numbers are not a physical constant or an industry-standard
fixed value. They were empirically calibrated** (`validate.py`,
`calibrate_threshold()`) by sweeping 0.5-10.0 dB in 0.1 dB steps against
**CAL FIRE DINS** (physical, human building-inspection records) and
picking the F1-maximizing value, separately for each fire (2.7 dB Eaton,
3.1 dB Palisades), then averaging to 2.9 dB. Per-event thresholds were
explicitly considered and rejected — but only because the F1 difference
between using each fire's own optimal threshold vs. the shared 2.9 dB was
under 0.005. That convergence is evidence the two fires were similar
enough to share a threshold (both Southern California WUI/chaparral
fires, same season, similar building density) — **it is not evidence
that 2.9 dB generalizes to fires with different vegetation, climate,
terrain, or building density elsewhere in the US.** See §3.

The 0.6 ratio between the "possibly affected" and "destroyed" boundary is
inherited from the original classification logic, not independently
derived.

### 1.6 Building-level classification
Building footprints come from **Microsoft's Global ML Building
Footprints** dataset (a California-specific GeoJSON was used, ~3.5GB) —
**not OpenStreetMap**, which is what our dashboard's existing exposure
feature already uses. Each footprint gets a zonal-stats mean of the
combined-change raster; buildings with no radar pixel centroid falling
inside their footprint get `no_data` (not silently "no damage" — an
explicit, deliberate choice, see §1.7).

Buildings with mean local incidence angle > 60° get overridden to
`geometry_limited` — terrain facing away from the radar, backscatter
unreliable regardless of the change value. **This was never actually
exercised in the original validation**: zero buildings were flagged,
because Altadena/Pacific Palisades sit on flat alluvial/coastal terrain.
The handoff doc states plainly: "Code is correct for steep-terrain
events" — meaning the logic is sound but its real-world behavior against
ground truth in genuinely mountainous terrain is untested.

`all_touched=True` (a looser zonal-stats sampling mode that would
capture more small buildings) was considered and explicitly rejected —
documented reasoning: "not industry standard at 20m resolution," causes
neighborhood backscatter contamination for small buildings.

### 1.7 Validation against ground truth
CAL FIRE DINS records matched to buildings within 25m, binarized
(Destroyed/Major = damaged; everything else = not damaged). Buildings
flagged `no_data` or `geometry_limited` are **excluded from the metrics
denominator**, not counted as "not damaged" — an explicit fix logged in
the handoff doc ("Improvement 3"), because the earlier version was
silently deflating the false-negative count.

**Result**: F1 ≈ 0.80 on both fires (precision 0.72-0.75, recall
0.87-0.89 — deliberately recall-favoring, reasoning given: missing a
damaged structure costs more than a false alarm in an emergency-response
context).

---

## 2. External verification against the literature

Checked rather than assumed:

- **F1 benchmark claim**: the README states F1 ~0.80 is "consistent with
  published benchmarks... UNOSAT and Copernicus EMS typically report
  0.72-0.85." A search turned up a study validating Sentinel-1 SAR
  building damage detection against UNOSAT ground truth reporting
  **precision 87.5%, recall 78.8%, F1 0.828** — in the same range, and
  directionally consistent (that study leaned precision-favoring, this
  pipeline deliberately leans recall-favoring — different threshold
  philosophy, similar achievable ceiling).
- **Post-event timing**: literature confirms the general principle (tighter
  before/after gaps reduce false positives; next-generation SAR missions
  aiming for near-real-time acquisition specifically to shrink this gap
  further). It also surfaces a **wildfire-specific confound the original
  README doesn't fully spell out**: burn scar and vegetation-structure
  change from the fire itself can inflate the same change signal used to
  detect structural damage, since a building footprint's 20m pixel
  neighborhood often includes burned vegetation immediately adjacent to
  it. This is a real, separate risk on top of "avoid the active
  suppression phase."
- **Multi-temporal median compositing**: confirmed as established,
  actively-researched SAR practice, not a one-off choice (§1.3).

---

## 3. The central open problem: no ground truth for new fires

Everything in §1.5 hinges on CAL FIRE DINS — physical building
inspections, compiled by human surveyors, available only **weeks after**
a fire is contained, and **California-specific**. For an arbitrary new
fire tracked by this dashboard — potentially anywhere in the US, any
vegetation type, any season, any terrain, any building density — there is
no equivalent ground truth available at the time we'd want to run the
analysis, and likely none ever, for most fires. This means:

- We cannot calibrate a threshold per-fire the way the original pipeline
  did — there's nothing to calibrate against.
- Applying the existing 2.9 dB threshold to a new fire is an
  **assumption of generalizability**, not a validated fact. It was shown
  to generalize between two similar Southern California WUI fires in the
  same event window — that's a much narrower claim than "generalizes
  nationally."
- The LIA-based geometry flagging logic is sound in principle but
  practically untested against real ground truth in steep terrain (§1.6).

This isn't a reason to abandon the approach — it's the actual scientific
constraint any operational deployment of this method faces, and matches
exactly what the original README already says about ICEYE's own
commercial service: the *method* mirrors real operational practice; what's
different for us is we won't have a per-event validation step ICEYE's
paying customers presumably get some version of.

---

## 4. Adaptation gaps identified here — all now resolved, see §6-9

At the time this section was first written, none of these had been
decided yet. They have all since been resolved through discussion — see
§6 (building dataset), §7 (threshold/calibration), §8 (fallback design +
search window), §9 (final implementation plan). Kept here as the
original open-questions framing for context on how each was reasoned
through.

- **Post-fire search window has no minimum offset today.** Our current
  `AFTER_WINDOW` starts at the fire's discovery date (day 0) — the
  original project specifically avoided anything earlier than 14 days
  post-ignition to dodge the active-suppression confound (retardant,
  vehicles, debris). **Resolved in §8: adding a 14-day floor.**
- **Building footprint dataset**: Microsoft Global ML Building Footprints
  (what was validated) vs. OpenStreetMap (what our dashboard already
  integrates). Not a free substitution — the F1 numbers above are tied to
  Microsoft's dataset specifically. **Resolved in §6: OSM.**
- **Single look angle**: the original pipeline used ascending-only and
  explicitly names a second (descending) look angle as a documented
  future improvement. Our scene picker already supports either direction
  per fire, whichever has full coverage — already a slight improvement on
  the original's fixed choice, not a gap. No action needed.
- **Honesty framing for output**: given §3, any building-damage output
  this produces for a new fire should be labeled as provisional/
  indicative and explicit about which fire(s) the threshold was actually
  validated against — not presented with the same confidence as the
  original README's own (properly earned, DINS-validated) figures.
  **Carried into §9's Phase E requirement.**

---

## 5. Critical analysis — strengths, weaknesses, what I'd do differently

Written after reading all five pipeline modules closely, not just the
README's narrative. The pipeline is genuinely well-engineered — the team
caught and fixed real mistakes during its own build (mean→median, the
no-data validation-exclusion bug, a ~136m composite misregistration).
This section is deliberately more critical than the README, on purpose:
understanding where the load-bearing science ends and the
calibrated-to-these-two-fires specifics begin is exactly what's needed
before adapting this for arbitrary new fires.

**Real strengths**: full radiometric terrain flattening (gamma0), not the
geometric-only shortcut simpler SAR pipelines settle for; median
compositing, correctly reasoned and iterated into rather than a first
guess; excluding no-signal buildings from the validation denominator
instead of miscounting them as "undamaged"; LIA-based geometry flagging,
forward-thinking even though never actually exercised in validation
(flat terrain in both study fires).

**Where I'd push back:**

1. **F1-maximization isn't the same as recall-prioritization**, even
   though the README frames it that way. The threshold sweep optimized
   for F1 and *got* a recall-favoring result for these two fires — that's
   what fell out of the data, not something directly optimized for. A
   different fire's F1-optimum could just as easily land precision-
   favoring. If recall-priority is genuinely the operational goal (missing
   a damaged structure costs more than a false alarm), the more direct
   approach is optimizing for that explicitly (F2 score, or "maximize
   precision subject to recall ≥ some floor") rather than hoping F1-optimal
   happens to land there.
2. **No mitigation for the burn-scar/vegetation confound** (found via
   literature, not the original docs): burned vegetation immediately
   adjacent to a building can inflate the same combined-change signal used
   for structural classification, since a 20m pixel touching a building's
   edge often also touches scorched ground right next to it. Highest risk
   exactly where this matters most - buildings at the wildland-urban
   interface edge. No masking or cross-check exists for this.
3. **Median of 3 protects against one bad scene, not two.** If a regional
   weather event contaminates 2 of 3 dates on one side, the median simply
   reflects the contaminated majority. Real and narrow - much better than
   a single date or mean-of-2, not bulletproof. (This is the actual
   scientific argument for the flexible-5 option raised and set aside
   earlier for simplicity - worth knowing that tradeoff was real.)
4. **The small-patch noise filter doesn't reach building classification.**
   `change.py`'s minimum-mapping-unit filter (0.1ha) is applied to the
   vectorized burn-mask, but `buildings.py` classifies each building
   directly off the raw zonal-mean value with no equivalent spatial-
   coherence check. A building can be classified "destroyed" off what's
   essentially a noisy single-pixel read, with no cross-check against a
   spatially coherent damage cluster nearby - a structural asymmetry
   between the two output paths that neither doc calls out.
5. **No use of interferometric coherence.** This approach uses only
   backscatter *intensity* change. SAR *coherence* (phase-based
   decorrelation between passes) is a genuinely different, sometimes
   better-performing family of method for structural-disruption detection
   in the disaster-damage literature. Real methodological alternative, not
   a "should fix" - it needs SLC data and precise interferometric
   co-registration, a substantially bigger technical lift than GRD
   intensity change detection, and doesn't belong in scope here.

None of this means the pipeline is wrong - the F1 ≈ 0.80 result and the
corroborating literature both say the core method works. It means
adapting it should be done knowing which parts are load-bearing science
(RTC, median compositing, dual-pol combination) versus calibrated-to-
these-two-fires specifics (the exact threshold, the flat single-cutoff-
for-all-buildings approach) versus genuine open gaps (vegetation
confound, coherence, the classification/noise-filter asymmetry).

## 6. Building footprint dataset decision (resolved 2026-07-30)

**Decision: OpenStreetMap, not Microsoft Global ML Building Footprints**
(what the original pipeline validated against). Reasoning:
- Using a different building dataset than the dashboard's existing
  exposure feature would mean two different building inventories for the
  same fire visible on the same page (exposure stats vs. a SAR damage
  map) - a coherence problem for a portfolio piece that matters more than
  it might elsewhere.
- Microsoft's footprints are large per-state static files, not a
  queryable API like Overpass - adopting them means real new
  infrastructure (download management, storage) this project has
  deliberately avoided adding without a strong reason.
- The honest cost: the validated F1 ≈ 0.80 is tied to Microsoft's
  footprint geometries specifically (zonal-stats sampling is sensitive to
  exact polygon edges) and doesn't transfer to OSM even in principle.
  This was judged an acceptable tradeoff specifically because §3 already
  means that number can't be fully claimed for a new fire either way, in
  the absence of per-fire ground truth - OSM's consistency/infrastructure
  advantages win without giving up much that was actually still valid to
  claim. Document this explicitly wherever SAR results are surfaced: not
  "this achieves F1 0.80" but "this method achieved F1 0.80 in validated
  conditions against a different building dataset; applied here without
  per-fire validation."
- Building footprints as their own visible map layer (not just used
  internally for damage classification) was raised as a related future
  idea - logged to `PROGRESS.md` backlog, not in scope now.
- **Confirmed we already have what's needed**: `overpass.py` builds real
  `shapely.Polygon` geometries from OSM way data (not just points or
  counts), cached per fire as a full GeoJSON FeatureCollection in
  `building_cache` (2400m buffer extent - comfortably covers anything at
  or near the perimeter). The zonal-statistics step (`buildings.py`'s
  core operation) can run directly against data already on disk for any
  fire we've computed exposure for - no new building-data pipeline is
  needed, which is a smaller lift than initially assumed.

## 7. Threshold calibration for new fires (discussed 2026-07-30)

Clarified: we are not trying to replicate the exact validated F1 for a
new fire - only the *methodology/approach*. Anything specific to the two
original fires (the exact 2.9 dB value) can be swapped for a value we
reason about ourselves, understood honestly as not independently
validated for whatever new fire it's applied to.

**Auto-recalibration was raised as an idea** (a "reprocess with
recalibration" action once outputs exist) - real kernel, but blocked on
a specific thing: `validate.py`'s calibration sweep isn't just trying
thresholds and picking one that looks better, it computes precision/
recall/F1 against CAL FIRE DINS - real human building-inspection records
confirming actual ground truth. Without equivalent ground truth for a
new fire, there's nothing to calibrate *against*; a threshold sweep with
no ground truth isn't calibration.

**Substitutes considered, in order of how much validity they'd actually
buy:**
1. A fixed, reasoned default threshold (no per-fire calibration at all) -
   simplest, most honest, matches how every other imported-methodology
   gap has been handled so far. **Decision: go with this for now.**
2. Loose calibration against a publicly reported aggregate "structures
   destroyed" count for a fire, if/when one becomes available (NIFC
   incident updates, state emergency management reports - not real-time,
   inconsistent coverage). Meaningfully weaker than DINS: matching a
   total count doesn't confirm the *right* buildings were flagged, just
   that the count sums correctly, which can hide a bad classification
   pattern. Logged as a genuine future idea, not built now.
3. A manual "reprocess with a different threshold" control, usable later
   if real outcome data for a specific fire ever surfaces - plausible and
   cheap to build later, but a manual re-run, not automated calibration.

**Decision: option 1 now, options 2/3 logged as backlog ideas** - this is
blocked on ground-truth data availability, not effort; building toward
auto-calibration now would mean solving a ground-truth-sourcing problem
before the base pipeline even works end-to-end.

## 8. Fallback design: not every track will have 3 scenes available (2026-07-30)

Raised as a real risk, not assumed away: will a given fire's search
windows reliably yield 3 same-track scenes on both the before and after
side, which Composite mode (§ above, §"composite size" in `DECISIONS.md`)
requires?

**Empirical grounding, not guesswork**: live tests earlier this session
(Aspen Acres fire) showed ~12 candidate scenes spread across 4 tracks in
a 21-day "before" window - averaging ~3 dates per track, consistent with
Sentinel-1's current ~6-day effective revisit (two operational
satellites, S1C/S1D, sharing the same ground tracks 180° out of phase).
So 3-per-track is often achievable with today's constellation, but not
guaranteed - satellite outages, edge-of-swath geography, or unlucky
timing relative to a fire's discovery date will occasionally leave a
track short, especially on the "after" side for a very recently
discovered fire (less accumulated revisit time to work with).

**Decided mechanism:**

1. **Surface track sufficiency proactively in the picker, before
   individual scene selection.** The `/candidates` endpoint already
   returns `relative_orbit` per scene on both sides - no backend change
   needed for this part, just frontend grouping: a per-track summary
   (e.g. "Track 64 (ASCENDING): 3 before, 4 after" / "Track 151
   (ASCENDING): 2 before, 1 after") so the best track is obvious at a
   glance instead of something to count out manually.
2. **Exactly two supported modes, deliberately no ambiguous middle
   tier**: **Composite** (exactly 3+3, preferred) or **Single-pair**
   (exactly 1+1, fallback). A "2" tier was explicitly rejected - it would
   look more rigorous than a single pair while providing the exact same
   zero outlier-robustness as median-of-2 (see the composite-size
   reasoning in `DECISIONS.md` - median of 2 is mathematically identical
   to a mean).
3. The picker auto-switches into Single-pair mode (select exactly 1 each
   side instead of 3) when the chosen track can't support Composite, with
   a visible warning: *"Only single before/after scenes available on this
   track - results won't benefit from multi-date noise averaging and may
   be less reliable."*
4. **Backend `/select` schema** needs to accept either exactly 3 or
   exactly 1 scene per side (same track across whichever count is used) -
   not always-3 as originally scoped before this discussion happened.
5. **Compute pipeline branches on mode**: Composite mode runs
   `composite.py`'s median build before change detection as designed;
   Single-pair mode skips compositing entirely and feeds the one
   RTC-processed scene per side straight into `change.py`'s log-ratio
   step. Everything downstream (buildings classification, thresholding)
   is identical either way.
6. **Results must visibly label which mode ran** - "Composite (3+3)" vs.
   "Single-pair (1+1) - reduced reliability" - never ambiguous after the
   fact once a job completes.

Also decided alongside this: the "after" search window in
`routers/acquisition.py` currently starts at the fire's discovery date
(day 0) with no floor. The original pipeline specifically avoided
anything earlier than 14 days post-ignition (active-suppression confound
- retardant, vehicles, debris disturbance, §1 above). **Adding the same
14-day minimum floor** before the picker rework ships.

## 9. Final implementation plan (confirmed 2026-07-30 — ready to build)

Everything above is now decided, not open. Full phase breakdown lives in
`PROGRESS.md` under "Compute dispatch + results display" (Phases A-E) -
that's the authoritative build checklist going forward, kept in sync with
this doc. Summary for orientation:

- **Phase A** - data model: scene lists (not singles) supporting
  exactly-3 or exactly-1 per side, same-track validation across all
  selected scenes, 14-day search-window floor.
- **Phase B** - scene picker rework: per-track sufficiency summary,
  multi-select, track-locks-on-first-pick, Single-pair fallback UI +
  warning copy, map layer showing all selected footprints.
- **Phase C** - pipeline adaptation: new scene-ID-driven entrypoint,
  mode-branching compositing step, OSM-based building classification,
  `validate.py` dropped, Dockerized, pushed to ECR.
- **Phase D** - AWS infrastructure: Batch on Fargate, job queue/
  definition with a hard timeout, IAM, `/confirm` → `submit_job`, polling
  loop for job status.
- **Phase E** - results display: new status states, Fire Detail UI
  section, honest accuracy framing (mode label, non-transferred F1,
  uncalibrated threshold) baked into the copy itself, not just this doc.

Also see `DECISIONS.md`'s "SAR compute dispatch — full architecture +
methodology decisions" entry for the AWS-vs-GEE reasoning and cost
estimate, which lives there rather than being duplicated in full here.
