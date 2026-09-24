// The sidebar's column and the right panel's width slide. A terminal refits once when they stop,
// not every frame: a pty resized per frame makes a full-screen agent redraw per frame.

/** Longest a slide is waited on; an element removed mid-transition never sends its end. */
const MOTION_CEILING_MS = 400

const moving = new Set<EventTarget>()
const deferred = new Set<() => void>()
let ceiling: ReturnType<typeof setTimeout> | undefined

function isLayoutSlide(event: Event): boolean {
  const property = (event as TransitionEvent).propertyName
  const target = event.target
  if (!(target instanceof Element)) return false
  if (property === 'grid-template-columns') return target.classList.contains('shell')
  return property === 'width' && target.classList.contains('panel')
}

function settle(): void {
  clearTimeout(ceiling)
  ceiling = undefined
  moving.clear()
  const runs = [...deferred]
  deferred.clear()
  for (const run of runs) run()
}

/** Follows the slides from here on; returns the stop. */
export function watchLayoutMotion(target: Document): () => void {
  const start = (event: Event): void => {
    if (!isLayoutSlide(event) || event.target === null) return
    moving.add(event.target)
    clearTimeout(ceiling)
    ceiling = setTimeout(settle, MOTION_CEILING_MS)
  }
  const end = (event: Event): void => {
    if (!isLayoutSlide(event) || event.target === null || !moving.delete(event.target)) return
    if (moving.size === 0) settle()
  }
  target.addEventListener('transitionrun', start)
  target.addEventListener('transitionend', end)
  target.addEventListener('transitioncancel', end)
  return () => {
    target.removeEventListener('transitionrun', start)
    target.removeEventListener('transitionend', end)
    target.removeEventListener('transitioncancel', end)
    clearTimeout(ceiling)
    ceiling = undefined
    moving.clear()
    deferred.clear()
  }
}

/** True, with `fit` run once the slide ends, while one is under way; false when the layout is still. */
export function deferWhileLayoutMoves(fit: () => void): boolean {
  if (moving.size === 0) return false
  deferred.add(fit)
  return true
}

/** Drops a deferred fit, for a pane that has gone. */
export function forgetDeferred(fit: () => void): void {
  deferred.delete(fit)
}
