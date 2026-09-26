// Which sidebar rows are in the viewport, so git is read for what can be seen. One
// IntersectionObserver over every row; a row mounting, unmounting or scrolling moves the set.

/** A row entering view comes through `onShown`, which is where a row that missed a change is read. */
export type RowVisibility = {
  observe: (element: Element, worktreeId: string) => () => void
  /** Undefined where there is no observer to ask; empty until rows mount and report. */
  visible: () => ReadonlySet<string> | undefined
  onShown: (listener: (worktreeIds: string[]) => void) => () => void
}

type ObserverClass = new (callback: IntersectionObserverCallback) => IntersectionObserver

export function createRowVisibility(
  observerClass: () => ObserverClass | undefined = () => globalThis.IntersectionObserver
): RowVisibility {
  const rows = new Map<Element, { worktreeId: string; shown: boolean }>()
  const listeners = new Set<(worktreeIds: string[]) => void>()
  let observer: IntersectionObserver | undefined

  const report = (entries: IntersectionObserverEntry[]): void => {
    const shown: string[] = []
    for (const entry of entries) {
      const row = rows.get(entry.target)
      if (row === undefined) continue
      if (entry.isIntersecting && !row.shown) shown.push(row.worktreeId)
      row.shown = entry.isIntersecting
    }
    if (shown.length === 0) return
    for (const listener of [...listeners]) listener(shown)
  }

  return {
    observe: (element, worktreeId) => {
      if (observer === undefined) {
        const Observer = observerClass()
        if (Observer === undefined) return () => {}
        observer = new Observer(report)
      }
      rows.set(element, { worktreeId, shown: false })
      observer.observe(element)
      return () => {
        rows.delete(element)
        observer?.unobserve(element)
      }
    },
    visible: () => {
      if (observerClass() === undefined) return undefined
      const ids = new Set<string>()
      for (const row of rows.values()) if (row.shown) ids.add(row.worktreeId)
      return ids
    },
    onShown: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

export const rowVisibility = createRowVisibility()
