import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  acquisitionDownloadAllUrl,
  acquisitionDownloadUrl,
  confirmAcquisition,
  createAcquisition,
  deleteAcquisition,
  getAcquisitionCandidates,
  listAcquisitions,
  selectAcquisitionScenes,
  unmarkAcquisition,
  INLINE_FIGURE_LABELS,
  type Acquisition,
  type AcquisitionCandidates,
  type CandidateScene,
  type Scene,
} from '../api'
import { StatCard } from './StatCard'
import {
  DAMAGE_DESTROYED_HELP,
  DAMAGE_POSSIBLY_AFFECTED_HELP,
  DAMAGE_NO_DAMAGE_HELP,
  DAMAGE_THRESHOLD_SENSITIVE_HELP,
} from '../helpText'
import { BuildingIcon, TrashIcon } from './icons'
import { ConfirmDialog } from './ConfirmDialog'
import { Lightbox } from './Lightbox'

// Only counts with usable classification data go in the denominator - a
// building with no_data/geometry_limited couldn't be assessed at all, so
// including it would understate the real destroyed/affected percentages
// among buildings that actually got a real answer.
function damagePercent(count: number, usableTotal: number): number | null {
  return usableTotal > 0 ? Math.round((count / usableTotal) * 100) : null
}

const ACRES_TO_HECTARES = 0.404686

// SAR-detected burn area as a % of the fire's officially reported acreage
// - a cheap, already-available cross-check: well under 100% suggests SAR
// only picked up part of the burn (or the fire is still growing past what
// was mapped at the time of the "after" scene), while well over 100%
// suggests the fixed threshold picked up some non-fire change too.
function burnAreaPercentOfFire(burnAreaHa: number, fireAcres: number | null | undefined): number | null {
  if (!fireAcres || fireAcres <= 0) return null
  const fireAreaHa = fireAcres * ACRES_TO_HECTARES
  return Math.round((burnAreaHa / fireAreaHa) * 100)
}


// Composite mode (3+3) needs at least 3 dates per side for median
// compositing to provide real outlier-robustness - median of 2 is
// mathematically identical to a mean, so there's no "2" tier. Single-pair
// (1+1) is the only fallback. See SAR_METHODOLOGY.md §8.
const COMPOSITE_COUNT = 3
const SINGLE_PAIR_COUNT = 1
// Same "good" bar used for the per-scene coverage badge - a scene below
// this still touches the fire but with real gaps, above it is
// effectively full coverage.
const FULL_COVERAGE_THRESHOLD = 95

function sceneLabel(s: Scene): string {
  const date = new Date(s.date).toLocaleDateString()
  return `${date} · ${s.orbit_direction ?? 'unknown'}`
}

// Full AOI coverage (not just bbox-touching) matters more than anything
// else visible here - IW mode's burst structure means a scene can graze
// the fire's bounding box while a gap runs through the perimeter itself.
function coverageTier(percent: number | null): 'good' | 'warn' | 'bad' | 'unknown' {
  if (percent == null) return 'unknown'
  if (percent >= FULL_COVERAGE_THRESHOLD) return 'good'
  if (percent > 0) return 'warn'
  return 'bad'
}

// A scene with 0% AOI coverage touches the search bbox but not the fire
// itself - not a real candidate for anything, not just a low-quality one.
function isViable(s: Scene): boolean {
  return s.aoi_coverage_percent == null || s.aoi_coverage_percent > 0
}

function isFullCoverage(s: Scene): boolean {
  return s.aoi_coverage_percent != null && s.aoi_coverage_percent >= FULL_COVERAGE_THRESHOLD
}

function priorUseLabel(scene: CandidateScene): string | null {
  if (scene.previously_used.length === 0) return null
  return scene.previously_used
    .map((u) => `#${u.sequence} (${u.side === 'before' ? 'before' : 'after'} ignition, ${u.status})`)
    .join(', ')
}

// Ranked best to worst - coverage completeness matters more than compositing
// noise-robustness, since a scene that doesn't cover the fire can't tell you
// anything about it regardless of how many dates get averaged:
//   1. Composite using only full-coverage scenes (best)
//   2. Single-pair using full-coverage scenes (full coverage beats
//      compositing partial data)
//   3. Composite using partial-coverage scenes (some averaging benefit,
//      real gaps)
//   4. Single-pair using partial-coverage scenes (worst on both axes)
type Tier = 1 | 2 | 3 | 4

interface TrackSummary {
  track: number
  direction: string | null
  viableBeforeCount: number
  viableAfterCount: number
  tier: Tier
  recommended: boolean
}

function tierMode(tier: Tier): 'composite' | 'single_pair' {
  return tier === 1 || tier === 3 ? 'composite' : 'single_pair'
}

function computeTrackSummaries(candidates: AcquisitionCandidates): TrackSummary[] {
  const byTrack = new Map<
    number,
    { direction: string | null; before: Scene[]; after: Scene[] }
  >()
  const add = (s: Scene, side: 'before' | 'after') => {
    if (s.relative_orbit == null || !isViable(s)) return
    const existing = byTrack.get(s.relative_orbit)
    if (existing) {
      existing[side].push(s)
    } else {
      byTrack.set(s.relative_orbit, {
        direction: s.orbit_direction,
        before: side === 'before' ? [s] : [],
        after: side === 'after' ? [s] : [],
      })
    }
  }
  candidates.before.forEach((s) => add(s, 'before'))
  candidates.after.forEach((s) => add(s, 'after'))

  const summaries: TrackSummary[] = []
  for (const [track, { direction, before, after }] of byTrack) {
    const fullBefore = before.filter(isFullCoverage).length
    const fullAfter = after.filter(isFullCoverage).length
    let tier: Tier
    if (fullBefore >= COMPOSITE_COUNT && fullAfter >= COMPOSITE_COUNT) tier = 1
    else if (fullBefore >= SINGLE_PAIR_COUNT && fullAfter >= SINGLE_PAIR_COUNT) tier = 2
    else if (before.length >= COMPOSITE_COUNT && after.length >= COMPOSITE_COUNT) tier = 3
    else tier = 4

    summaries.push({
      track,
      direction,
      viableBeforeCount: before.length,
      viableAfterCount: after.length,
      tier,
      recommended: false,
    })
  }

  summaries.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    return b.viableBeforeCount + b.viableAfterCount - (a.viableBeforeCount + a.viableAfterCount)
  })
  if (summaries.length > 0) summaries[0].recommended = true
  return summaries
}

function tierBadgeLabel(tier: Tier): string {
  switch (tier) {
    case 1:
      return 'Composite · full coverage'
    case 2:
      return 'Single-pair · full coverage'
    case 3:
      return 'Composite · partial coverage'
    case 4:
      return 'Single-pair · partial coverage'
  }
}

function tierBadgeClass(tier: Tier): 'good' | 'warn' {
  return tier === 1 || tier === 2 ? 'good' : 'warn'
}

function modeLabel(mode: Acquisition['mode']): string {
  if (mode === 'composite') return 'Composite (3+3)'
  if (mode === 'single_pair') return 'Single-pair (1+1) — reduced reliability'
  return ''
}

// Based on measured runs on the current 8 vCPU / 32GB job definition:
// RTC (terrain correction) is the dominant cost at ~20-50 min per scene
// depending on scene size, and every scene is processed one at a time on
// a single container rather than in parallel. Compositing, change
// detection, and building classification are comparatively fast on top
// of that. Composite mode processes 6 scenes total (3 before + 3 after)
// vs. Single-pair's 2 (1 before + 1 after) - unmeasured directly since no
// Composite run has completed yet, so this is a reasoned estimate (~3x
// the scene count) rather than a measured one.
function processingEstimate(mode: Acquisition['mode']): string {
  if (mode === 'composite') {
    return 'Composite mode processes 6 scenes total (3 before + 3 after) through RTC terrain correction, the dominant cost, one scene at a time - based on measured single-scene RTC times, expect roughly 2.5-4 hours end-to-end (not yet measured directly for a full Composite run, so treat this as a reasoned estimate).'
  }
  if (mode === 'single_pair') {
    return 'Single-pair mode processes 2 scenes total (1 before + 1 after) through RTC terrain correction, the dominant cost - based on measured per-scene times, expect roughly 45-100 minutes end-to-end.'
  }
  return 'Processing time depends on mode and scene size - typically under 1.5 hours for Single-pair, 2.5-4 hours for Composite.'
}

// Tab subtitle: the overall before->after span once scenes are picked, so
// tabs are distinguishable at a glance without opening each one.
function acquisitionDateRange(a: Acquisition): string | null {
  if (a.before_scenes.length === 0 || a.after_scenes.length === 0) return null
  const before = new Date(a.before_scenes[0].date).toLocaleDateString()
  const after = new Date(a.after_scenes[a.after_scenes.length - 1].date).toLocaleDateString()
  return `${before} → ${after}`
}

interface AcquisitionPanelProps {
  fireId: string
  // NIFC-reported fire acreage, if known - used only to contextualize the
  // SAR-detected burn area as a % of the officially reported perimeter
  // size (a cheap, already-available cross-check: does the SAR change
  // signal cover most of the fire, a small fraction, or - if well over
  // 100% - a sign the fixed threshold picked up non-fire change too).
  fireAcres?: number | null
  // Reports whichever before/after scenes are currently relevant (mid-
  // selection, or already saved) for the acquisition tab currently being
  // viewed, so the parent can draw their real footprints on the map for
  // visual context.
  onScenesChange?: (scenes: { before: Scene[]; after: Scene[] }) => void
  // Reports the SAR compute results for the acquisition tab currently
  // being viewed once its job completes, so the parent can draw the burn
  // perimeter / building damage overlays on the map.
  onResultsChange?: (results: {
    burnPerimeter: GeoJSON.FeatureCollection | null
    buildingDamage: GeoJSON.FeatureCollection | null
  }) => void
  // Reports whether the acquisition tab currently being viewed has had
  // its scenes confirmed (job submitted or beyond) rather than still
  // being picked, so the parent can auto-hide the scene footprints map
  // layer and re-fit to the fire perimeter once true.
  onConfirmedChange?: (confirmed: boolean) => void
}

export function AcquisitionPanel({
  fireId,
  fireAcres,
  onScenesChange,
  onResultsChange,
  onConfirmedChange,
}: AcquisitionPanelProps) {
  const [acquisitions, setAcquisitions] = useState<Acquisition[]>([])
  const [activeSequence, setActiveSequence] = useState<number | null>(null)
  const [candidates, setCandidates] = useState<AcquisitionCandidates | null>(null)
  const [selectedTrack, setSelectedTrack] = useState<number | null>(null)
  const [selectedBefore, setSelectedBefore] = useState<Scene[]>([])
  const [selectedAfter, setSelectedAfter] = useState<Scene[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Acquisition | null>(null)

  const activeAcquisition = acquisitions.find((a) => a.sequence === activeSequence) ?? null
  // Only one acquisition per fire can be non-terminal at a time (enforced
  // server-side too) - a second draft/in-flight run at once would make
  // "which one am I looking at" ambiguous, and the same fire's compute
  // job would risk running twice concurrently.
  const hasNonTerminalAcquisition = acquisitions.some((a) => a.status === 'marked' || a.status === 'processing')

  useEffect(() => {
    onScenesChange?.({
      before: selectedBefore.length > 0 ? selectedBefore : activeAcquisition?.before_scenes ?? [],
      after: selectedAfter.length > 0 ? selectedAfter : activeAcquisition?.after_scenes ?? [],
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBefore, selectedAfter, activeAcquisition?.before_scenes, activeAcquisition?.after_scenes])

  useEffect(() => {
    onResultsChange?.({
      burnPerimeter: activeAcquisition?.burn_perimeter ?? null,
      buildingDamage: activeAcquisition?.building_damage ?? null,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAcquisition?.burn_perimeter, activeAcquisition?.building_damage])

  useEffect(() => {
    const confirmed = activeAcquisition != null && activeAcquisition.status !== 'marked'
    onConfirmedChange?.(confirmed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAcquisition?.status])

  // Reselects whichever sequence was active if it still exists in the
  // fresh list; otherwise falls back to the most recent one (or none).
  // Covers both a plain refresh and a draft disappearing after unmark.
  const loadAcquisitions = () =>
    listAcquisitions(fireId)
      .then((list) => {
        setAcquisitions(list)
        setActiveSequence((prev) => {
          if (prev != null && list.some((a) => a.sequence === prev)) return prev
          return list.length > 0 ? list[list.length - 1].sequence : null
        })
      })
      .catch(() => setAcquisitions([]))

  const resetLocalSelection = () => {
    setSelectedTrack(null)
    setSelectedBefore([])
    setSelectedAfter([])
  }

  // Tracked in a ref (not read directly from state) so the cleanup below
  // sees the latest value at the moment of unmount/fire-switch rather than
  // whatever was current when the effect was first set up.
  const acquisitionsRef = useRef<Acquisition[]>([])
  useEffect(() => {
    acquisitionsRef.current = acquisitions
  }, [acquisitions])

  useEffect(() => {
    setAcquisitions([])
    setActiveSequence(null)
    setCandidates(null)
    resetLocalSelection()
    setError(null)
    loadAcquisitions()

    // A fire marked-for-acquisition but never confirmed is an abandoned
    // draft, not a real in-progress request - auto-clear it on the way out
    // (navigating to another fire, or away from this page entirely) rather
    // than leaving a stale "marked" tab behind forever. Only applies pre-
    // confirmation: 'processing'/'complete'/'failed' all mean a real job
    // was actually submitted, which must never be silently discarded. At
    // most one draft can exist at a time (server-enforced), so there's
    // never ambiguity about which one this is.
    const previousFireId = fireId
    return () => {
      const draft = acquisitionsRef.current.find((a) => a.status === 'marked')
      if (draft) unmarkAcquisition(previousFireId, draft.sequence).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fireId])

  useEffect(() => {
    if (activeAcquisition?.status === 'marked' && activeAcquisition.before_scenes.length === 0) {
      getAcquisitionCandidates(fireId)
        .then(setCandidates)
        .catch(() => setError('Could not load candidate Sentinel-1 scenes.'))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAcquisition?.status, activeAcquisition?.before_scenes, fireId])

  // The backend's own polling loop (2-minute cadence) is what actually
  // moves a job from 'processing' to 'complete'/'failed' - without this,
  // the UI would just sit on "Processing…" until a manual page reload.
  // Matches the backend's cadence rather than polling faster, since
  // there's nothing to see more often than that anyway.
  useEffect(() => {
    if (activeAcquisition?.status !== 'processing') return
    const interval = setInterval(loadAcquisitions, 120_000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAcquisition?.status, fireId])

  const trackSummaries = useMemo(() => (candidates ? computeTrackSummaries(candidates) : []), [candidates])
  const activeTrackSummary = trackSummaries.find((t) => t.track === selectedTrack) ?? null
  const targetCount = activeTrackSummary && tierMode(activeTrackSummary.tier) === 'composite' ? COMPOSITE_COUNT : SINGLE_PAIR_COUNT

  const trackBefore = useMemo(
    () =>
      candidates && selectedTrack != null
        ? candidates.before.filter((s) => s.relative_orbit === selectedTrack && isViable(s))
        : [],
    [candidates, selectedTrack],
  )
  const trackAfter = useMemo(
    () =>
      candidates && selectedTrack != null
        ? candidates.after.filter((s) => s.relative_orbit === selectedTrack && isViable(s))
        : [],
    [candidates, selectedTrack],
  )

  // Default to the best-covering scenes on the newly-selected track, so the
  // sensible choice is pre-filled - the user can still toggle to anything
  // else viable on that track. Deliberately not pre-filled from any
  // *earlier* acquisition's scenes - every acquisition starts from a fully
  // fresh pick; `previously_used` on each candidate just makes an earlier
  // choice visible, not automatic.
  useEffect(() => {
    if (selectedTrack == null) return
    const byCoverageDesc = (a: Scene, b: Scene) => (b.aoi_coverage_percent ?? -1) - (a.aoi_coverage_percent ?? -1)
    setSelectedBefore([...trackBefore].sort(byCoverageDesc).slice(0, targetCount))
    setSelectedAfter([...trackAfter].sort(byCoverageDesc).slice(0, targetCount))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTrack])

  async function run(action: () => Promise<unknown>, failureMessage: string) {
    setBusy(true)
    setError(null)
    try {
      await action()
      await loadAcquisitions()
    } catch {
      setError(failureMessage)
    } finally {
      setBusy(false)
    }
  }

  async function startNewAcquisition() {
    setBusy(true)
    setError(null)
    try {
      const created = await createAcquisition(fireId)
      await loadAcquisitions()
      setActiveSequence(created.sequence)
    } catch {
      setError('Could not start a new acquisition.')
    } finally {
      setBusy(false)
    }
  }

  function toggleScene(list: Scene[], setList: (s: Scene[]) => void, scene: Scene) {
    if (list.some((s) => s.id === scene.id)) {
      setList(list.filter((s) => s.id !== scene.id))
    } else if (list.length < targetCount) {
      setList([...list, scene])
    }
  }

  return (
    <div className="acquisition-section">
      <div className="acquisition-header">
        <h3>SAR Acquisition</h3>
        {activeAcquisition && (
          <button
            className="acquisition-delete-btn"
            disabled={busy || activeAcquisition.status === 'processing'}
            title={
              activeAcquisition.status === 'processing'
                ? 'Wait for this acquisition to finish before deleting it'
                : `Permanently delete Acquisition #${activeAcquisition.sequence}`
            }
            onClick={() => setDeleteTarget(activeAcquisition)}
          >
            <TrashIcon /> Delete Acquisition #{activeAcquisition.sequence}
          </button>
        )}
      </div>
      {error && <p className="acquisition-error">{error}</p>}

      {acquisitions.length > 0 && (
        <div className="acquisition-tabs">
          {acquisitions.map((a) => (
            <button
              key={a.sequence}
              className={`acquisition-tab${a.sequence === activeSequence ? ' acquisition-tab--active' : ''}`}
              onClick={() => {
                setActiveSequence(a.sequence)
                resetLocalSelection()
              }}
            >
              <span className="acquisition-tab-title">
                Acquisition #{a.sequence}
                {acquisitionDateRange(a) && <span className="acquisition-tab-sub">{acquisitionDateRange(a)}</span>}
              </span>
              <span className={`acquisition-tab-status acquisition-tab-status--${a.status}`}>{a.status}</span>
            </button>
          ))}
          <button
            className="acquisition-tab acquisition-tab--new"
            disabled={busy || hasNonTerminalAcquisition}
            title={
              hasNonTerminalAcquisition
                ? 'Resolve the current draft or in-progress acquisition before starting another.'
                : 'Start a new, independent acquisition for this fire'
            }
            onClick={startNewAcquisition}
          >
            + New
          </button>
        </div>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title={`Delete Acquisition #${deleteTarget.sequence}?`}
          message="This permanently removes its stored results (rasters, figures, GeoJSON) from S3 and its database record. This cannot be undone."
          confirmLabel="Delete permanently"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            const target = deleteTarget
            setDeleteTarget(null)
            run(() => deleteAcquisition(fireId, target.sequence), 'Could not delete this acquisition.')
          }}
        />
      )}

      {acquisitions.length === 0 && (
        <button className="acquisition-mark-btn" disabled={busy} onClick={startNewAcquisition}>
          Mark for acquisition
        </button>
      )}

      {activeAcquisition && activeAcquisition.status === 'marked' && activeAcquisition.before_scenes.length === 0 && (
        <div className="scene-picker">
          {!candidates && <p className="page-subtitle">Searching for candidate Sentinel-1 scenes…</p>}

          {candidates && selectedTrack === null && candidates.after.every((s) => !isViable(s)) && (
            <p className="acquisition-warning">
              No post-ignition Sentinel-1 imagery is available yet for this fire - Sentinel-1 revisits every ~6-12
              days per track, so recently discovered fires often don't have a usable after-ignition scene yet. Please
              check back later.
            </p>
          )}

          {candidates && selectedTrack === null && candidates.after.some(isViable) && (
            <>
              <p className="page-subtitle">
                Pick a track. Every scene composited together must share the same viewing geometry. Ranked best
                first: full-AOI-coverage tracks with 3+ scenes on both sides (Composite, most reliable), then
                full-coverage tracks with fewer scenes (Single-pair), then tracks where even the best scenes only
                partly cover the fire - large fires can genuinely straddle a fixed satellite frame boundary on every
                pass of a track, not just unluckily on one date.
              </p>
              {trackSummaries.length === 0 && <p className="page-subtitle">No candidate scenes found in range.</p>}
              <div className="track-list">
                {trackSummaries.map((t) => (
                  <button key={t.track} className="track-option" onClick={() => setSelectedTrack(t.track)}>
                    <span>
                      Track {t.track} ({t.direction ?? 'unknown'})
                      {t.recommended && <span className="track-recommended"> · Recommended</span>}
                    </span>
                    <span>
                      {t.viableBeforeCount} before-ignition, {t.viableAfterCount} after-ignition
                    </span>
                    <span className={`track-badge track-badge--${tierBadgeClass(t.tier)}`}>
                      {tierBadgeLabel(t.tier)}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          {candidates && selectedTrack !== null && (
            <>
              <div className="track-active-bar">
                <span>
                  Track {selectedTrack} — {targetCount === COMPOSITE_COUNT ? 'Composite mode (3+3)' : 'Single-pair mode (1+1)'}
                </span>
                <button className="acquisition-cancel-btn" onClick={resetLocalSelection}>
                  Change track
                </button>
              </div>
              {targetCount === SINGLE_PAIR_COUNT && (
                <p className="acquisition-warning">
                  Only single before-ignition/after-ignition scenes available on this track - results won't benefit
                  from multi-date noise averaging and may be less reliable.
                </p>
              )}
              {activeTrackSummary && (activeTrackSummary.tier === 3 || activeTrackSummary.tier === 4) && (
                <p className="acquisition-warning">
                  No scene on this track fully covers the fire's perimeter - the best available still leave real
                  gaps. Pre-selected the best-covering options; you can swap them for others below.
                </p>
              )}
              <div className="scene-picker-columns">
                <div className="scene-picker-column">
                  <h4>
                    Before ignition ({selectedBefore.length}/{targetCount})
                  </h4>
                  {trackBefore.map((s) => (
                    <button
                      key={s.id}
                      className={`scene-option${selectedBefore.some((x) => x.id === s.id) ? ' scene-option--selected' : ''}`}
                      onClick={() => toggleScene(selectedBefore, setSelectedBefore, s)}
                    >
                      <span>{sceneLabel(s)}</span>
                      <span className={`coverage-badge coverage-badge--${coverageTier(s.aoi_coverage_percent)}`}>
                        {s.aoi_coverage_percent != null ? `${s.aoi_coverage_percent}% coverage` : 'coverage unknown'}
                      </span>
                      {priorUseLabel(s) && <span className="scene-prior-use">Already used: {priorUseLabel(s)}</span>}
                    </button>
                  ))}
                </div>
                <div className="scene-picker-column">
                  <h4>
                    After ignition ({selectedAfter.length}/{targetCount})
                  </h4>
                  {trackAfter.map((s) => (
                    <button
                      key={s.id}
                      className={`scene-option${selectedAfter.some((x) => x.id === s.id) ? ' scene-option--selected' : ''}`}
                      onClick={() => toggleScene(selectedAfter, setSelectedAfter, s)}
                    >
                      <span>{sceneLabel(s)}</span>
                      <span className={`coverage-badge coverage-badge--${coverageTier(s.aoi_coverage_percent)}`}>
                        {s.aoi_coverage_percent != null ? `${s.aoi_coverage_percent}% coverage` : 'coverage unknown'}
                      </span>
                      {priorUseLabel(s) && <span className="scene-prior-use">Already used: {priorUseLabel(s)}</span>}
                    </button>
                  ))}
                </div>
              </div>
              <div className="acquisition-actions">
                <button
                  disabled={busy || selectedBefore.length !== targetCount || selectedAfter.length !== targetCount}
                  onClick={() =>
                    run(
                      () => selectAcquisitionScenes(fireId, activeAcquisition.sequence, selectedBefore, selectedAfter),
                      'Could not save the scene selection.',
                    )
                  }
                >
                  Save selection
                </button>
                <button
                  className="acquisition-cancel-btn"
                  disabled={busy}
                  onClick={() => {
                    resetLocalSelection()
                    run(() => unmarkAcquisition(fireId, activeAcquisition.sequence), 'Could not cancel.')
                  }}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {activeAcquisition && activeAcquisition.before_scenes.length > 0 && activeAcquisition.after_scenes.length > 0 && (
        <div className="scene-summary">
          <p className={`mode-badge mode-badge--${activeAcquisition.mode === 'composite' ? 'good' : 'warn'}`}>
            {modeLabel(activeAcquisition.mode)}
          </p>
          <p>
            <strong>Before ignition:</strong>{' '}
            {activeAcquisition.before_scenes
              .map((s) => `${sceneLabel(s)} (${s.aoi_coverage_percent ?? '?'}% coverage)`)
              .join(' · ')}
          </p>
          <p>
            <strong>After ignition:</strong>{' '}
            {activeAcquisition.after_scenes
              .map((s) => `${sceneLabel(s)} (${s.aoi_coverage_percent ?? '?'}% coverage)`)
              .join(' · ')}
          </p>
          {activeAcquisition.status === 'complete' &&
            [...activeAcquisition.before_scenes, ...activeAcquisition.after_scenes].some(
              (s) => s.aoi_coverage_percent == null || s.aoi_coverage_percent < FULL_COVERAGE_THRESHOLD,
            ) && (
              <p className="acquisition-warning">
                One or more selected scenes cover less than {FULL_COVERAGE_THRESHOLD}% of this fire - the
                SAR-detected burn area below may end abruptly along a straight edge where the scene's own
                coverage runs out, not because the fire itself stopped there. A real limitation of the source
                imagery for this acquisition, not a processing error.
              </p>
            )}
          {activeAcquisition.status === 'marked' && (
            <button
              className="acquisition-confirm-btn"
              disabled={busy}
              onClick={() => run(() => confirmAcquisition(fireId, activeAcquisition.sequence), 'Could not confirm.')}
            >
              Confirm &amp; proceed
            </button>
          )}

          {activeAcquisition.status === 'processing' && (
            <p className="acquisition-processing">
              <span className="spinner" aria-hidden="true" />
              SAR compute job running{activeAcquisition.confirmed_at && ` since ${new Date(activeAcquisition.confirmed_at).toLocaleString()}`}.{' '}
              {processingEstimate(activeAcquisition.mode)} This page checks for an update automatically, no need to
              keep it open.
            </p>
          )}

          {activeAcquisition.status === 'failed' && (
            <div className="acquisition-failed">
              <p>SAR compute job failed: {activeAcquisition.error ?? 'no reason given.'}</p>
              <button
                className="acquisition-confirm-btn"
                disabled={busy}
                onClick={() => run(() => confirmAcquisition(fireId, activeAcquisition.sequence), 'Could not resubmit.')}
              >
                Retry
              </button>
            </div>
          )}

          {activeAcquisition.status === 'complete' && activeAcquisition.result && (
            <div className="acquisition-results">
              {(() => {
                const result = activeAcquisition.result!
                const counts = result.building_damage_counts
                const destroyed = counts.destroyed ?? 0
                const possiblyAffected = counts.possibly_affected ?? 0
                const noDamage = counts.no_damage ?? 0
                const noData = counts.no_data ?? 0
                const geometryLimited = counts.geometry_limited ?? 0
                // Denominator for percentages - only buildings that actually
                // got a real classification, not ones excluded for lacking
                // data or reliable geometry.
                const usableTotal = destroyed + possiblyAffected + noDamage
                const excluded = noData + geometryLimited
                // The fixed threshold's own breakdown - always computed
                // (see priority.py/entrypoint.py), shown explicitly here
                // rather than only as an agree/disagree count, so the
                // dual-threshold comparison is a concrete pair of numbers,
                // not just a summary claim.
                const fixedCounts = result.building_damage_counts_fixed ?? {}
                const fixedDestroyed = fixedCounts.destroyed ?? 0
                const fixedPossiblyAffected = fixedCounts.possibly_affected ?? 0
                const fixedNoDamage = fixedCounts.no_damage ?? 0
                const files = result.files ?? {}
                const sequence = activeAcquisition.sequence
                const imageEntries = INLINE_FIGURE_LABELS.filter(({ key }) => files[key])
                const dataEntries = Object.entries(files).filter(
                  ([label]) => !INLINE_FIGURE_LABELS.some((f) => f.key === label),
                )

                return (
                  <>
                    {/* This is the core finding - what actually happened to buildings
                        near the fire - so it leads, prominent, ahead of the raw burn-area
                        geometry stats (which are real but a step removed from the
                        "was my building destroyed" question people actually come here for). */}
                    <h4>Building Damage Assessment</h4>
                    <div className="stat-row">
                      <StatCard
                        label="Destroyed"
                        value={destroyed}
                        unit={damagePercent(destroyed, usableTotal) != null ? ` (${damagePercent(destroyed, usableTotal)}%)` : ''}
                        accent="red"
                        icon={BuildingIcon}
                        hint={DAMAGE_DESTROYED_HELP}
                      />
                      <StatCard
                        label="Possibly affected"
                        value={possiblyAffected}
                        unit={
                          damagePercent(possiblyAffected, usableTotal) != null
                            ? ` (${damagePercent(possiblyAffected, usableTotal)}%)`
                            : ''
                        }
                        accent="orange"
                        icon={BuildingIcon}
                        hint={DAMAGE_POSSIBLY_AFFECTED_HELP}
                      />
                      <StatCard
                        label="No damage detected"
                        value={noDamage}
                        unit={damagePercent(noDamage, usableTotal) != null ? ` (${damagePercent(noDamage, usableTotal)}%)` : ''}
                        accent="green"
                        icon={BuildingIcon}
                        hint={DAMAGE_NO_DAMAGE_HELP}
                      />
                      {result.confidence_counts && (
                        <StatCard
                          label="Threshold-sensitive"
                          value={result.confidence_counts.uncertain ?? 0}
                          accent="yellow"
                          icon={BuildingIcon}
                          hint={DAMAGE_THRESHOLD_SENSITIVE_HELP}
                        />
                      )}
                    </div>
                    <p className="acquisition-minor-stats">
                      {burnAreaPercentOfFire(result.total_burn_area_ha, fireAcres) != null && (
                        <strong>Perimeter match: {burnAreaPercentOfFire(result.total_burn_area_ha, fireAcres)}% </strong>
                      )}
                      {result.total_burn_area_ha.toFixed(1)} ha SAR-detected burn area
                      {burnAreaPercentOfFire(result.total_burn_area_ha, fireAcres) != null && ' of reported fire acreage'}
                      {' '}across {result.burn_patch_count} patches · {result.total_buildings_classified} buildings
                      assessed
                      {excluded > 0 && ` · ${excluded} excluded (no data / geometry-limited)`}
                    </p>

                    {/* Figures right after the headline stats/summary - the
                        prime content - rather than after several paragraphs
                        of methodology caveats, which now live in the
                        collapsed <details> below instead. */}
                    {imageEntries.length > 0 && (
                      <div className="figure-stack">
                        {imageEntries.map(({ key, title }) => {
                          const src = acquisitionDownloadUrl(fireId, sequence, files[key])
                          return (
                            <figure key={key} className="figure-stack-item">
                              <img
                                src={src}
                                alt={title}
                                loading="lazy"
                                className="figure-stack-img"
                                onClick={() => setLightbox({ src, alt: title })}
                              />
                              <figcaption>{title}</figcaption>
                            </figure>
                          )
                        })}
                      </div>
                    )}

                    <details className="acquisition-methodology-details">
                      <summary>How to read these numbers</summary>
                      {result.adaptive_threshold_db != null && result.confidence_counts ? (
                        <p className="acquisition-minor-stats">
                          The numbers above use <strong>this fire's own adaptive threshold</strong> (
                          <strong>{result.adaptive_threshold_db.toFixed(2)} dB</strong>, derived from this fire's own
                          signal), not a value borrowed from other fires. Under the fixed{' '}
                          <strong>{result.threshold_db} dB</strong> reference value used consistently across every
                          fire, the same buildings would instead read as {fixedDestroyed} destroyed,{' '}
                          {fixedPossiblyAffected} possibly affected, {fixedNoDamage} no damage -{' '}
                          {result.confidence_counts.corroborated ?? 0} agree under both
                          {(result.confidence_counts.uncertain ?? 0) > 0 &&
                            `; ${result.confidence_counts.uncertain} are threshold-sensitive (classified differently
                            under the two) - shown above under the adaptive result, not asserted with full confidence`}
                          .
                        </p>
                      ) : (
                        <p className="acquisition-minor-stats">
                          This fire's signal didn't produce a clean adaptive split (little enough real change that
                          there wasn't a genuine two-population divide to find), so the numbers above use the fixed{' '}
                          <strong>{result.threshold_db} dB</strong> reference value directly - no second threshold to
                          cross-check against for this run.
                        </p>
                      )}
                      {(counts.unconfirmed ?? 0) > 0 && (
                        <p className="acquisition-minor-stats">
                          {counts.unconfirmed} building{counts.unconfirmed === 1 ? '' : 's'} had an initial destroyed/
                          possibly-affected reading, but weren't backed by a real, spatially-coherent burn patch (likely
                          a single noisy pixel rather than a real finding) - excluded from the counts above rather than
                          trusted on that one pixel alone.
                        </p>
                      )}
                      {(result.fallback_sampled_count ?? 0) > 0 && (
                        <p className="acquisition-minor-stats">
                          {result.fallback_sampled_count} building{result.fallback_sampled_count === 1 ? '' : 's'} -
                          mostly small, rural structures near Sentinel-1's ~20m pixel size - had no single pixel
                          centered inside their footprint under the standard sampling rule, and were rescued with a
                          looser one-time retry rather than left unclassified. Their readings are averaged over a
                          slightly larger area than most buildings, which sample cleanly.
                        </p>
                      )}
                    </details>

                    <p className="acquisition-honesty-note">
                      {result.primary_threshold_db != null
                        ? `${result.primary_threshold_db.toFixed(2)} dB change threshold`
                        : `${result.threshold_db} dB change threshold`}
                      , OpenStreetMap building data - both have real limitations for a live response.{' '}
                      <Link to="/reference#sar-methodology">Full methodology →</Link>
                    </p>

                    {Object.keys(files).length > 0 && (
                      <div className="acquisition-downloads">
                        <a className="download-all-btn" href={acquisitionDownloadAllUrl(fireId, sequence)} download>
                          ⬇ Download all results (.zip)
                        </a>
                        <div className="acquisition-downloads-columns">
                          {imageEntries.length > 0 && (
                            <div className="acquisition-downloads-col">
                              <h5>Figures</h5>
                              <ul>
                                {imageEntries.map(({ key, title }) => (
                                  <li key={key}>
                                    <a href={acquisitionDownloadUrl(fireId, sequence, files[key])} download>
                                      {title}
                                    </a>{' '}
                                    <span className="download-filename">({files[key]})</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {dataEntries.length > 0 && (
                            <div className="acquisition-downloads-col">
                              <h5>Data files</h5>
                              <ul>
                                {dataEntries.map(([label, filename]) => (
                                  <li key={label}>
                                    <a href={acquisitionDownloadUrl(fireId, sequence, filename)} download>
                                      {label.replace(/_/g, ' ')}
                                    </a>{' '}
                                    <span className="download-filename">({filename})</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {Object.keys(files).length === 0 && (
                      <p className="acquisition-warning">
                        This run predates figure/download support - start a new acquisition to get downloadable
                        outputs and figures.
                      </p>
                    )}
                  </>
                )
              })()}
            </div>
          )}

          {lightbox && <Lightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}

          {activeAcquisition.status === 'marked' && (
            <button
              className="acquisition-cancel-btn"
              disabled={busy}
              onClick={() => {
                resetLocalSelection()
                run(() => unmarkAcquisition(fireId, activeAcquisition.sequence), 'Could not cancel this draft.')
              }}
            >
              Cancel draft
            </button>
          )}
        </div>
      )}
    </div>
  )
}
