import { useEffect, useRef, useState } from 'react'
import { TooltipBubble } from './TooltipBubble'

// Small "?" hint badge, click-to-toggle (not hover) - used sparingly, only
// on fields whose meaning genuinely isn't obvious (priority score,
// incident complexity, population methodology), not on self-explanatory
// fields like acreage or dates. Often sits inside a clickable table header
// (sort trigger) or row, so its own click must not bubble up to that.
export function InfoHint({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    function handleOutsideClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [open])

  return (
    <span
      ref={ref}
      className="info-hint"
      onClick={(e) => {
        e.stopPropagation()
        setOpen((o) => !o)
      }}
    >
      ?{open && <TooltipBubble anchorRef={ref} text={text} />}
    </span>
  )
}
