import { useEffect, useState } from 'react'
import { createFireNote, deleteFireNote, listFireNotes, updateFireNote, type FireNote } from '../api'
import { TrashIcon } from './icons'
import { ConfirmDialog } from './ConfirmDialog'

interface FireNotesProps {
  fireId: string
}

// Analyst commentary, independent of the acquisition workflow - available
// whether or not a fire's ever been marked for acquisition (see DECISIONS.md).
// Publicly readable; add/edit/delete controls are always shown (matching
// every other admin-gated action on this site) - clicking one just prompts
// for the admin key via the existing modal if it isn't already stored,
// rather than this component checking key presence itself.
export function FireNotes({ fireId }: FireNotesProps) {
  const [notes, setNotes] = useState<FireNote[]>([])
  const [loading, setLoading] = useState(true)
  const [newText, setNewText] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<FireNote | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = () => listFireNotes(fireId).then(setNotes)

  useEffect(() => {
    setNotes([])
    setEditingId(null)
    setError(null)
    setLoading(true)
    load()
      .catch(() => setError('Could not load notes.'))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fireId])

  async function run(action: () => Promise<unknown>, failureMessage: string) {
    setBusy(true)
    setError(null)
    try {
      await action()
      await load()
      return true
    } catch {
      setError(failureMessage)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function handleAdd() {
    const text = newText.trim()
    if (!text) return
    const ok = await run(() => createFireNote(fireId, text), 'Could not add note - check the admin key and try again.')
    if (ok) setNewText('')
  }

  async function handleSaveEdit(noteId: number) {
    const text = editText.trim()
    if (!text) return
    const ok = await run(
      () => updateFireNote(fireId, noteId, text),
      'Could not save note - check the admin key and try again.',
    )
    if (ok) setEditingId(null)
  }

  return (
    <div className="fire-notes-panel">
      <h2>Notes</h2>
      <p className="page-subtitle">Analyst commentary on this fire - visible to everyone, editable with the admin key.</p>

      {error && <p className="acquisition-warning">{error}</p>}

      <div className="fire-notes-add">
        <textarea
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          placeholder="Add a note - e.g. a dense settlement just outside the buffer, an access road worth flagging…"
          rows={3}
          disabled={busy}
        />
        <button className="acquisition-confirm-btn" disabled={busy || !newText.trim()} onClick={handleAdd}>
          Add note
        </button>
      </div>

      {loading ? (
        <p className="page-subtitle">Loading notes…</p>
      ) : notes.length === 0 ? (
        <p className="page-subtitle">No notes yet for this fire.</p>
      ) : (
        <ul className="fire-notes-list">
          {notes.map((note) => (
            <li key={note.id} className="fire-note">
              {editingId === note.id ? (
                <>
                  <textarea value={editText} onChange={(e) => setEditText(e.target.value)} rows={3} disabled={busy} />
                  <div className="fire-note-edit-actions">
                    <button className="acquisition-confirm-btn" disabled={busy} onClick={() => handleSaveEdit(note.id)}>
                      Save
                    </button>
                    <button className="acquisition-cancel-btn" disabled={busy} onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="fire-note-text">{note.text}</p>
                  <div className="fire-note-footer">
                    <span className="fire-note-timestamp">
                      {new Date(note.created_at).toLocaleString()}
                      {note.updated_at && ' (edited)'}
                    </span>
                    <span className="fire-note-actions">
                      <button
                        className="fire-note-action-btn"
                        onClick={() => {
                          setEditingId(note.id)
                          setEditText(note.text)
                        }}
                      >
                        Edit
                      </button>
                      <button className="fire-note-action-btn fire-note-action-btn--danger" onClick={() => setDeleteTarget(note)}>
                        <TrashIcon />
                      </button>
                    </span>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete this note?"
          message="This permanently removes the note. This cannot be undone."
          confirmLabel="Delete permanently"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            const target = deleteTarget
            setDeleteTarget(null)
            run(() => deleteFireNote(fireId, target.id), 'Could not delete note - check the admin key and try again.')
          }}
        />
      )}
    </div>
  )
}
