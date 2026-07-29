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

function sceneLabel(s: Scene): string {
  const date = new Date(s.date).toLocaleDateString()
  return `${date} · ${s.orbit_direction ?? 'unknown'} · track ${s.relative_orbit ?? '?'}`
}

export function AcquisitionPanel({ fireId }: { fireId: string }) {
  const [acquisition, setAcquisition] = useState<Acquisition | null>(null)
  const [candidates, setCandidates] = useState<AcquisitionCandidates | null>(null)
  const [selectedBefore, setSelectedBefore] = useState<Scene | null>(null)
  const [selectedAfter, setSelectedAfter] = useState<Scene | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const loadAcquisition = () => getAcquisition(fireId).then(setAcquisition).catch(() => setAcquisition(null))

  useEffect(() => {
    setAcquisition(null)
    setCandidates(null)
    setSelectedBefore(null)
    setSelectedAfter(null)
    setError(null)
    loadAcquisition()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fireId])

  useEffect(() => {
    if (acquisition?.status && !acquisition.before_scene) {
      getAcquisitionCandidates(fireId)
        .then(setCandidates)
        .catch(() => setError('Could not load candidate Sentinel-1 scenes.'))
    }
  }, [acquisition?.status, acquisition?.before_scene, fireId])

  // Same relative orbit guarantees identical viewing geometry between the
  // before/after pair - falls back to same orbit direction if no after
  // scene shares the exact track yet, matching the original pipeline's
  // real constraint (see DECISIONS.md).
  const filteredAfter = useMemo(() => {
    if (!candidates) return []
    if (!selectedBefore) return candidates.after
    const sameTrack = candidates.after.filter((s) => s.relative_orbit === selectedBefore.relative_orbit)
    if (sameTrack.length > 0) return sameTrack
    return candidates.after.filter((s) => s.orbit_direction === selectedBefore.orbit_direction)
  }, [candidates, selectedBefore])

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

      {acquisition.status && !acquisition.before_scene && (
        <div className="scene-picker">
          {!candidates && <p className="page-subtitle">Searching for candidate Sentinel-1 scenes…</p>}
          {candidates && (
            <>
              <div className="scene-picker-columns">
                <div className="scene-picker-column">
                  <h4>Before ({candidates.before.length})</h4>
                  {candidates.before.length === 0 && <p className="page-subtitle">No scenes found.</p>}
                  {candidates.before.map((s) => (
                    <button
                      key={s.id}
                      className={`scene-option${selectedBefore?.id === s.id ? ' scene-option--selected' : ''}`}
                      onClick={() => {
                        setSelectedBefore(s)
                        setSelectedAfter(null)
                      }}
                    >
                      {sceneLabel(s)}
                    </button>
                  ))}
                </div>
                <div className="scene-picker-column">
                  <h4>After ({filteredAfter.length})</h4>
                  {selectedBefore && filteredAfter.length === 0 && (
                    <p className="page-subtitle">No matching-track after scene yet.</p>
                  )}
                  {!selectedBefore && <p className="page-subtitle">Pick a before scene first.</p>}
                  {filteredAfter.map((s) => (
                    <button
                      key={s.id}
                      className={`scene-option${selectedAfter?.id === s.id ? ' scene-option--selected' : ''}`}
                      onClick={() => setSelectedAfter(s)}
                    >
                      {sceneLabel(s)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="acquisition-actions">
                <button
                  disabled={busy || !selectedBefore || !selectedAfter}
                  onClick={() =>
                    selectedBefore &&
                    selectedAfter &&
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
                  onClick={() => run(() => unmarkAcquisition(fireId), 'Could not cancel.')}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {acquisition.before_scene && acquisition.after_scene && (
        <div className="scene-summary">
          <p>
            <strong>Before:</strong> {sceneLabel(acquisition.before_scene)}
          </p>
          <p>
            <strong>After:</strong> {sceneLabel(acquisition.after_scene)}
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
            onClick={() => run(() => unmarkAcquisition(fireId), 'Could not reset.')}
          >
            Start over
          </button>
        </div>
      )}
    </div>
  )
}
