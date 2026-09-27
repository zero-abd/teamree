// A worktree's overlap chip as the window names it, and what opening one of its files does.

import { teammatesHeard, type TeammateWorktree, type Worktree } from '@shared/entities'
import type { WorktreeOverlap } from '@shared/tasks'
import { useOverlaps } from '../state/overlapStore'
import { useWorkspaceStore } from '../state/workspaceStore'
import { overlapChip, type OverlapChip, type OverlapEntry } from './overlapChip'
import { worktreeDisplay } from './worktreeDisplay'

/** A worktree as its owner names it, a teammate's after their handle; a base as `parent` or its ref. */
export function overlapNamer(
  worktrees: readonly Worktree[],
  theirs: readonly TeammateWorktree[]
): (other: WorktreeOverlap['with']) => string {
  return (other) => {
    if ('base' in other) return other.worktreeId === undefined ? other.base : 'parent'
    if ('handle' in other) {
      const row = theirs.find((worktree) => worktree.id === other.worktreeId)
      return `${other.handle} · ${row === undefined ? '' : worktreeDisplay(row).title}`
    }
    const worktree = worktrees.find((row) => row.id === other.worktreeId)
    return worktree === undefined ? other.worktreeId : worktreeDisplay(worktree).title
  }
}

/** The chip for any worktree, read once for a whole list. */
export function useOverlapChips(): (worktreeId: string | null) => OverlapChip | null {
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const teammates = useWorkspaceStore((state) => state.teammates)
  const byProject = useOverlaps((state) => state.byProject)
  return (worktreeId) => {
    const worktree = worktrees.find((row) => row.id === worktreeId)
    if (worktree === undefined) return null
    const theirs = teammatesHeard(teammates[worktree.projectId])?.worktrees ?? []
    return overlapChip(worktree.id, byProject[worktree.projectId], overlapNamer(worktrees, theirs))
  }
}

export function useOverlapChip(worktreeId: string | null): OverlapChip | null {
  return useOverlapChips()(worktreeId)
}

/** Compare on the file with a local worktree; a teammate's checkout is not here, so their first pane opens instead. */
export function openOverlap(worktreeId: string, entry: OverlapEntry): void {
  const state = useWorkspaceStore.getState()
  const worktree = state.worktrees.find((row) => row.id === worktreeId)
  if (worktree === undefined) return
  const other = entry.with
  if ('base' in other) {
    if (other.worktreeId === undefined) void state.openFileAt(worktreeId, entry.path)
    else
      void state.openCompare(worktreeId, other.worktreeId, `${worktreeDisplay(worktree).title} vs parent`, entry.path)
    return
  }
  if (!('handle' in other)) {
    const title = `${worktreeDisplay(worktree).title} vs ${entry.name}`
    void state.openCompare(worktreeId, other.worktreeId, title, entry.path)
    return
  }
  const theirs = teammatesHeard(state.teammates[worktree.projectId])?.worktrees ?? []
  const pane = theirs.find((row) => row.id === other.worktreeId)?.panes[0]
  if (pane === undefined) return
  const watched = state.watches.some((watch) => watch.projectId === worktree.projectId && watch.paneId === pane.id)
  if (!watched)
    state.toggleWatchedPane(worktree.projectId, {
      terminalId: pane.id,
      label: pane.label ?? pane.title,
      handle: other.handle
    })
}
