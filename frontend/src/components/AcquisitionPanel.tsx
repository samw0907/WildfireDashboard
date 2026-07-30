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

function sceneLabel(s: Scene): string {
  const date = new Date(s.date).toLocaleDateString()
  return `${date} · ${s.orbit_direction ?? 'unknown'}`
}

// Full AOI coverage (not just bbox-touching) matters more than anything
// else visible here - IW mode's burst structure means a scene can graze
// the fire's bounding box while a gap runs through the perimeter itself.
function coverageTier(percent: number | null): 'good' | 'warn' | 'bad' | 'unknown' {
  if (percent == null) return 'unknown'
  if (percent >= 95) return 'good'
  if (percent > 0) return 'warn'
  return 'bad'
}

interface TrackSummary {
  track: number
  direction: string | null
  beforeCount: number
  afterCount: number
  eligibleForComposite: boolean
}

function computeTrackSummaries(candidates: AcquisitionCandidates): TrackSummary[] {
  const byTrack = new Map<number, TrackSummary>()
  const bump = (s: Scene, side: 'beforeCount' | 'afterCount') => {
    if (s.relative_orbit == null) return
    const existing = byTrack.get(s.relative_orbit)
    if (existing) {
      existing[side]++
    } else {
      byTrack.set(s.relative_orbit, {
        track: s.relative_orbit,
        direction: s.orbit_direction,
        beforeCount: 0,
        afterCount: 0,
        eligibleForComposite: false,
        [side]: 1,
      } as TrackSummary)
    }
  }
  candidates.before.forEach((s) => bump(s, 'beforeCount'))
  candidates.after.forEach((s) => bump(s, 'afterCount'))

  return Array.from(byTrack.values())
    .map((t) => ({ ...t, eligibleForComposite: t.beforeCount >= COMPOSITE_COUNT && t.afterCount >= COMPOSITE_COUNT }))
    .sort((a, b) => {
      if (a.eligibleForComposite !== b.eligibleForComposite) return a.eligibleForComposite ? -1 : 1
      return b.beforeCount + b.afterCount - (a.beforeCount + a.afterCount)
    })
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
  const targetCount = activeTrackSummary?.eligibleForComposite ? COMPOSITE_COUNT : SINGLE_PAIR_COUNT

  const trackBefore = useMemo(
    () => (candidates && selectedTrack != null ? candidates.before.filter((s) => s.relative_orbit === selectedTrack) : []),
    [candidates, selectedTrack],
  )
  const trackAfter = useMemo(
    () => (candidates && selectedTrack != null ? candidates.after.filter((s) => s.relative_orbit === selectedTrack) : []),
    [candidates, selectedTrack],
  )

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
                Pick a track. Every scene composited together must share the same viewing geometry - tracks with 3+
                scenes on both sides support the more reliable Composite mode; others fall back to a single
                before/after pair.
              </p>
              {trackSummaries.length === 0 && <p className="page-subtitle">No candidate scenes found in range.</p>}
              <div className="track-list">
                {trackSummaries.map((t) => (
                  <button key={t.track} className="track-option" onClick={() => setSelectedTrack(t.track)}>
                    <span>
                      Track {t.track} ({t.direction ?? 'unknown'})
                    </span>
                    <span>
                      {t.beforeCount} before, {t.afterCount} after
                    </span>
                    <span className={`track-badge track-badge--${t.eligibleForComposite ? 'good' : 'warn'}`}>
                      {t.eligibleForComposite ? 'Composite-ready' : 'Single-pair only'}
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
            <strong>Before:</strong> {acquisition.before_scenes.map(sceneLabel).join(' · ')}
          </p>
          <p>
            <strong>After:</strong> {acquisition.after_scenes.map(sceneLabel).join(' · ')}
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
