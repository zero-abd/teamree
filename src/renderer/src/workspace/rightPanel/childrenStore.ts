// Landing a parent's children from its panel: one at a time in the order given, each committed first under
// its own message, stopping at the first that fails. The stop stays on the parent until the next run.

import { create } from 'zustand'
import { runtimeClient } from '../../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../../state/workspaceStore'
import type { HeldBack } from './childrenModel'
import { commitSuggestion, shownDraft, useCommitDrafts } from './commitMessage'

export type ChildStop = { worktreeId: string; error: string; conflicts: string[] }

type ChildrenState = {
  /** The child being merged, per parent. */
  merging: Record<string, string>
  stopped: Record<string, ChildStop>
  /** What the parent's last Merge All Ready left out for a clash. */
  skipped: Record<string, HeldBack[]>
  /** A parent whose Children section should scroll into view. */
  reveal: string | null
  /** True once every child named has landed. */
  mergeChildren: (parentId: string, childIds: readonly string[], held?: readonly HeldBack[]) => Promise<boolean>
  /** Opens the parent on its Changes tab, at its Children. */
  showChildren: (parentId: string) => Promise<void>
  revealed: () => void
}

export const useChildren = create<ChildrenState>((set, get) => ({
  merging: {},
  stopped: {},
  skipped: {},
  reveal: null,

  async mergeChildren(parentId, childIds, held = []) {
    if (get().merging[parentId] !== undefined) return false
    set((state) => ({
      stopped: without(state.stopped, parentId),
      skipped: held.length === 0 ? without(state.skipped, parentId) : { ...state.skipped, [parentId]: [...held] }
    }))
    for (const childId of childIds) {
      set((state) => ({ merging: { ...state.merging, [parentId]: childId } }))
      const why = await landChild(childId)
      if (why === null) continue
      set((state) => ({
        merging: without(state.merging, parentId),
        stopped: { ...state.stopped, [parentId]: { worktreeId: childId, error: why, conflicts: conflictsIn(why) } }
      }))
      return false
    }
    set((state) => ({ merging: without(state.merging, parentId) }))
    return true
  },

  async showChildren(parentId) {
    // Even when it is the active one: opening it is what closes the board over it.
    await useWorkspaceStore.getState().openWorktree(parentId)
    useWorkspaceStore.getState().showRightPanelTab('changes')
    set({ reveal: parentId })
  },

  revealed() {
    set({ reveal: null })
  }
}))

/** Commits what the child has left uncommitted, then merges it into its parent; why not, or null once landed. */
async function landChild(worktreeId: string): Promise<string | null> {
  const status = await runtimeClient.call('worktree.status', { worktreeId }).catch(() => null)
  const pending = status === null ? 0 : status.staged + status.unstaged + status.untracked + status.conflicted
  if (pending > 0) {
    const worktree = useWorkspaceStore.getState().worktrees.find((entry) => entry.id === worktreeId)
    const suggestion = commitSuggestion(worktree)
    const drafts = useCommitDrafts.getState()
    const message = shownDraft(drafts.drafts[worktreeId], suggestion).text
    if (message.trim() === '') return 'Needs a commit message'
    try {
      await runtimeClient.call('worktree.commit', { worktreeId, message, all: true })
    } catch (failure) {
      return failure instanceof Error ? failure.message : String(failure)
    }
    drafts.setDraft(worktreeId, { text: '', seed: suggestion?.text ?? null })
  }
  return useWorkspaceStore.getState().mergeIntoBase(worktreeId)
}

/** The files named by the merge's own refusal, `… conflicts with … in a.js, b.js`. */
function conflictsIn(error: string): string[] {
  const listed = / conflicts with .+? in (.+)$/.exec(error)?.[1]
  return listed === undefined ? [] : listed.split(', ')
}

function without<T>(map: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = map
  return rest
}
