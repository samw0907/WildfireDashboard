import { useEffect, useState } from 'react'
import { getIngestionStatus, type IngestionStatus } from '../api'

const POLL_INTERVAL_MS = 60_000

const LABELS: Record<IngestionStatus['status'], string> = {
  live: 'Live',
  reconnecting: 'Reconnecting',
  disconnected: 'No live connection',
}

export function StatusBadge() {
  const [state, setState] = useState<IngestionStatus>({ status: 'disconnected', last_successful_at: null })

  useEffect(() => {
    let cancelled = false

    const poll = () => {
      getIngestionStatus()
        .then((s) => {
          if (!cancelled) setState(s)
        })
        .catch(() => {
          // Backend unreachable - fail safe to "disconnected" rather than
          // leaving a stale "Live" badge showing.
          if (!cancelled) setState({ status: 'disconnected', last_successful_at: null })
        })
    }

    poll()
    const interval = setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  const title = state.last_successful_at
    ? `Last updated ${new Date(state.last_successful_at).toLocaleString()}`
    : 'No successful data update yet'

  return (
    <div className={`status-pill status-pill--${state.status}`} title={title}>
      <span className="status-dot" />
      {LABELS[state.status]}
    </div>
  )
}
