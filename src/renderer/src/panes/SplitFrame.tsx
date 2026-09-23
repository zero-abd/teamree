// The flex box a split is drawn as, with draggable gutters; shared by the pane tree and the watched-pane
// row so both feel identical. Sizes are local during a drag; only the released position is persisted.

import { Fragment, useCallback, useRef, useState } from 'react'
import { applyGutterDrag, GUTTER_PX, normalizeSizes, splitChildBases } from './paneLayout'
import { usePointerDrag } from './usePointerDrag'

/** One child of a split and a caller-owned key, so closing a sibling does not remount the others. */
export type SplitCell = { key: string; node: React.ReactNode }

export function SplitFrame({
  direction,
  sizes,
  cells,
  onResize,
  minPx,
  className
}: {
  direction: 'row' | 'column'
  /** Fractions of the axis, one per cell. Short, long or corrupt is survivable. */
  sizes: readonly number[]
  cells: readonly SplitCell[]
  /** The released position, for whoever owns these fractions to keep. */
  onResize: (sizes: number[]) => void
  /** Each cell's least size along the axis, in pixels; a small fraction without it. */
  minPx?: readonly number[]
  /** An extra class on the split itself, for a caller that has to place it. */
  className?: string
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const startDrag = usePointerDrag()
  const [draft, setDraft] = useState<number[] | null>(null)
  // Normalized against the cells: one can appear or disappear between renders.
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
      setDraft(applyGutterDrag(origin, index, delta, total, minPx))
    }
    const finish = (upEvent: PointerEvent | null): void => {
      setDraft(null)
      if (!upEvent) return
      const delta = (direction === 'row' ? upEvent.clientX : upEvent.clientY) - start
      onResize(applyGutterDrag(origin, index, delta, total, minPx))
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
    onResize(applyGutterDrag(current, index, event.key === forward ? 24 : -24, total, minPx))
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
