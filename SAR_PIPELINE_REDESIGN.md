# SAR Pipeline — Fresh Redesign vs. Current Implementation

**Purpose**: `SAR_RESULTS_ASSESSMENT.md` diagnosed specific problems in what we
currently produce. This doc goes a level deeper, as asked: start from real
external practice (researched, not assumed - sources at the end), design what
a SAR wildfire-damage pipeline *should* look like stage by stage, then diff
that against what we actually built. Every stage below ends with a clear
call: **keep as-is**, **simple win** (safe to just do), or **real tradeoff**
(needs a decision, pros/cons given).

---

## 0. What real-world practice actually looks like — condensed findings

Checked live, not recalled from training data:

- **Copernicus EFFIS (the EU's actual operational wildfire mapping body)**
  uses **optical imagery (MODIS/Sentinel-2) as its primary burned-area
  source**, via a "semi-automatic procedure" — unsupervised classification
  **followed by human visual verification and correction**. SAR is not
  their primary tool. This matters: SAR's real operational niche is
  seeing *through smoke and cloud* when optical can't, not replacing
  optical when both are available. Worth being honest that a genuinely
  complete system would cross-check against optical, not rely on SAR
  alone.
- **ICEYE's own real commercial wildfire product** (their public building-
  level Wildfire Insights page) delivers exactly the *shape* of output we
  already build: binary `destroyed`/`undamaged` per building point or
  footprint, vector format, within 24 hours of impact. **Our output shape
  is not wrong or non-standard** — the gap is entirely in validation and
  noise-handling, not in what we're trying to produce. They don't publish
  accuracy or validation methodology on the marketing page (expected), so
  we can't directly compare our F1 against theirs — but it's reasonable to
  assume they have far more continuous, real-world calibration signal
  (insurance claims feeding back over many past events) than any one
  fixed threshold could offer, which is a structural advantage a personal
  project can't replicate, not a methodology secret.
- **Academic Sentinel-1 burned-area literature** uses richer feature
  engineering than a single combined-magnitude number: radar burn
  difference (RBD), logarithmic radar burn ratio (LogRBR), delta radar
  vegetation index (ΔRVI), delta dual-pol SAR vegetation index (ΔDPSVI) —
  and increasingly CNN/deep-learning classifiers trained on full time
  series, not a fixed dB cutoff at all.
- **Unsupervised/automatic thresholding is a real, established, ground-
  truth-free alternative to a fixed threshold**: Otsu's method and
  particularly the **Kittler-Illingworth (K&I) minimum-error algorithm**
  are specifically documented as generalized for SAR's non-Gaussian
  amplitude statistics (not just borrowed from optical image processing
  as-is) and used exactly for "detect change with no ground truth
  available" scenarios — which is precisely our situation for every new
  fire.
- **Despeckling is standard practice we currently skip entirely.** Lee/
  Refined-Lee/Frost/Kuan (single-image spatial filters) and newer
  multitemporal methods (RABASAR, non-local means) are the norm before
  differencing two SAR images. Our pipeline relies *entirely* on multi-
  date median compositing for noise reduction — which doesn't exist in
  Single-pair mode, meaning every real run so far has had **zero**
  despeckling of any kind.
- **Minimum mapping unit (MMU) standards run coarser than what we use.**
  A commonly cited flexible guideline is ~1 ha; Sentinel-2-based practice
  commonly uses 6.25 ha. We inherited **0.1 ha** from the original LA
  pipeline — an order of magnitude finer than typical guidance, which
  lets far more small noise patches survive the filter than standard
  practice would.
- **Interferometric coherence** (phase-based decorrelation, not backscatter
  intensity) is a real, earthquake-proven alternative family for building-
  level damage - "damaged buildings show low coherence." Needs SLC data
  and precise co-registration - a real technical lift, already correctly
  scoped out of `SAR_METHODOLOGY.md` §5.
- **A 2025 paper specifically on post-wildfire building damage (Palisades
  fire) uses InSAR *deformation*** (thermal expansion/contraction,
  subsidence, soil moisture loss) rather than backscatter intensity at
  all — a genuinely different physical signal, very recent, very
  fire-specific precedent. Full text was paywalled; noting it as a real
  alternative worth knowing exists, not something to chase now.
- **ICEYE's real, published resolution: Strip mode 3m, Spot mode down to
  0.5m** (confirmed via ICEYE's own product documentation) — vs.
  Sentinel-1 IW's ~20m. This is the structural reason ICEYE can likely
  despeckle safely where we can't (see §1.2's revision below): a typical
  house footprint (~100-300 m²) spans **dozens to hundreds of ICEYE
  pixels** at 0.5-3m resolution, but is often **smaller than one single
  Sentinel-1 pixel** at ~20m (a 20m pixel covers ~400 m² on the ground).
  A spatial filter averaging over a small neighborhood barely touches a
  building that already occupies hundreds of its own pixels; the same
  filter can erase a building's entire signal when it barely fills one
  pixel to begin with. This isn't a gap in our methodology - it's a
  structural consequence of using free, medium-resolution Sentinel-1
  instead of ICEYE's own (commercial, fine-resolution) constellation, and
  is worth being able to say exactly that in an interview.

---

## 1. Rebuilding the pipeline stage by stage

### 1.1 Scene selection
**Ideal**: same-track, same-viewing-geometry scenes on both sides, tightest
reasonable date window, avoiding the active-suppression period.
**Current**: exactly this, already reasoned through in `SAR_METHODOLOGY.md`
§8 (track/coverage ranking, 14-day post-ignition floor). **Verdict: keep
as-is** — this stage is already sound and already the product of real
iteration (the coverage-completeness bug caught mid-session was fixed).

### 1.2 Preprocessing — RTC + despeckling
**Revised after discussion - this was originally called a "simple win"
below; that was wrong, or at least incomplete, and worth recording why.**

**Ideal**: radiometric terrain correction (already done) **plus** noise
reduction before differencing - but *which* noise-reduction technique
depends entirely on what's being measured, and treating "despeckling" as
one undifferentiated fix is the mistake to avoid.

**The real tension, raised directly and correctly**: a spatial despeckling
filter (Lee, Refined Lee, etc.) works by averaging over a local pixel
neighborhood. That's exactly right for a large, spatially homogeneous
target - a forest canopy, a grassland - where the true signal doesn't vary
much within the filter window, so averaging removes noise without
removing signal. **A building is not that.** At Sentinel-1's ~20m
resolution, a house is frequently *smaller than one pixel* (§0's ICEYE
comparison makes the scale gap concrete). Averaging a small spatial
window around a building-sized target doesn't reduce noise while
preserving signal - it blends the building's own (already marginal) pixel
value into surrounding ground that may not have changed at all, which
can just as easily erase real building-scale signal as remove noise. This
is a genuinely known SAR tradeoff (edge-preserving filters exist
specifically to fight this, but even they have real limits at
sub-pixel-scale targets), not something specific to our pipeline.

**Two different problems need two different treatments**:
1. **Burn-extent computation** (the vectorized patches/perimeter,
   operating over large, genuinely homogeneous vegetated/burned areas) -
   spatial despeckling is appropriate here and would directly help. This
   is where the "simple win" framing was actually correct.
2. **Building-level classification** (single small targets) - spatial
   despeckling is the wrong tool, for the reason above. The right lever
   for *this* specific noise problem is **temporal** averaging (multiple
   dates of the *same* pixel location, i.e. genuine Composite mode) or
   **spatial-coherence corroboration across neighboring buildings/patches**
   (§1.6) - neither of which blurs a building's own signal into
   unrelated adjacent ground, because neither averages across space at
   a single point in time.

**Verdict, revised**: despeckle the raster used for the burn-extent/patch
computation (real, safe win); do **not** apply the same filtered raster to
building-level sampling — keep that path on the unfiltered signal, or a
much smaller/edge-aware filter, and lean on §1.6's spatial-corroboration
idea to fight single-pixel noise at building scale instead. This is no
longer a "just do it" item - it needs the two paths to actually be kept
separate in the pipeline, which is a real (if bounded) implementation
change, not a one-line addition.

**Final decision (implemented 2026-08-01): no spatial despeckling filter
was added, for either path.** Re-examined once it came time to actually
build it: a real Lee/Refined-Lee implementation is itself an unvalidated
new knob (window size, edge threshold) with no ground truth to tune it
against, on top of everything else already true. Given Single-pair mode
already has zero multi-date averaging and, per direct discussion, that's
a constraint we simply have to live with rather than solve away - the
cheaper, lower-risk moves were taken instead: the MMU bump (§1.5) directly
removes the small noise patches a burn-extent despeckle filter would have
targeted, and a purely cosmetic polygon-smoothing step
(`smooth_for_display()`) removes the *visual* blockiness without touching
any actual pixel value or reported statistic. Building-level noise is
handled by §1.4/§1.6's dual-threshold-confidence and spatial-corroboration
mechanisms instead of a filter. Logged as a real, deliberate non-action,
not an oversight - revisit only if a genuine multi-look/finer-resolution
source becomes available.

### 1.3 Change detection feature
**Ideal**: at minimum, the combined dual-pol magnitude we already compute;
richer options exist (RBD, LogRBR, ΔRVI/ΔDPSVI) but add real complexity for
uncertain benefit without a validation set to check whether they actually
help *for us*.
**Current**: `√(ΔVV² + ΔVH²)` - a reasonable, defensible, literature-
grounded choice (this exact combination is directly discussed in
`SAR_METHODOLOGY.md` §1.4).
**Verdict: keep as-is.** Richer feature engineering is a real option but
belongs in "log as a future idea," not a change to make now — we have no
way to check whether it actually improves anything without ground truth,
and added complexity without a way to validate it is its own risk.

### 1.4 Thresholding
**Ideal**: per-scene adaptive thresholding (Otsu/K&I) that lets each
fire's own change-image statistics set its own cutoff, rather than
assuming one number transfers everywhere.
**Current**: one fixed 2.9 dB value, borrowed from two Southern California
WUI fires, applied identically to every fire regardless of vegetation,
terrain, climate, or season - already flagged as the "central open
problem" in `SAR_METHODOLOGY.md` §3.
**Verdict: real tradeoff, worth a genuine discussion.**
- *For switching to K&I/Otsu*: it's ground-truth-free (doesn't need DINS-
  style validation, so it's not blocked on the thing we don't have),
  well-established specifically for SAR's amplitude statistics (not a
  naive optical-thresholding transplant), and directly answers "why apply
  a California number to a fire in Montana" with "we don't — we derive it
  fresh each time."
- *Against*: it's a new, unvalidated-for-us method itself - we'd be
  swapping "an unvalidated borrowed constant" for "an unvalidated
  adaptive method," not for something proven better *for our exact use
  case*. It could also behave badly on a fire with very little real
  change (adaptive thresholding assumes a genuine bimodal split exists in
  the data; a small or patchy fire might not produce one).
- *Middle ground, confirmed as the direction to take*: keep computing the
  fixed 2.9 dB result exactly as now (comparable across fires, already
  documented), and **also** compute the K&I/Otsu adaptive threshold for
  that fire's own statistics - not as a second, separate, competing
  output, but as a **confidence signal on the existing one**. Concretely:
  classify every building under *both* thresholds. Where they agree
  ("destroyed" under both the borrowed constant and the fire's own
  data-driven value), that's a real, corroborated finding, dial up
  confidence in it. Where they disagree, that's precisely a marginal/
  threshold-sensitive case - flag it as "uncertain" rather than asserting
  either answer. This turns "we have two threshold candidates, which do
  we believe" from a conflict into a genuine per-building confidence
  measure, and directly targets the exact problem raised earlier (a
  single borrowed threshold deciding a building's fate with nothing to
  check it against) without needing ground truth to do it. Real cost: a
  third output category to explain to users ("uncertain - threshold-
  sensitive"), and a case where adaptive thresholding itself fails to
  find a clean split (very little real change in a small/patchy fire) -
  worth deciding what "uncertain" means procedurally in that case too
  (fall back to fixed-only, most likely).

**Implemented 2026-08-01, exactly as the middle-ground above describes.**
`change.py`'s `compute_otsu_threshold()` implements Otsu's method from
scratch in pure numpy (histogram + between-class-variance maximization,
no new dependency) and returns `None` on the two degenerate cases (all-NaN
input, or a single uniform value with no split to find) rather than
guessing - `buildings.py`'s `compute_confidence()` treats a `None`
adaptive threshold as "not comparable" (`confidence: "n/a"` for every
building) exactly as anticipated above, so a patchy/low-signal fire
degrades gracefully to fixed-only instead of erroring. Verified against
synthetic bimodal data (correctly found the threshold between two known
clusters) and both edge cases before wiring it into the real pipeline.

### 1.5 Spatial filtering (minimum mapping unit)
**Ideal**: an MMU that reflects a real hectare-scale patch of genuine
change, not noise - actual practice runs coarser (1-6+ ha) than what we
inherited.
**Current**: 0.1 ha, unchanged from the original LA pipeline. Aspen Acres:
2,106 separate patches for one fire - a lot of that count is very likely
small noise fragments given §1.2's despeckling gap.
**Verdict: simple win, cheap to test - and this is not just a bonus, it
directly targets the false/noise patches themselves.** The MMU filter's
entire job is removing small patches unlikely to be real (already-
implemented logic, just tuned too fine) - a coarser MMU is the mechanism
that removes exactly the small, speckle-driven fragments responsible for
the checkerboard look and the inflated patch count (2,106 for one fire).
Complementary to, not a substitute for, §1.2's despeckling (which reduces
noise *before* thresholding); this trims what survives *after*
thresholding. Doing both is stronger than either alone. One-constant
change with an easy before/after check (rerun the same fire, compare
patch count and visual patchiness). Doesn't require resolving the
threshold question first - it's an independent knob.

**Implemented 2026-08-01**: `change.py`'s `MIN_PATCH_HECTARES` raised from
`0.1` to `1.0`. Given §1.2's final call to skip a real despeckling filter
entirely, this constant now carries more of the noise-suppression load
than originally planned - worth keeping in mind if a future fire's patch
count still looks noisy at 1.0ha; the next lever to pull would be this
constant again (toward the 6.25ha Sentinel-2 convention) rather than
revisiting despeckling.

### 1.6 Building-level classification
**Ideal**: some spatial-coherence requirement (a building's classification
corroborated by its neighborhood, not a single isolated pixel read) -
already named as a real gap in `SAR_METHODOLOGY.md` §5 point 4, now
visibly demonstrated by the checkerboard pattern itself.
**Current**: a single zonal-mean per building footprint, no neighborhood
cross-check, real building polygons plotted at true size (invisible at
map scale - see `SAR_RESULTS_ASSESSMENT.md` §3.1).
**Verdict: real tradeoff. Explained concretely below - this was too
abstract the first time round.**

**What happens today**: `buildings.py` takes one building's footprint,
reads the mean SAR-change value under just that footprint, and classifies
off that single number alone. Nothing about the building's surroundings
enters the decision at all. A building sitting on one lone noisy pixel -
speckle, not real change - gets called "destroyed" exactly as confidently
as one sitting in the middle of a huge, obviously-real burn scar. The
checkerboard pattern is direct visual proof that lone noisy pixels are
common, not rare.

**Option 1 - require spatial corroboration.** We already compute
MMU-filtered burn patches (§1.5) - real, spatially coherent, "not just
noise" zones, by construction (that's what the MMU filter is *for*).
Concretely: before trusting a building's own pixel value, check whether
that building's footprint actually falls inside one of those *surviving*
patches.
- Building A: pixel value says "destroyed," and it sits inside a real
  50-hectare burn patch that survived MMU filtering → keep "destroyed."
  Real, corroborated.
- Building B: pixel value also says "destroyed," but the "patch" it's
  sitting on was a 2-pixel speckle fragment that the MMU filter itself
  already discarded as noise → downgrade to "no_damage" (or a new
  "isolated signal only" class) instead of trusting one lone pixel.
This reuses work we already do (the patch polygons) as a gate, rather
than inventing new infrastructure - a real fix for the actual mechanism
of the noisy-single-pixel problem.

**Option 2 - keep the same math, change the label.** Building B above
still gets called "destroyed" (the math is unchanged), but the *word* is
different: instead of "Destroyed," the UI says something like "Building
within SAR-detected change zone - flagged for field verification." This
doesn't fix the underlying single-pixel sensitivity at all - it just
stops the *output* from asserting more certainty than a single unverified
pixel read can honestly support. Purely a communication-layer change, no
new code beyond copy/labels.

Not mutually exclusive - option 1 is the real fix, option 2 is honest
regardless of whether option 1 ships, since even *corroborated* damage
claims still have no per-fire ground truth behind them (§3 of
`SAR_METHODOLOGY.md`).

**Implemented 2026-08-01: option 1 (spatial corroboration), as its own
class rather than reusing an existing one.** `buildings.py`'s
`apply_spatial_corroboration()` checks each `destroyed`/`possibly_affected`
building's footprint against the MMU-surviving burn patches (`burn_gdf`,
threaded through from `change.py` via `entrypoint.py`) and downgrades
anything that doesn't intersect a real patch to a new **`unconfirmed`**
class - not `no_damage`, deliberately: Building B above genuinely did read
a positive signal at that pixel, it just isn't backed by anything
spatially coherent, which is a materially different claim from "measured
no change." Collapsing the two would have silently hidden the exact
single-pixel-noise problem this section was written to fix. `unconfirmed`
buildings are excluded from confidence comparison (`confidence: "n/a"`)
and from the frontend's usable-damage-percentage denominator, and get
their own color/legend entry everywhere the other classes appear (map,
static figures, Fire Detail legend, Reference page). Option 2's
label-softening was not needed on top - the new class name itself already
communicates "flagged, not asserted."

### 1.7 Output/figures
Already covered in depth in `SAR_RESULTS_ASSESSMENT.md` §3 (visibility
scale-mismatch bug, zoom-target bug) - not repeated here, but note that
whichever direction §1.6 goes changes what the figures should actually be
showing (individual building markers vs. flagged-zone polygons), so
`figures.py` shouldn't be touched until §1.6 is decided.

---

## 2. Recommended sequencing

**All four resolved and implemented, 2026-08-01** - see each subsection
above for the final call and reasoning:
1. ~~Bump the MMU from 0.1 ha toward the ~1 ha guideline~~ - done, raised
   to 1.0 ha (§1.5).
2. ~~Despeckle the burn-extent computation path~~ - final call was **not**
   to add a spatial filter at all, for either path; the MMU bump plus a
   cosmetic display-only smoothing step were judged the better-justified
   moves instead (§1.2, revised twice).
3. ~~Threshold: fixed-only vs. fixed+adaptive-as-confidence-signal~~ -
   built exactly as the combined approach (§1.4): Otsu-adaptive threshold
   computed alongside the fixed one, agreement/disagreement surfaced as
   per-building confidence.
4. ~~Building classification: spatial corroboration vs. softened
   language~~ - spatial corroboration (option 1) built, as a new
   `unconfirmed` class (§1.6).

Methodology is now considered settled for the current pipeline. Next
discussion (explicitly deferred until this point): imagery/figure output
design - see `SAR_RESULTS_ASSESSMENT.md` and `PROGRESS.md` for the
figures work already done, and revisit what (if anything) should change
about it now that the methodology underneath it has changed.

**Logged, not now:**
5. Richer change features (RBD/LogRBR/ΔRVI) - no way to validate benefit
   without ground truth we don't have.
6. Interferometric coherence / InSAR deformation - real alternative
   families, both a materially bigger technical lift (SLC data, precise
   co-registration) than anything else here, and both closer to what
   ICEYE's own far-finer resolution can support more easily than free
   Sentinel-1 data (§0).

## 3. Bugs found and fixed while investigating this (2026-08-01)

Not methodology questions - concrete, confirmed bugs, fixed same session:
- **`clip_to_perimeter()` nodata bug**: `rasterio.mask.mask()` was called
  without an explicit `nodata=` override, so pixels outside the fire's
  exact perimeter polygon (but inside its bounding box - `crop=True` only
  crops to the bbox, not the polygon) were filled with **0.0**, not NaN.
  Every downstream consumer assumed NaN. Result, confirmed against real
  Aspen Acres output: 504 buildings entirely outside the fire perimeter
  were classified `no_damage` instead of `no_data`, diluting the
  destroyed percentage from a true **88.3%** down to a reported **40.2%**.
  Fixed by passing `nodata=np.nan` explicitly to the mask call. Image
  rebuilt and pushed; needs a fresh acquisition run to take effect - the
  two existing completed results (Aspen Acres, Idaho fire) still carry
  the old, wrong numbers until re-run.
- **Building-damage layer z-order/color bug**: the generic all-buildings
  layer (slate gray, semi-opaque) was added to the map *after* the
  classified-damage layer, rendering on top and visually muting every
  classification color underneath. Fixed by reordering layer creation;
  also switched `DAMAGE_CLASS_COLORS` to fully saturated/opaque colors
  (destroyed/possibly-affected/no-damage) with a solid outline, since
  these polygons are tiny enough that anything less than maximum
  contrast disappears against a busy basemap.
- **Blocky/checkerboard burn-area map rendering** (the specific thing that
  prompted this whole review): not a bug in the sense of wrong output -
  `vectorise_mask()` was faithfully tracing genuine pixel boundaries, and
  Single-pair mode's total lack of despeckling (§1.2) made real speckle
  more visible than it would be in Composite mode. Addressed via
  `smooth_for_display()` - see §1.2/§1.5's final-decision notes above for
  the reasoning on why this is purely cosmetic (never touches
  `total_area_ha`/patch-count/corroboration) versus the actual noise-
  reduction moves (MMU bump) that address the underlying data question.

Image rebuilt and pushed to ECR, frontend rebuilt and redeployed with all
of §1.2-1.6's implemented changes plus the color/toggle/perimeter-match
work above (2026-08-01). No stored acquisition result reflects any of
this yet - both completed runs (Aspen Acres, the Boise-area fire) predate
every change in this section and need a fresh run to show the new
behavior.

---

## Sources

- [Fire - CopernicusLAC Platform](https://docs.copernicuslac.terradue.com/services/fire/intro/)
- [EFFIS - Rapid Damage Assessment](https://forest-fire.emergency.copernicus.eu/about-effis/technical-background/rapid-damage-assessment)
- [Deep Self-Supervised Disturbance Mapping with the OPERA Sentinel-1 RTC Product (arXiv)](https://arxiv.org/pdf/2501.09129)
- [Burned area detection and mapping using Sentinel-1 backscatter coefficient and thermal anomalies (ScienceDirect)](https://www.sciencedirect.com/science/article/pii/S0034425719303645)
- [A workflow based on Sentinel-1 SAR data and open-source algorithms for unsupervised burned area detection in Mediterranean ecosystems](https://www.tandfonline.com/doi/full/10.1080/15481603.2021.1907896)
- [A rapid and quantitative post-wildfire damage assessment of buildings in the 2025 Palisades fire based on InSAR (ScienceDirect)](https://www.sciencedirect.com/science/article/abs/pii/S2212420925006338)
- [Assessing the transferability of post-disaster building damage assessment using SAR and machine learning (ScienceDirect)](https://www.sciencedirect.com/science/article/pii/S2212420926000609)
- [Revolutionizing Wildfire Monitoring with ICEYE's SAR Technology](https://www.iceye.com/blog/wildfire-monitoring-with-sar)
- [Building level | Wildfire Insights for government | ICEYE](https://www.iceye.com/gov/building-level-wildfire-insights)
- [Detection of damaged urban areas using interferometric SAR coherence change with PALSAR-2](https://link.springer.com/article/10.1186/s40623-016-0513-2)
- [An Unsupervised Approach Based on the Generalized Kittler-Illingworth Algorithm for SAR Change Detection](https://rslab.disi.unitn.it/papers/R34-TGARS-change-detection-SAR-kittler.pdf)
- [Refined burned-area mapping protocol using Sentinel-2 data (ESSD)](https://essd.copernicus.org/articles/13/5353/2021/)

*Cross-references: `SAR_METHODOLOGY.md` (original deep-dive, pre-first-run),
`SAR_RESULTS_ASSESSMENT.md` (post-first-run output critique, bugs vs. open
questions).*
