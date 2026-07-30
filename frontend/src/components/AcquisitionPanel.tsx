import { useEffect, useMemo, useState } from 'react'
import {
  confirmAcquisition,
  getAcquisition,
  getAcquisitionCandidates,
  markForAcquisition,
  selectAcquisitionScenes,
  unmarkAcquisition,
  type Acquisition,
  type AcquisitionCandidates,
  type Scene,
} from '../api'

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

interface AcquisitionPanelProps {
  fireId: string
  // Reports whichever before/after scenes are currently relevant (mid-
  // selection, or already saved) so the parent can draw their real
  // footprints on the map for visual context.
  onScenesChange?: (scenes: { before: Scene[]; after: Scene[] }) => void
}

export function AcquisitionPanel({ fireId, onScenesChange }: AcquisitionPanelProps) {
  const [acquisition, setAcquisition] = useState<Acquisition | null>(null)
  const [candidates, setCandidates] = useState<AcquisitionCandidates | null>(null)
  const [selectedTrack, setSelectedTrack] = useState<number | null>(null)
  const [selectedBefore, setSelectedBefore] = useState<Scene[]>([])
  const [selectedAfter, setSelectedAfter] = useState<Scene[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    onScenesChange?.({
      before: selectedBefore.length > 0 ? selectedBefore : acquisition?.before_scenes ?? [],
      after: selectedAfter.length > 0 ? selectedAfter : acquisition?.after_scenes ?? [],
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBefore, selectedAfter, acquisition?.before_scenes, acquisition?.after_scenes])

  const loadAcquisition = () => getAcquisition(fireId).then(setAcquisition).catch(() => setAcquisition(null))

  const resetLocalSelection = () => {
    setSelectedTrack(null)
    setSelectedBefore([])
    setSelectedAfter([])
  }

  useEffect(() => {
    setAcquisition(null)
    setCandidates(null)
    resetLocalSelection()
    setError(null)
    loadAcquisition()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fireId])

  useEffect(() => {
    if (acquisition?.status && acquisition.before_scenes.length === 0) {
      getAcquisitionCandidates(fireId)
        .then(setCandidates)
        .catch(() => setError('Could not load candidate Sentinel-1 scenes.'))
    }
  }, [acquisition?.status, acquisition?.before_scenes, fireId])

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
  // else viable on that track.
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
      await loadAcquisition()
    } catch {
      setError(failureMessage)
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

  if (!acquisition) return null

  return (
    <div className="acquisition-section">
      <h3>SAR Acquisition</h3>
      {error && <p className="acquisition-error">{error}</p>}

      {acquisition.status === null && (
        <button
          className="acquisition-mark-btn"
          disabled={busy}
          onClick={() => run(() => markForAcquisition(fireId), 'Could not mark this fire for acquisition.')}
        >
          Mark for acquisition
        </button>
      )}

      {acquisition.status && acquisition.before_scenes.length === 0 && (
        <div className="scene-picker">
          {!candidates && <p className="page-subtitle">Searching for candidate Sentinel-1 scenes…</p>}

          {candidates && selectedTrack === null && (
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
                      {t.viableBeforeCount} before, {t.viableAfterCount} after
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
                  Only single before/after scenes available on this track - results won't benefit from multi-date
                  noise averaging and may be less reliable.
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
                    Before ({selectedBefore.length}/{targetCount})
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
                    </button>
                  ))}
                </div>
                <div className="scene-picker-column">
                  <h4>
                    After ({selectedAfter.length}/{targetCount})
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
                    </button>
                  ))}
                </div>
              </div>
              <div className="acquisition-actions">
                <button
                  disabled={busy || selectedBefore.length !== targetCount || selectedAfter.length !== targetCount}
                  onClick={() =>
                    run(
                      () => selectAcquisitionScenes(fireId, selectedBefore, selectedAfter),
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
                    run(() => unmarkAcquisition(fireId), 'Could not cancel.')
                  }}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {acquisition.before_scenes.length > 0 && acquisition.after_scenes.length > 0 && (
        <div className="scene-summary">
          <p className={`mode-badge mode-badge--${acquisition.mode === 'composite' ? 'good' : 'warn'}`}>
            {modeLabel(acquisition.mode)}
          </p>
          <p>
            <strong>Before:</strong>{' '}
            {acquisition.before_scenes
              .map((s) => `${sceneLabel(s)} (${s.aoi_coverage_percent ?? '?'}% coverage)`)
              .join(' · ')}
          </p>
          <p>
            <strong>After:</strong>{' '}
            {acquisition.after_scenes
              .map((s) => `${sceneLabel(s)} (${s.aoi_coverage_percent ?? '?'}% coverage)`)
              .join(' · ')}
          </p>
          {acquisition.status !== 'confirmed' && (
            <button
              className="acquisition-confirm-btn"
              disabled={busy}
              onClick={() => run(() => confirmAcquisition(fireId), 'Could not confirm.')}
            >
              Confirm &amp; proceed
            </button>
          )}
          {acquisition.status === 'confirmed' && (
            <p className="acquisition-confirmed">
              Confirmed {acquisition.confirmed_at && new Date(acquisition.confirmed_at).toLocaleString()}. SAR
              processing dispatch isn't wired up yet - this records the decision only.
            </p>
          )}
          <button
            className="acquisition-cancel-btn"
            disabled={busy}
            onClick={() => {
              resetLocalSelection()
              run(() => unmarkAcquisition(fireId), 'Could not reset.')
            }}
          >
            Start over
          </button>
        </div>
      )}
    </div>
  )
}
