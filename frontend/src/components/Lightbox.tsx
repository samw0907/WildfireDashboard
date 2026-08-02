import { useEffect, useRef, useState } from 'react'

interface LightboxProps {
  src: string
  alt: string
  onClose: () => void
}

const MIN_SCALE = 0.5
const MAX_SCALE = 6

export function Lightbox({ src, alt, onClose }: LightboxProps) {
  const [scale, setScale] = useState(1)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function onWheel(e: React.WheelEvent) {
    e.preventDefault()
    setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s - e.deltaY * 0.001 * s)))
  }

  function onMouseDown(e: React.MouseEvent) {
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y }
    setDragging(true)
  }
  function onMouseMove(e: React.MouseEvent) {
    if (!dragRef.current) return
    setPos({ x: dragRef.current.origX + (e.clientX - dragRef.current.startX), y: dragRef.current.origY + (e.clientY - dragRef.current.startY) })
  }
  function endDrag() {
    dragRef.current = null
    setDragging(false)
  }

  return (
    <div className="lightbox-overlay" onClick={onClose}>
      <div className="lightbox-toolbar" onClick={(e) => e.stopPropagation()}>
        <button onClick={() => setScale((s) => Math.min(MAX_SCALE, s + 0.4))} title="Zoom in">
          +
        </button>
        <button onClick={() => setScale((s) => Math.max(MIN_SCALE, s - 0.4))} title="Zoom out">
          −
        </button>
        <button onClick={onClose} title="Close (Esc)">
          ✕
        </button>
      </div>
      <div
        className="lightbox-viewport"
        onClick={(e) => e.stopPropagation()}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          className={dragging ? 'lightbox-img lightbox-img--dragging' : 'lightbox-img'}
          style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})` }}
        />
      </div>
      <div className="lightbox-caption">{alt}</div>
    </div>
  )
}
