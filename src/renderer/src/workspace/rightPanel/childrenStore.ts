// Landing a parent's children from its panel, or the board's queue: one at a time in the order given, each
// committed first under its own message. Children stop at the first that fails; the queue skips it and goes on.

import { create } from 'zustand'
import type { WorktreeMerge } from '@shared/entities'
import { runtimeClient } from '../../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../../state/workspaceStore'
import type { HeldBack } from './childrenModel'
import { commitSuggestion, shownDraft, useCommitDrafts } from './commitMessage'

export type ChildStop = { worktreeId: string; error: string; conflicts: string[] }

/** The key the board's Ready to land runs under, in place of a parent's id. */
export const LANDING_QUEUE = 'landing-queue'

type ChildrenState = {
  /** The child being merged, per parent. */
  merging: Record<string, string>
  stopped: Record<string, ChildStop>
  /** What the parent's last Merge All Ready left out for a clash. */
  skipped: Record<string, HeldBack[]>
  /** What the last Land All tried and could not land. */
  missed: Record<string, ChildStop[]>
  /** The last Land All's pushes that failed, their landings undone. */
  unpushed: Record<string, string[]>
  /** A parent whose Children section should scroll into view. */
  reveal: string | null
  /** True once every child named has landed. */
  mergeChildren: (parentId: string, childIds: readonly string[], held?: readonly HeldBack[]) => Promise<boolean>
  /** Lands the board's queue in order, skipping one that fails; each project in `push` is pushed once, at the end. */
  landAll: (worktreeIds: readonly string[], push: readonly string[], held?: readonly HeldBack[]) => Promise<void>
  /** Opens the parent on its Changes tab, at its Children. */
  showChildren: (parentId: string) => Promise<void>
  revealed: () => void
}

export const useChildren = create<ChildrenState>((set, get) => ({
  merging: {},
  stopped: {},
  skipped: {},
  missed: {},
  unpushed: {},
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

  async landAll(worktreeIds, push, held = []) {
    if (get().merging[LANDING_QUEUE] !== undefined) return
    set((state) => ({
      skipped: { ...state.skipped, [LANDING_QUEUE]: [...held] },
      missed: { ...state.missed, [LANDING_QUEUE]: [] },
      unpushed: without(state.unpushed, LANDING_QUEUE)
    }))
    const workspace = useWorkspaceStore.getState
    const missed: ChildStop[] = []
    const landed = new Map<string, number>()
    // Per project, where its push puts main back: before the first landing of this run.
    const undoTo = new Map<string, string>()
    for (const worktreeId of worktreeIds) {
      set((state) => ({ merging: { ...state.merging, [LANDING_QUEUE]: worktreeId } }))
      const worktree = workspace().worktrees.find((entry) => entry.id === worktreeId)
      const projectId = worktree?.projectId ?? ''
      const top = worktree !== undefined && worktree.parentId === undefined
      const why = await landChild(
        worktreeId,
        top ? (push.includes(projectId) ? 'later' : false) : undefined,
        (merge) => {
          if (merge.restore !== undefined && !undoTo.has(projectId)) undoTo.set(projectId, merge.restore)
        }
      )
      if (why === null) {
        landed.set(projectId, (landed.get(projectId) ?? 0) + 1)
        continue
      }
      missed.push({ worktreeId, error: why, conflicts: conflictsIn(why) })
      set((state) => ({ missed: { ...state.missed, [LANDING_QUEUE]: [...missed] } }))
    }
    const unpushed: string[] = []
    for (const [projectId, restore] of undoTo) {
      const failure = await workspace().pushBase(projectId, false, restore)
      if (failure === null) continue
      const name = workspace().projects.find((project) => project.id === projectId)?.name
      unpushed.push(name === undefined ? failure.message : `${name}: ${failure.message}`)
      landed.delete(projectId)
    }
    set((state) => ({
      merging: without(state.merging, LANDING_QUEUE),
      ...(unpushed.length === 0 ? {} : { unpushed: { ...state.unpushed, [LANDING_QUEUE]: unpushed } })
    }))
    const count = [...landed.values()].reduce((sum, each) => sum + each, 0)
    const needs = missed.length + held.length
    const summary = [
      count > 0 ? `Landed ${count}` : '',
      needs > 0 ? `${needs} ${needs === 1 ? 'needs' : 'need'} you` : ''
    ]
    if (count + needs > 0) workspace().showNotice(summary.filter(Boolean).join(' · '))
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
async function landChild(
  worktreeId: string,
  push?: boolean | 'later',
  landed?: (merge: WorktreeMerge) => void
): Promise<string | null> {
  const status = await runtimeClient.call('worktree.status', { worktreeId }).catch(() => null)
  const pending = status === null ? 0 : status.staged + status.unstaged + status.untracked + status.conflicted
  if (pending > 0) {
    const worktree = useWorkspaceStore.getState().worktrees.find((entry) => entry.id === worktreeId)
    const suggestion = commitSuggestion(worktree)
    const drafts = useCommitDrafts.getState()
    const message = shownDraft(drafts.drafts[worktreeId], suggestion).text
    if (message.trim() === '') return 'Needs a commit message'
    useWorkspaceStore.getState().noteCommit(worktreeId)
    try {
      await runtimeClient.call('worktree.commit', { worktreeId, message, all: true })
    } catch (failure) {
      useWorkspaceStore.getState().noteCommit(worktreeId, failure)
      return failure instanceof Error ? failure.message : String(failure)
    }
    drafts.setDraft(worktreeId, { text: '', seed: suggestion?.text ?? null })
  }
  return useWorkspaceStore.getState().mergeIntoBase(worktreeId, push, landed)
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
