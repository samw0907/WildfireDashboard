import { useRef, useState } from 'react'
import { TooltipBubble } from './TooltipBubble'

const RFW_TOOLTIP_TEXT = 'Fire perimeter is inside an active NWS Red Flag Warning or Fire Weather Watch zone'

// Hover-triggered (not click, unlike InfoHint) - deliberately kept as
// hover since this is a passive status flag, not something someone needs
// to deliberately open on a touch device the way an explanatory hint is.
export function RfwBadge({ compact = false }: { compact?: boolean }) {
  const [hovered, setHovered] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  return (
    <span
      ref={ref}
      className="warning-badge"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {compact ? '⚠ RFW' : '⚠ Active fire weather warning'}
      {hovered && <TooltipBubble anchorRef={ref} text={RFW_TOOLTIP_TEXT} />}
    </span>
  )
}
