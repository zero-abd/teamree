// A small panel that opens upward from a button on the bottom rail.
//
// Built out of plain elements for the reason the sidebar's row menu is: the
// renderer has no Electron in it, and everything in here is a call the window
// can already make. What a DOM panel does not get for free is written out —
// Escape closes it, a press anywhere else closes it, and the focus goes back
// to the button that opened it, which is the caller's job because the caller
// is the only thing that still holds that button.
//
// Fixed to the viewport rather than absolute inside the rail, because the rail
// clips its overflow to stay one line high and a panel inside it would be
// clipped with it.

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

  // The panel takes the focus unless something in it already has — a radio
  // row that asked for it — so Escape has somewhere to land and a screen
  // reader announces where the keyboard went.
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
