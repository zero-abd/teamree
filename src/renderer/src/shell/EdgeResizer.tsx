// A panel's edge. It is a real separator widget: draggable with a pointer,
// nudgeable with the arrow keys, and reachable from the keyboard alone.
//
// One widget for both sides of the window. The sidebar's edge grows the
// sidebar when it is dragged right; the right panel's edge grows the panel
// when it is dragged left. That is the only difference between them, and it
// is one sign.

import { usePointerDrag } from '../panes/usePointerDrag'

const NUDGE_PX = 16

type EdgeResizerProps = {
  width: number
  min: number
  max: number
  onWidth: (width: number) => void
  /** What the panel is called, for anybody listening rather than looking. */
  label: string
  /** Which way a drag towards the window's right edge moves the width. */
  grows: 'rightward' | 'leftward'
  className: string
  /** The width a double-click puts the panel back to. */
  resetTo: number
}

export function EdgeResizer({
  width,
  min,
  max,
  onWidth,
  label,
  grows,
  className,
  resetTo
}: EdgeResizerProps): React.JSX.Element {
  const startDrag = usePointerDrag()
  const sign = grows === 'rightward' ? 1 : -1

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const startX = event.clientX
    const startWidth = width

    const move = (moveEvent: PointerEvent): void => {
      onWidth(startWidth + sign * (moveEvent.clientX - startX))
    }
    startDrag(event, 'col-resize', move, (upEvent) => {
      if (upEvent) move(upEvent)
    })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      onWidth(width - sign * NUDGE_PX)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      onWidth(width + sign * NUDGE_PX)
    }
  }

  return (
    <div
      className={className}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={beginDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onWidth(resetTo)}
    />
  )
}
