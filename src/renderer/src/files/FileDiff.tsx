// A file pane's working-tree diff: whether there is one, the bar's Inline / Side by side / Diff, and the
// staged and unstaged halves with their per-hunk actions.

import { useEffect, useRef, useState } from 'react'
import type { WorktreeDiff } from '@shared/entities'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import type { DiffLayout } from '../state/preferences'
import { useWorkspaceStore } from '../state/workspaceStore'
import { fitLayout, PatchView } from '../workspace/PatchView'

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
  const setDiffLayout = useWorkspaceStore((state) => state.setDiffLayout)
  const setPaneDiff = useWorkspaceStore((state) => state.setPaneDiff)
  const { shown, layout } = diff
  return (
    <>
      {shown ? (
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
            disabled={fitLayout('split', diff.bodyWidth) !== 'split'}
            onClick={() => setDiffLayout('split')}
          >
            Side by side
          </button>
        </>
      ) : null}
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

export function DiffBody({ worktreeId, diff }: { worktreeId: string; diff: FileDiff }): React.JSX.Element {
  const busy = useWorkspaceStore((state) => state.hunkPending)
  const applyHunk = useWorkspaceStore((state) => state.applyHunk)
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  const { diffs, layout } = diff
  if (diffs === null) return <p className="file__state">{diff.error ?? 'Reading…'}</p>
  const staged = diffs.staged.patch === '' ? null : diffs.staged
  const working = diffs.working.patch === '' ? null : diffs.working
  if (staged === null && working === null) return <p className="file__state">No changes</p>
  // Halves are named only when both are there; the staged one first, as the next commit's.
  return (
    <div className="file__diff">
      {staged === null ? null : (
        <>
          {working === null ? null : <h3 className="patch__half">Staged</h3>}
          <PatchView
            patch={staged.patch}
            truncated={staged.truncated}
            layout={layout}
            action="Unstage"
            busy={busy}
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
            onHunk={(file, hunk) => void applyHunk(worktreeId, file.path, hunk, true)}
            onDiscard={(file, hunk) => openDialog({ kind: 'confirm-discard', worktreeId, path: file.path, hunk })}
          />
        </>
      )}
    </div>
  )
}

/** The element's width while `active`, kept current as it resizes; null until measured. */
function useWidth(ref: React.RefObject<HTMLElement | null>, active: boolean): number | null {
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
