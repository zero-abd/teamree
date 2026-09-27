// A row's chips on its title line: as many as fit beside the name, the rest behind `+N` and its popover.

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { foldChips, foldTitle, type RowChip } from './rowChips'

type Place = { top: number; right: number }

export function FoldedChips({
  chips,
  most,
  label
}: {
  chips: readonly RowChip<React.ReactNode>[]
  /** Shown at most, however wide the line. */
  most: number
  /** The row's name, for the popover. */
  label: string
}): React.JSX.Element {
  const facts = useRef<HTMLSpanElement | null>(null)
  const plus = useRef<HTMLSpanElement | null>(null)
  const [width, setWidth] = useState(0)
  const [open, setOpen] = useState<Place | null>(null)
  // Shrunk a chip at a time while the line overflows; new chips or a new width start again from `most`.
  const key = `${most}|${width}|${chips.map((chip) => `${chip.key}:${chip.text}`).join('\n')}`
  const [fit, setFit] = useState({ key, room: most })
  const room = fit.key === key ? fit.room : most
  const { shown, folded } = foldChips(chips, room)

  useLayoutEffect(() => {
    const element = facts.current
    if (element !== null && room > 0 && element.scrollWidth > element.clientWidth) setFit({ key, room: room - 1 })
  })

  useEffect(() => {
    const line = facts.current?.closest('.worktree__title')
    if (!line) return
    const observer = new ResizeObserver(() => setWidth(line.clientWidth))
    observer.observe(line)
    return () => observer.disconnect()
  }, [])

  return (
    <>
      <span className="worktree__facts" ref={facts}>
        {shown.map((chip) => (
          <Fragment key={chip.key}>{chip.node}</Fragment>
        ))}
      </span>
      {folded.length === 0 ? null : (
        // Inside the row's button, so a span, as the issue chip is.
        <span
          ref={plus}
          className="chip chip-fold"
          role="button"
          title={foldTitle(folded)}
          aria-expanded={open !== null}
          onClick={(event) => {
            event.stopPropagation()
            const rect = event.currentTarget.getBoundingClientRect()
            setOpen(open === null ? { top: rect.bottom + 4, right: window.innerWidth - rect.right } : null)
          }}
        >
          {`+${folded.length}`}
        </span>
      )}
      {open === null || folded.length === 0 ? null : (
        <ChipPopover label={`More on ${label}`} at={open} opener={plus} onClose={() => setOpen(null)}>
          {folded.map((chip) => (
            <Fragment key={chip.key}>{chip.node}</Fragment>
          ))}
        </ChipPopover>
      )}
    </>
  )
}

function ChipPopover({
  label,
  at,
  opener,
  onClose,
  children
}: {
  label: string
  at: Place
  opener: React.RefObject<HTMLElement | null>
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const box = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const dismiss = (event: PointerEvent): void => {
      const target = event.target as Node
      if (box.current?.contains(target) === true || opener.current?.contains(target) === true) return
      onClose()
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('keydown', escape)
    }
  }, [onClose, opener])
  // Portalled out of the row's button, but React still bubbles its clicks there: they stop here.
  return createPortal(
    <div
      ref={box}
      className="chip-fold__pop"
      role="dialog"
      aria-label={label}
      style={{ top: at.top, right: at.right }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body
  )
}
