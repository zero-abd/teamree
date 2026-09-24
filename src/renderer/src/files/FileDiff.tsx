// A file pane's working-tree diff: whether there is one, the bar's Inline / Side by side / Diff, the
// staged and unstaged halves with their per-hunk actions, and find over both. A read-only patch reuses the parts.

import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { WorktreeDiff } from '@shared/entities'
import { parsePatch } from '@shared/patch'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import type { DiffLayout } from '../state/preferences'
import { useWorkspaceStore } from '../state/workspaceStore'
import { EMPTY_PANE_SEARCH, paneSearchReducer, type PaneSearchState } from '../terminal/paneSearchModel'
import { TerminalSearchBar } from '../terminal/TerminalSearchBar'
import { fitLayout, PatchView, type PatchPlace } from '../workspace/PatchView'
import { DIFF_MATCH_LIMIT, findInPatches, stepMatch, type DiffMatch } from './diffFind'

type Diffs = { working: WorktreeDiff; staged: WorktreeDiff }

export type FileDiff = {
  paneId: string
  shown: boolean
  /** Null until the worktree has answered. */
  changed: boolean | null
  diffs: Diffs | null
  error: string | null
  layout: DiffLayout
  /** Where the diff goes, measured so a narrow pane stays inline. */
  body: React.RefObject<HTMLDivElement | null>
  bodyWidth: number | null
}

export function useFileDiff(paneId: string, worktreeId: string, path: string): FileDiff {
  const filesEpoch = useWorkspaceStore((state) => state.worktreeFilesEpoch)
  const diffLayout = useWorkspaceStore((state) => state.diffLayout)
  const shown = useWorkspaceStore((state) => state.diffPanes[paneId] === true)
  const [changed, setChanged] = useState<boolean | null>(null)
  const [diffs, setDiffs] = useState<Diffs | null>(null)
  const [error, setError] = useState<string | null>(null)
  const body = useRef<HTMLDivElement | null>(null)
  const bodyWidth = useWidth(body, shown)

  useEffect(() => {
    let alive = true
    runtimeClient
      .call('worktree.changes', { worktreeId, path, limit: 1 })
      .then((changes) => {
        if (alive && changes) setChanged(changes.total > 0)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [worktreeId, path, filesEpoch])

  useEffect(() => {
    if (!shown) return
    let alive = true
    void Promise.all([
      runtimeClient.call('worktree.diff', { worktreeId, path }),
      runtimeClient.call('worktree.diff', { worktreeId, path, staged: true })
    ])
      .then(([working, staged]) => {
        if (!alive) return
        setDiffs({ working, staged })
        setError(null)
      })
      .catch((failure: unknown) => {
        if (alive) setError(failure instanceof Error ? failure.message : String(failure))
      })
    return () => {
      alive = false
    }
  }, [shown, worktreeId, path, filesEpoch])

  return { paneId, shown, changed, diffs, error, layout: fitLayout(diffLayout, bodyWidth), body, bodyWidth }
}

/** The bar's diff controls: the layouts while the diff is open, and Diff itself. */
export function DiffTools({ diff }: { diff: FileDiff }): React.JSX.Element {
  const setPaneDiff = useWorkspaceStore((state) => state.setPaneDiff)
  const { shown, layout } = diff
  return (
    <>
      {shown ? <LayoutTools layout={layout} bodyWidth={diff.bodyWidth} /> : null}
      <button
        type="button"
        className={`file__tool${shown ? ' file__tool--on' : ''}`}
        aria-pressed={shown}
        // Left enabled while open, so a diff emptied by a discard can still be closed.
        disabled={diff.changed === false && !shown}
        onClick={() => setPaneDiff(diff.paneId, !shown)}
      >
        Diff
      </button>
    </>
  )
}

/** Inline and Side by side; the second is off where two columns would not fit. */
export function LayoutTools({
  layout,
  bodyWidth
}: {
  layout: DiffLayout
  bodyWidth: number | null
}): React.JSX.Element {
  const setDiffLayout = useWorkspaceStore((state) => state.setDiffLayout)
  return (
    <>
      <button
        type="button"
        className={`file__tool${layout === 'inline' ? ' file__tool--on' : ''}`}
        aria-pressed={layout === 'inline'}
        onClick={() => setDiffLayout('inline')}
      >
        Inline
      </button>
      <button
        type="button"
        className={`file__tool${layout === 'split' ? ' file__tool--on' : ''}`}
        aria-pressed={layout === 'split'}
        disabled={fitLayout('split', bodyWidth) !== 'split'}
        onClick={() => setDiffLayout('split')}
      >
        Side by side
      </button>
    </>
  )
}

/** One patch read-only, with find over it: no Stage, Unstage or Discard. `patch` is null while it is read. */
export function ReadOnlyDiffBody({
  patch,
  truncated,
  error,
  layout,
  searchToken = 0,
  onCloseSearch
}: {
  patch: string | null
  truncated: boolean
  error: string | null
  layout: DiffLayout
  searchToken?: number
  onCloseSearch?: (() => void) | undefined
}): React.JSX.Element {
  const scroller = useRef<HTMLDivElement | null>(null)
  const find = useDiffFind(scroller, null, patch === '' ? null : patch, searchToken)
  const bar = findBar(find, scroller, searchToken, onCloseSearch)
  if (patch === null || patch === '') {
    return (
      <div className="file__diffs">
        {bar}
        <p className="file__state">{patch === null ? (error ?? 'Reading…') : 'No changes'}</p>
      </div>
    )
  }
  return (
    <div className="file__diffs">
      {bar}
      <div className="file__diff" ref={scroller} tabIndex={-1}>
        <PatchView patch={patch} truncated={truncated} layout={layout} reveal={find.reveal(0)} />
      </div>
    </div>
  )
}

/** The find field over a diff, while it is open. */
function findBar(
  find: DiffFind,
  scroller: React.RefObject<HTMLDivElement | null>,
  searchToken: number,
  onCloseSearch: (() => void) | undefined
): React.JSX.Element | null {
  if (searchToken === 0) return null
  return (
    <TerminalSearchBar
      state={find.state}
      focusToken={searchToken}
      limit={DIFF_MATCH_LIMIT}
      onQueryChange={find.query}
      onToggle={find.toggle}
      onStep={find.step}
      onClose={() => {
        onCloseSearch?.()
        scroller.current?.focus()
      }}
    />
  )
}

export function DiffBody({
  worktreeId,
  diff,
  searchToken = 0,
  onCloseSearch
}: {
  worktreeId: string
  diff: FileDiff
  /** Bumped to open the find bar; 0 while it is closed. */
  searchToken?: number
  onCloseSearch?: () => void
}): React.JSX.Element {
  const busy = useWorkspaceStore((state) => state.hunkPending)
  const applyHunk = useWorkspaceStore((state) => state.applyHunk)
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  const { diffs, layout } = diff
  const staged = diffs === null || diffs.staged.patch === '' ? null : diffs.staged
  const working = diffs === null || diffs.working.patch === '' ? null : diffs.working
  const scroller = useRef<HTMLDivElement | null>(null)
  const find = useDiffFind(scroller, staged?.patch ?? null, working?.patch ?? null, searchToken)

  const bar = findBar(find, scroller, searchToken, onCloseSearch)

  if (diffs === null || (staged === null && working === null)) {
    return (
      <div className="file__diffs">
        {bar}
        <p className="file__state">{diffs === null ? (diff.error ?? 'Reading…') : 'No changes'}</p>
      </div>
    )
  }
  // Halves are named only when both are there; the staged one first, as the next commit's.
  return (
    <div className="file__diffs">
      {bar}
      <div className="file__diff" ref={scroller} tabIndex={-1}>
        {staged === null ? null : (
          <>
            {working === null ? null : <h3 className="patch__half">Staged</h3>}
            <PatchView
              patch={staged.patch}
              truncated={staged.truncated}
              layout={layout}
              action="Unstage"
              busy={busy}
              reveal={find.reveal(0)}
              onHunk={(file, hunk) => void applyHunk(worktreeId, file.path, hunk, false)}
            />
          </>
        )}
        {working === null ? null : (
          <>
            {staged === null ? null : <h3 className="patch__half">Unstaged</h3>}
            <PatchView
              patch={working.patch}
              truncated={working.truncated}
              layout={layout}
              action="Stage"
              busy={busy}
              reveal={find.reveal(staged === null ? 0 : 1)}
              onHunk={(file, hunk) => void applyHunk(worktreeId, file.path, hunk, true)}
              onDiscard={(file, hunk) => openDialog({ kind: 'confirm-discard', worktreeId, path: file.path, hunk })}
            />
          </>
        )}
      </div>
    </div>
  )
}

type DiffFind = {
  state: PaneSearchState
  query: (value: string) => void
  toggle: (option: keyof PaneSearchState['options']) => void
  step: (direction: 'next' | 'previous') => void
  /** Where the current match is in the half at this index of those shown, if it is there. */
  reveal: (half: number) => PatchPlace | null
}

/** Find over the shown halves: matched on the parsed patch, painted on the rows that are drawn. */
function useDiffFind(
  scroller: React.RefObject<HTMLDivElement | null>,
  staged: string | null,
  working: string | null,
  searchToken: number
): DiffFind {
  const open = searchToken > 0
  const [search, dispatch] = useReducer(paneSearchReducer, EMPTY_PANE_SEARCH)
  const [index, setIndex] = useState(0)
  // Set by whatever moves to a match, and spent by the paint that finds its row drawn.
  const scrollPending = useRef(false)
  const halves = useMemo(
    () => [staged, working].flatMap((patch) => (patch === null ? [] : [parsePatch(patch)])),
    [staged, working]
  )
  const matches = useMemo(
    () => (open ? findInPatches(halves, search.query, search.options) : []),
    [open, halves, search.query, search.options]
  )
  // Clamped rather than reset: a refresh of the patch keeps the place.
  const current = matches.length === 0 ? -1 : Math.min(Math.max(index, 0), matches.length - 1)
  const target = matches[current]

  useEffect(() => {
    scrollPending.current = open
  }, [open])

  useEffect(() => {
    const root = scroller.current
    if (!open || root === null) return
    let frame = 0
    const paint = (): void => {
      frame = 0
      paintMatches(root, matches, current, scrollPending)
    }
    paint()
    // Rows arrive a slice at a task, and a refresh redraws them.
    const observer = new MutationObserver(() => {
      if (frame === 0) frame = requestAnimationFrame(paint)
    })
    observer.observe(root, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      clearMatches()
    }
  }, [scroller, open, matches, current])

  const land = (next: number): void => {
    scrollPending.current = true
    setIndex(next)
  }

  return {
    state: { ...search, current: current + 1, total: matches.length },
    query: (value) => {
      dispatch({ type: 'query', value })
      land(0)
    },
    toggle: (option) => {
      dispatch({ type: 'toggle', option })
      land(0)
    },
    step: (direction) => land(stepMatch(current, matches.length, direction)),
    reveal: (half) => (target?.half === half ? { file: target.file, hunk: target.hunk, line: target.line } : null)
  }
}

const ALL_MATCHES = 'diff-find'
const CURRENT_MATCH = 'diff-find-current'

/** Highlights every drawn match, and scrolls to the current one if a move is waiting on it. */
function paintMatches(
  root: HTMLElement,
  matches: readonly DiffMatch[],
  current: number,
  scrollPending: React.RefObject<boolean>
): void {
  const halves = root.querySelectorAll<HTMLElement>(':scope > .patch')
  // Each drawn hunk's line elements by index; a context line in two columns is drawn twice.
  const hunks = new Map<string, Map<number, HTMLElement[]>>()
  const linesOf = (match: DiffMatch): HTMLElement[] => {
    const key = `${match.half}:${match.file}:${match.hunk}`
    let lines = hunks.get(key)
    if (lines === undefined) {
      lines = new Map()
      const hunk = halves[match.half]?.querySelector(`[data-hunk="${match.file}:${match.hunk}"]`)
      for (const element of hunk?.querySelectorAll<HTMLElement>('[data-line]') ?? []) {
        const at = Number(element.dataset.line)
        lines.set(at, [...(lines.get(at) ?? []), element])
      }
      hunks.set(key, lines)
    }
    return lines.get(match.line) ?? []
  }

  const all: Range[] = []
  let active: Range | null = null
  matches.forEach((match, at) => {
    for (const element of linesOf(match)) {
      const range = rangeIn(element, match.start, match.end)
      if (range === null) continue
      all.push(range)
      if (at === current) active ??= range
    }
  })

  if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
    CSS.highlights.set(ALL_MATCHES, new Highlight(...all))
    CSS.highlights.set(CURRENT_MATCH, active === null ? new Highlight() : new Highlight(active))
  }
  if (active !== null && scrollPending.current) {
    scrollPending.current = false
    scrollToRange(root, active)
  }
}

function clearMatches(): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return
  CSS.highlights.delete(ALL_MATCHES)
  CSS.highlights.delete(CURRENT_MATCH)
}

/** The range of `start`..`end` in the element's text, which its token spans split into several nodes. */
function rangeIn(element: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let offset = 0
  let started = false
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0
    if (!started && start < offset + length) {
      range.setStart(node, start - offset)
      started = true
    }
    if (started && end <= offset + length) {
      range.setEnd(node, end - offset)
      return range
    }
    offset += length
  }
  return null
}

/** Opens whatever folds the range away, then centres it in the scroller. */
function scrollToRange(root: HTMLElement, range: Range): void {
  for (let fold = range.startContainer.parentElement?.closest('details'); fold; ) {
    fold.open = true
    fold = fold.parentElement?.closest('details')
  }
  const box = range.getBoundingClientRect()
  const view = root.getBoundingClientRect()
  root.scrollTop += box.top - view.top - (view.height - box.height) / 2
  if (box.left < view.left || box.right > view.right) root.scrollLeft += box.left - view.left - view.width / 2
}

/** The element's width while `active`, kept current as it resizes; null until measured. */
export function useWidth(ref: React.RefObject<HTMLElement | null>, active: boolean): number | null {
  const [width, setWidth] = useState<number | null>(null)
  useEffect(() => {
    const element = ref.current
    if (!active || element === null) return
    setWidth(element.clientWidth)
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, active])
  return width
}
