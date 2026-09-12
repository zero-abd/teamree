// The sidebar's edge. It is a real separator widget: draggable with a pointer,
// nudgeable with the arrow keys, and reachable from the keyboard alone.

import { useWorkspaceStore } from '../state/workspaceStore'
import { SIDEBAR_MAX_PX, SIDEBAR_MIN_PX } from './sidebarWidth'

const NUDGE_PX = 16

export function SidebarResizer(): React.JSX.Element {
  const width = useWorkspaceStore((state) => state.sidebarWidth)
  const setSidebarWidth = useWorkspaceStore((state) => state.setSidebarWidth)

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const startX = event.clientX
    const startWidth = width
    event.currentTarget.setPointerCapture(event.pointerId)
    document.body.classList.add('is-resizing')

    const move = (moveEvent: PointerEvent): void => {
      setSidebarWidth(startWidth + (moveEvent.clientX - startX))
    }
    const finish = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      document.body.classList.remove('is-resizing')
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setSidebarWidth(width - NUDGE_PX)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      setSidebarWidth(width + NUDGE_PX)
    }
  }

  return (
    <div
      className="shell__resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN_PX}
      aria-valuemax={SIDEBAR_MAX_PX}
      tabIndex={0}
      onPointerDown={beginDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => setSidebarWidth(SIDEBAR_MIN_PX)}
    />
  )
}
