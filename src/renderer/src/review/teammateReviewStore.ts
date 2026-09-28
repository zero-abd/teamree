// Reviews of teammates' tasks: which are open beside the workspace, and the comments written on each,
// held until they go to its owner in one send.

import { create } from 'zustand'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'
import type { ReviewComment } from './reviewComments'

/** A teammate's task open for review; `worktreeId` is the id `teamwork.presence` gives it. */
export type OpenReview = { projectId: string; worktreeId: string; title: string }

type TeammateReviewState = {
  open: OpenReview[]
  /** Opens it beside the workspace, once; nothing is checked out. */
  openReview: (review: OpenReview) => void
  closeReview: (worktreeId: string) => void
  /** Teammate worktree id, as presence names it → the comments not sent yet. */
  batch: Record<string, ReviewComment[]>
  add: (worktreeId: string, comment: ReviewComment) => void
  remove: (worktreeId: string, index: number) => void
  clear: (worktreeId: string) => void
  /** Sends the batch to the task's owner and says how it went; whether it went. */
  send: (projectId: string, worktreeId: string, handle: string) => Promise<boolean>
}

export const useTeammateReview = create<TeammateReviewState>()((set, get) => ({
  open: [],
  batch: {},

  openReview(review) {
    set((state) =>
      state.open.some((held) => held.worktreeId === review.worktreeId) ? {} : { open: [...state.open, review] }
    )
  },

  closeReview(worktreeId) {
    set((state) => ({ open: state.open.filter((held) => held.worktreeId !== worktreeId) }))
  },

  add(worktreeId, comment) {
    set((state) => ({ batch: { ...state.batch, [worktreeId]: [...(state.batch[worktreeId] ?? []), comment] } }))
  },

  remove(worktreeId, index) {
    set((state) => ({
      batch: { ...state.batch, [worktreeId]: (state.batch[worktreeId] ?? []).filter((_, at) => at !== index) }
    }))
  },

  clear(worktreeId) {
    set((state) => {
      const batch = { ...state.batch }
      delete batch[worktreeId]
      return { batch }
    })
  },

  async send(projectId, worktreeId, handle) {
    const comments = get().batch[worktreeId] ?? []
    if (comments.length === 0) return false
    const { showNotice } = useWorkspaceStore.getState()
    try {
      await runtimeClient.call('teamwork.sendReview', { projectId, worktreeId, comments })
    } catch (failure) {
      showNotice(`Not sent: ${failure instanceof Error ? failure.message : String(failure)}`, 'error')
      return false
    }
    get().clear(worktreeId)
    showNotice(`Sent ${comments.length} ${comments.length === 1 ? 'comment' : 'comments'} to ${handle}`)
    return true
  }
}))
