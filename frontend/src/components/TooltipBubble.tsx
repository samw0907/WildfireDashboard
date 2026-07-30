import { useLayoutEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'

// Rendered into document.body via a portal and positioned with `fixed`
// coordinates computed from the anchor's real position - this is what
// lets it escape a scrollable ancestor (e.g. the table's horizontal
// scroll wrapper) without being clipped, which a plain absolutely-
// positioned child can't do.
export function TooltipBubble({ anchorRef, text }: { anchorRef: RefObject<HTMLElement | null>; text: string }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) return
    setPos({ top: rect.bottom + 8, left: rect.left + rect.width / 2 })
  }, [anchorRef])

  if (!pos) return null

  return createPortal(
    <div className="tooltip-bubble" style={{ top: pos.top, left: pos.left }}>
      {text}
    </div>,
    document.body,
  )
}
