// A plain-DOM panel opening upward from a rail button: Escape and an outside press close it, and the
// caller returns focus. Fixed to the viewport because the rail clips its overflow.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

type StatusPopoverProps = {
  /** Names the panel for anybody listening rather than looking. */
  label: string
  /** The button it opens from; the panel sits above its left edge. */
  anchor: HTMLElement | null
  onClose: () => void
  children: React.ReactNode
}

/** Between the rail and the panel, so the rail's border stays visible. */
const GAP_PX = 6

export function StatusPopover({ label, anchor, onClose, children }: StatusPopoverProps): React.JSX.Element {
  const panel = useRef<HTMLDivElement | null>(null)
  const [place, setPlace] = useState<{ left: number; bottom: number }>({ left: 0, bottom: 0 })

  useLayoutEffect(() => {
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    setPlace({ left: rect.left, bottom: window.innerHeight - rect.top + GAP_PX })
  }, [anchor])

  // Takes focus unless something inside already has it, so Escape has somewhere to land.
  useEffect(() => {
    const current = panel.current
    if (current && !current.contains(document.activeElement)) current.focus()
  }, [])

  useEffect(() => {
    const dismiss = (event: PointerEvent): void => {
      if (panel.current?.contains(event.target as Node) === true) return
      if (anchor?.contains(event.target as Node) === true) return
      onClose()
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [anchor, onClose])

  return createPortal(
    <div
      ref={panel}
      className="statusbar__popover"
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      style={{ left: `${place.left}px`, bottom: `${place.bottom}px` }}
    >
      {children}
    </div>,
    document.body
  )
}
