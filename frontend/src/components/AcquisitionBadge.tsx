import { useRef, useState } from 'react'
import { TooltipBubble } from './TooltipBubble'

const ACQUISITION_TOOLTIP_TEXT =
  'This fire has a Sentinel-1 SAR damage-assessment run associated with it (in progress or complete) - open the fire for burn-area/building-damage results.'

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
      {compact ? '🛰 SAR AQ' : '🛰 SAR acquisition requested'}
      {hovered && <TooltipBubble anchorRef={ref} text={ACQUISITION_TOOLTIP_TEXT} />}
    </span>
  )
}
