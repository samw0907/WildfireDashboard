import { useEffect, useRef, useState } from 'react'
import { cancelAdminKey, registerAdminKeyModal, submitAdminKey } from '../adminKey'

export function AdminKeyModal() {
  const [visible, setVisible] = useState(false)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    registerAdminKeyModal(() => {
      setValue('')
      setVisible(true)
    })
  }, [])

  useEffect(() => {
    if (visible) inputRef.current?.focus()
  }, [visible])

  if (!visible) return null

  const submit = () => {
    if (!value) return
    submitAdminKey(value)
    setVisible(false)
  }

  const cancel = () => {
    cancelAdminKey()
    setVisible(false)
  }

  return (
    <div className="admin-key-overlay" onClick={cancel}>
      <div className="admin-key-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Admin key required</h3>
        <p>This action is gated behind a shared admin key.</p>
        <input
          ref={inputRef}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') cancel()
          }}
          placeholder="Enter admin key"
        />
        <div className="admin-key-actions">
          <button onClick={submit} disabled={!value}>
            Continue
          </button>
          <button className="admin-key-cancel-btn" onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
