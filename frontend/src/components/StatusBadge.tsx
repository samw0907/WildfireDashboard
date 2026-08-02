import { useEffect, useRef, useState } from 'react'
import { getIngestionStatus, type IngestionStatus } from '../api'
import { TooltipBubble } from './TooltipBubble'

const POLL_INTERVAL_MS = 60_000

const LABELS: Record<IngestionStatus['status'], string> = {
  live: 'Live',
  reconnecting: 'Reconnecting',
  disconnected: 'No live connection',
}

export function StatusBadge() {
  const [state, setState] = useState<IngestionStatus>({ status: 'disconnected', last_successful_at: null })
  const [hovered, setHovered] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

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

  const lastUpdateText = state.last_successful_at
    ? `Last update ${new Date(state.last_successful_at).toLocaleString()}.`
    : 'No successful update yet.'
  // Same hover-triggered TooltipBubble pattern as RfwBadge/AcquisitionBadge
  // (not a native title= tooltip) - kept consistent so every small data-
  // provenance hint on the site looks and behaves the same way.
  const tooltipText = `NIFC's WFIGS feed, polled every 15 minutes. ${lastUpdateText}`

  return (
    <div
      ref={ref}
      className={`status-pill status-pill--${state.status}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="status-dot" />
      {LABELS[state.status]}
      {hovered && <TooltipBubble anchorRef={ref} text={tooltipText} />}
    </div>
  )
}
