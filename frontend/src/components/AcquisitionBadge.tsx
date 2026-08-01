import { useRef, useState } from 'react'
import { TooltipBubble } from './TooltipBubble'

const ACQUISITION_TOOLTIP_TEXT = 'One or more SAR acquisitions have been requested for this fire'

// Hover-triggered, same pattern as RfwBadge - a passive status flag, not
// something worth a deliberate click-to-open on touch.
export function AcquisitionBadge({ compact = false }: { compact?: boolean }) {
  const [hovered, setHovered] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  return (
    <span
      ref={ref}
      className="acquisition-badge"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {compact ? '🛰 SAR' : '🛰 SAR acquisition requested'}
      {hovered && <TooltipBubble anchorRef={ref} text={ACQUISITION_TOOLTIP_TEXT} />}
    </span>
  )
}
