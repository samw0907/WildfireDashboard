// Plain in-page modal, not window.confirm() - confirmed live elsewhere in
// this project (see adminKey.ts) that embedded browser views (e.g.
// VSCode's preview pane) silently no-op native dialogs instead of showing
// one, which fails with no visible feedback at all. A real DOM modal
// works in every context a page can render in.
interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({ title, message, confirmLabel = 'Confirm', onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <div className="admin-key-overlay" onClick={onCancel}>
      <div className="admin-key-modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{message}</p>
        <div className="admin-key-actions">
          <button className="confirm-dialog-danger-btn" onClick={onConfirm}>
            {confirmLabel}
          </button>
          <button className="admin-key-cancel-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
