import { useEffect, useRef } from 'react'

/** A drag ends even if capture is lost, the window blurs, or its pane disappears. */
export function usePointerDrag() {
  const cleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => cleanup.current?.(), [])

  return (
    event: React.PointerEvent<HTMLDivElement>,
    cursor: 'col-resize' | 'row-resize',
    onMove: (event: PointerEvent) => void,
    onEnd: (event: PointerEvent | null) => void
  ): void => {
    if (event.button !== 0) return
    event.preventDefault()
    cleanup.current?.()
    const target = event.currentTarget
    const pointerId = event.pointerId
    const previousCursor = document.body.style.cursor
    document.body.style.cursor = cursor
    document.body.classList.add('is-resizing')

    const move = (next: PointerEvent): void => {
      if (next.pointerId === pointerId) onMove(next)
    }
    const dispose = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancelPointer)
      window.removeEventListener('blur', cancel)
      target.removeEventListener('lostpointercapture', cancelPointer)
      cleanup.current = null
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
      document.body.classList.remove('is-resizing')
      document.body.style.cursor = previousCursor
    }
    const finish = (next: PointerEvent): void => {
      if (next.pointerId !== pointerId) return
      dispose()
      onEnd(next)
    }
    const cancel = (): void => {
      dispose()
      onEnd(null)
    }
    const cancelPointer = (next: PointerEvent): void => {
      if (next.pointerId === pointerId) cancel()
    }
    target.setPointerCapture(pointerId)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancelPointer)
    window.addEventListener('blur', cancel)
    target.addEventListener('lostpointercapture', cancelPointer)
    cleanup.current = dispose
  }
}
