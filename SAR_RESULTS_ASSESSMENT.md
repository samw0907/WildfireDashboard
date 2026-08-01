# SAR Output Assessment — Is What We're Producing Actually Usable?

**Purpose**: `SAR_METHODOLOGY.md` documents the *science* — what the pipeline
does and why, written before any real fire went through it. This doc is the
follow-up, written after two real end-to-end runs (Aspen Acres, RA 6 Ada Co
Claremont/"Idaho fire") — a critical look at the actual *output*, asking one
question: if a real SAR/EO domain expert (an ICEYE interviewer, say) looked
at what this dashboard currently shows for a fire, what would they nod at,
and what would they flag as overclaiming or broken? This is the working
document for that discussion, not a finished verdict — several sections end
in open questions rather than decisions.

Every specific number below is from a real run (Aspen Acres, sequence 1,
Single-pair mode, 6/17→7/17/2026), not a hypothetical.

---

## 1. What we currently produce — a plain inventory

Per completed acquisition:
- **Burn extent**: a vectorized polygon (`burn_perimeter.geojson`) of every
  pixel/patch where combined dual-pol change ≥ 2.9 dB, clipped to the fire's
  own reported perimeter. Aspen Acres: 36,651.5 ha across 2,106 separate
  patches, 89% of the fire's reported 101,961 acres.
- **Per-building classification**: every OSM building footprint within the
  fire's perimeter gets one of `destroyed` / `possibly_affected` /
  `no_damage` / `no_data` / `geometry_limited`, from a zonal-mean of the
  change raster under that building's own footprint. Aspen Acres: 371
  destroyed (11.4% of assessed), 27 possibly affected (0.8%), 526 no damage
  (16.2%), 2,320 no-data (71.5% — see §5).
- **Three static figures**: an overview map, a "zoomed" damage map, and a
  3-panel pre/post/change-magnitude backscatter comparison.
- **Raw outputs**: RTC-corrected GeoTIFFs (pre/post, VV/VH), the combined
  change raster, all downloadable.

## 2. What's actually solid — not everything here is a problem

Worth stating plainly so the rest of this doc reads as calibrated criticism,
not a teardown:
- Full radiometric terrain correction (gamma0), dual-pol combination, and
  (when Composite mode actually runs) median compositing are genuine,
  literature-backed SAR practice — not a shortcut, per `SAR_METHODOLOGY.md`
  §1-2.
- `no_data` buildings are correctly excluded from being silently miscounted
  as "no damage" — a real, deliberate honesty choice already in place.
- The threshold/dataset honesty notes are already load-bearing in the UI
  (not decorative) — "fixed threshold, not per-fire calibrated," "OSM has
  real coverage gaps," with a link to the full methodology. That framing is
  accurate to what's actually happening.
- The backscatter comparison panel (pre/post/change-magnitude, continuous
  color scale) is genuinely good and needs no rework — you already flagged
  this one as fine, and it's the one figure type an interactive vector map
  literally cannot replicate (it's the only place the raw radar imagery
  itself is visible).

## 3. Bugs — things to just fix, not open questions

### 3.1 Building damage points are invisible in the overview/zoom figures
Root cause, confirmed by reading `buildings.py`/`figures.py` directly, not
guessed: `buildings_gdf` holds real building **footprint polygons**
(`buildings_gdf.geometry.area` is computed and used elsewhere), and
`geopandas.GeoDataFrame.plot()` **silently ignores the `markersize`
parameter for polygon geometries** — it only applies to Point geometries.
So `_plot_classified_buildings()` is plotting every building at its *true*
footprint size: tens to a few hundred m². Against a canvas spanning a
101,961-acre fire, that's 3-4+ orders of magnitude too small to render as
a visible pixel. This is not really "a bug" in the sense of wrong logic —
the classification and the plot call are both doing exactly what they say
— it's a **scale mismatch**: building-sized geometries drawn on
fire-sized canvases. Fix requires either plotting centroids as real Point
markers (where `markersize` actually works) or buffering footprints by a
fixed real-world distance before plotting — a design choice for §7, not a
one-line patch.

### 3.2 "Zoomed" damage map isn't actually zoomed, for high-coverage fires
`make_damage_zoom_map()` zooms to `burn_gdf.total_bounds` on the
assumption that burn area is a meaningfully smaller subset of the fire
needing genuine zoom-in. For Aspen Acres, burn area is 89% of the fire's
reported acreage — zooming to its bounds is nearly identical to zooming to
the whole perimeter, which is exactly what the screenshots show (a
"zoomed" map that isn't). The fallback logic (classified buildings, then
full perimeter) has the same implicit assumption problem. Needs a real
zoom target that means something regardless of how much of the fire
burned — candidates: a fixed buffer around classified (non-no_data)
buildings specifically (not the burn polygon), or multiple zoomed panels
per damage cluster instead of one wide shot.

### 3.3 The blocky/checkerboard burn-area appearance — not a bug at all
Flagged separately (screenshot of Aspen Acres) — this is the burn-patch
layer rendering *correctly*. Single-pair mode (what every real run so far
has actually used) does per-pixel thresholding with **zero despeckling
benefit** (median of 1 value = no outlier protection). The mosaic/
checkerboard look is real speckle: individual ~10-20m pixels independently
crossing or not crossing 2.9 dB. Worth keeping visible, not smoothing
away — it's an honest signal of exactly how noisy an un-composited result
is, which is directly relevant to §5 below.

## 4. What an expert would actually flag — a direct answer

Not everything here carries equal risk. Ranked by how defensible each
claim is on its own terms:

1. **Most defensible: aggregate burn extent.** "SAR detected combined
   dual-pol change ≥ 2.9 dB across X ha, Y patches" is an honest,
   scoped, falsifiable statement about what the *radar* measured. This is
   close to what real rapid-mapping products (Copernicus EMS, UNOSAT)
   actually deliver for wildfire/disaster activations — extent-level
   change products, explicitly labeled provisional, not final per-
   structure damage lists.
2. **Weakest, most exposed: individual per-building "destroyed" labels.**
   This is where the real risk concentrates, for three compounding
   reasons, all already named in `SAR_METHODOLOGY.md` §5 before this was
   ever run for real:
   - The 2.9 dB threshold is borrowed from two Southern California WUI
     fires' DINS-validated calibration — applied here with **zero
     per-fire validation**, on a fire in different terrain/vegetation/
     climate.
   - **No spatial-coherence check reaches building classification** (§5
     point 4 of the methodology doc) — a single noisy pixel can flip a
     building to "destroyed" with nothing cross-checking it against a
     spatially coherent damage cluster nearby. §3.3 shows exactly how
     noisy a single pixel can be in Single-pair mode.
   - **The burn-scar/vegetation confound is unmitigated** (§5 point 2) —
     a building's zonal-mean sample can be inflated by scorched
     vegetation immediately adjacent to it, which is most likely exactly
     at the wildland-urban interface edge, i.e. exactly where the
     buildings we care about most actually sit.
3. A real interviewer would very likely be *fine* with #1 presented
   honestly, and would very likely push hardest on #2 — specifically
   asking "what stops one bad pixel from calling a building destroyed?"
   The honest answer today is: nothing does.

## 5. A number worth interrogating on its own: 71.5% no-data

2,320 of 3,244 buildings (71.5%) landed in `no_data` for Aspen Acres — no
radar pixel centroid fell inside that building's footprint. Two very
different explanations are consistent with this number, and we haven't
established which one is actually true:
- **Expected/benign**: rural building density is genuinely low relative to
  10-20m pixel size, so most footprints in a 101,961-acre fire's exposure
  buffer are small enough that a pixel centroid missing them entirely is
  just geometry, not a data problem.
- **A real alignment/reprojection issue**: if the true rate is meaningfully
  lower than 71.5% under correct sampling, this could indicate a CRS/
  registration mismatch between the change raster and building footprints,
  which would silently understate real classification coverage everywhere,
  not just here.

**Open question, not yet answered**: has anyone checked this ratio against
a fire with denser, more urban building stock (the Idaho fire is a
plausible comparison — different context, in/near Boise) to see if the
no-data rate drops meaningfully? If it stays similarly high in a denser
area, that points to a real sampling problem, not just rural geometry.

## 6. What real operational SAR damage products do differently

Grounded in `SAR_METHODOLOGY.md` §2's own external verification (Copernicus
EMS/UNOSAT benchmark comparison) plus general domain knowledge of rapid-
mapping practice, to be verified further before acting on it:
- Rapid-mapping wildfire/disaster products typically deliver **graded or
  categorical extent products** (e.g. burned/not-burned, or a damage-grid
  at a coarse cell size), not binary per-building destroyed/not-destroyed
  claims, and are explicitly labeled indicative/subject to field
  verification — never presented as a final structure-by-structure list.
- Confidence/uncertainty is often a first-class part of the deliverable
  (a grading scheme, or a stated validation state), not an afterword.
- Per-structure damage assessment claims, when they exist at all in public
  rapid-mapping literature, tend to lean on multiple corroborating sources
  (optical + SAR, or pre-existing building-condition baselines) rather than
  a single SAR pass.

**This needs real research before we act on it, not just this paragraph** —
see §7's open questions.

## 7. Open questions for the next discussion (not decided here)

1. What do real operational products (Copernicus EMS wildfire activations,
   UNOSAT, any public ICEYE case studies) concretely present as their
   deliverable — grid, polygon, point, what confidence language? Needs
   actual research, not assumption.
2. Should individual building classification be **reframed** — e.g.
   "buildings within a SAR-detected change zone, flagged for field
   verification" instead of "destroyed" / "possibly affected" / "no
   damage" — to match what a single-pixel, unvalidated-per-fire method can
   actually support?
3. Is a spatial-coherence/clustering step for building classification
   (require N neighboring pixels/buildings to agree, not just one) feasible
   to add, or should the current single-pixel approach just be documented
   as a known, unaddressed limitation instead?
4. Should Single-pair mode - which, per §3.3, gets literally zero
   despeckling benefit - carry a harder warning specifically on the
   per-building output, separate from the general "reduced reliability"
   badge it already has? Should Single-pair mode even attempt per-building
   classification at all, versus only reporting aggregate burn extent?
5. Given §4's ranking, should the *emphasis* in the UI (recently reordered
   this session to lead with building damage counts) be reconsidered once
   more, specifically because building-level claims are the least
   defensible part of the output? Flagging the tension directly rather
   than silently re-reversing a decision made earlier today.
6. Resolve §5's 71.5% no-data question empirically - compare against a
   denser-building fire before assuming it's benign.
7. Once the above is resolved, revisit `figures.py` for real: fix the
   building-visibility scale mismatch (§3.1) and the zoom-target logic
   (§3.2), informed by whatever answer comes out of #2 above (the *type*
   of building marker we should show depends on what we've decided the
   classification is honestly claiming).

---

*Cross-references: `SAR_METHODOLOGY.md` §3 (no ground truth for new fires),
§5 (critical analysis - burn-scar confound, no-coherence-check gap,
single-pixel classification risk), §7 (threshold calibration decision).
`PROGRESS.md` for the running build log this doc doesn't duplicate.*
