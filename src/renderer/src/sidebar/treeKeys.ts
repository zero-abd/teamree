// The sidebar's projects, worktrees and panes as one tree: a single Tab stop, the arrows between
// rows. A row that folds handles → and ← itself and prevents the default; what is left moves.

import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'

const ITEM = '[role="treeitem"]'

export function treeItems(tree: ParentNode): HTMLElement[] {
  return [...tree.querySelectorAll<HTMLElement>(ITEM)].filter((item) => item.closest('[hidden]') === null)
}

function level(item: HTMLElement): number {
  return Number(item.getAttribute('aria-level') ?? '1')
}

/** The row a key moves to, or null for a key the tree leaves alone. */
export function treeMove(items: readonly HTMLElement[], from: HTMLElement, key: string): HTMLElement | null {
  const at = items.indexOf(from)
  if (at === -1) return null
  switch (key) {
    case 'ArrowDown':
      return items[at + 1] ?? null
    case 'ArrowUp':
      return items[at - 1] ?? null
    case 'Home':
      return items[0] ?? null
    case 'End':
      return items[items.length - 1] ?? null
    case 'ArrowRight': {
      const next = items[at + 1]
      return from.getAttribute('aria-expanded') === 'true' && next && level(next) > level(from) ? next : null
    }
    case 'ArrowLeft':
      return items.slice(0, at).findLast((item) => level(item) < level(from)) ?? null
    default:
      return null
  }
}

/** The row Tab lands on: the one last focused while it is still drawn, else the open worktree, else the first. */
export function treeStop(items: readonly HTMLElement[], last: HTMLElement | null): HTMLElement | null {
  if (last && items.includes(last)) return last
  return items.find((item) => item.getAttribute('aria-current') === 'true') ?? items[0] ?? null
}

/** The project of the tree row holding the focus, or null with the focus outside the tree. */
export function focusedTreeProject(): string | null {
  if (typeof document === 'undefined') return null
  const section = document.activeElement?.closest<HTMLElement>('[role="tree"] [data-project-id]')
  return section?.dataset.projectId ?? null
}

/** Roving tabindex over the tree in `ref`; rows are drawn with `tabIndex={-1}` and this raises one. */
export function useTreeKeys(ref: RefObject<HTMLElement | null>): {
  onKeyDown: (event: React.KeyboardEvent) => void
  onFocus: (event: React.FocusEvent) => void
} {
  const last = useRef<HTMLElement | null>(null)

  const sync = useCallback(() => {
    const tree = ref.current
    if (!tree) return
    const items = treeItems(tree)
    const stop = treeStop(items, last.current)
    for (const item of items) item.tabIndex = item === stop ? 0 : -1
  }, [ref])

  // Rows come and go without this component drawing, so the stop is re-raised on every change.
  useLayoutEffect(() => {
    const tree = ref.current
    if (!tree) return
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(tree, { childList: true, subtree: true, attributeFilter: ['aria-current'] })
    return () => observer.disconnect()
  }, [ref, sync])

  const onFocus = useCallback(
    (event: React.FocusEvent) => {
      if (!(event.target instanceof HTMLElement) || !event.target.matches(ITEM)) return
      last.current = event.target
      sync()
    },
    [sync]
  )

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const tree = ref.current
      const from = event.target
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (!tree || !(from instanceof HTMLElement) || !from.matches(ITEM)) return
      const to = treeMove(treeItems(tree), from, event.key)
      if (!to) return
      event.preventDefault()
      to.focus()
    },
    [ref]
  )

  return { onKeyDown, onFocus }
}
