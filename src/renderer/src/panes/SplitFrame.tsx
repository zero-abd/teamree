// The flex box a split is drawn as, and the draggable gutters between its
// children.
//
// This came out of `PaneTree` when a teammate's pane stopped floating over the
// window and took a slot beside your own panes. There are two places in this
// app where panes sit side by side now, and they have to behave identically:
// the same hairline that thickens under the pointer, the same arithmetic in
// `applyGutterDrag`, the same arrow-key nudge for somebody who is not holding a
// mouse. A second implementation of that would be a second set of feels, and
// the whole point of the change was that a teammate's pane stops feeling like
// a different application.
//
// Sizes are tracked locally while a handle is held so the drag stays at frame
// rate, and only the released position is handed back to be persisted.

import { Fragment, useCallback, useRef, useState } from 'react'
import { applyGutterDrag, GUTTER_PX, normalizeSizes, splitChildBases } from './paneLayout'
import { usePointerDrag } from './usePointerDrag'

/**
 * One child of a split: what to draw, and a key that follows it.
 *
 * The key is the caller's rather than the index because siblings come and go —
 * a watched pane opens to the right of your tree, and another closes from the
 * middle of the row. Keyed by position, closing the first of three would remount
 * the other two, which for a pane means tearing down an emulator and reopening
 * a stream nobody asked to reopen.
 */
export type SplitCell = { key: string; node: React.ReactNode }

export function SplitFrame({
  direction,
  sizes,
  cells,
  onResize,
  className
}: {
  direction: 'row' | 'column'
  /** Fractions of the axis, one per cell. Short, long or corrupt is survivable. */
  sizes: readonly number[]
  cells: readonly SplitCell[]
  /** The released position, for whoever owns these fractions to keep. */
  onResize: (sizes: number[]) => void
  /** An extra class on the split itself, for a caller that has to place it. */
  className?: string
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const startDrag = usePointerDrag()
  const [draft, setDraft] = useState<number[] | null>(null)
  // Normalized against the cells rather than against itself: a cell can appear
  // or disappear between renders, and a fraction per pane that no longer exists
  // would leave the last one with no basis at all.
  const current = draft ?? normalizeSizes(sizes, cells.length)
  const bases = splitChildBases(current)

  const axisLength = useCallback((): number => {
    const element = containerRef.current
    if (!element) return 0
    const gutters = (cells.length - 1) * GUTTER_PX
    return (direction === 'row' ? element.clientWidth : element.clientHeight) - gutters
  }, [cells.length, direction])

  const beginDrag = (index: number) => (event: React.PointerEvent<HTMLDivElement>) => {
    const total = axisLength()
    if (total <= 0) return
    const start = direction === 'row' ? event.clientX : event.clientY
    const origin = [...current]

    const move = (moveEvent: PointerEvent): void => {
      const delta = (direction === 'row' ? moveEvent.clientX : moveEvent.clientY) - start
      setDraft(applyGutterDrag(origin, index, delta, total))
    }
    const finish = (upEvent: PointerEvent | null): void => {
      setDraft(null)
      if (!upEvent) return
      const delta = (direction === 'row' ? upEvent.clientX : upEvent.clientY) - start
      onResize(applyGutterDrag(origin, index, delta, total))
    }
    startDrag(event, direction === 'row' ? 'col-resize' : 'row-resize', move, finish)
  }

  const nudge = (index: number) => (event: React.KeyboardEvent<HTMLDivElement>) => {
    const forward = direction === 'row' ? 'ArrowRight' : 'ArrowDown'
    const back = direction === 'row' ? 'ArrowLeft' : 'ArrowUp'
    if (event.key !== forward && event.key !== back) return
    const total = axisLength()
    if (total <= 0) return
    event.preventDefault()
    onResize(applyGutterDrag(current, index, event.key === forward ? 24 : -24, total))
  }

  return (
    <div className={`split split--${direction}${className ? ` ${className}` : ''}`} ref={containerRef}>
      {cells.map((cell, index) => (
        <Fragment key={cell.key}>
          <div className="split__cell" style={{ flexBasis: bases[index] }}>
            {cell.node}
          </div>
          {index < cells.length - 1 ? (
            <div
              className={`gutter gutter--${direction}`}
              role="separator"
              tabIndex={0}
              aria-orientation={direction === 'row' ? 'vertical' : 'horizontal'}
              aria-label={`Resize panes ${index + 1} and ${index + 2}`}
              aria-valuenow={Math.round((current[index] ?? 0) * 100)}
              onPointerDown={beginDrag(index)}
              onKeyDown={nudge(index)}
            />
          ) : null}
        </Fragment>
      ))}
    </div>
  )
}
