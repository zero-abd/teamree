// What a review of a worktree keeps: files marked viewed, comments batched, and panes holding typed, unsent comments.

import { create } from 'zustand'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { activityOf, paneAgent } from '../sidebar/agentRows'
import { useWorkspaceStore } from '../state/workspaceStore'
import { commentMessage, pasted, type ReviewComment } from './reviewComments'
import type { ViewedMark } from './reviewModel'

/** Between the paste and its Return, so a prompt that times input bursts reads them as two. */
const PASTE_SETTLE_MS = 60

export type SendOutcome = 'sent' | 'queued' | 'refused' | 'failed'

type ReviewState = {
  /** Worktree id → path → what the file looked like when it was marked viewed. */
  viewed: Record<string, Record<string, ViewedMark>>
  batch: Record<string, ReviewComment[]>
  /** Panes holding review text typed without its Return, because they were working. */
  queued: Record<string, true>
  markViewed: (worktreeId: string, path: string, mark: ViewedMark | null) => void
  addToBatch: (worktreeId: string, comment: ReviewComment) => void
  clearBatch: (worktreeId: string) => void
  /** Types the comments into an agent pane; Return too unless it is working. Never a shell. */
  send: (terminalId: string, comments: readonly ReviewComment[]) => Promise<SendOutcome>
  sendBatch: (worktreeId: string, terminalId: string) => Promise<SendOutcome>
  sendQueued: (terminalId: string) => Promise<void>
  forgetQueued: (terminalId: string) => void
}

export const useReviewStore = create<ReviewState>()((set, get) => {
  const write = (terminalId: string, data: string): Promise<unknown> =>
    runtimeClient.call('terminal.write', { terminalId, data })

  return {
    viewed: {},
    batch: {},
    queued: {},

    markViewed(worktreeId, path, mark) {
      set((state) => {
        const marks = { ...state.viewed[worktreeId] }
        if (mark === null) delete marks[path]
        else marks[path] = mark
        return { viewed: { ...state.viewed, [worktreeId]: marks } }
      })
    },

    addToBatch(worktreeId, comment) {
      set((state) => ({ batch: { ...state.batch, [worktreeId]: [...(state.batch[worktreeId] ?? []), comment] } }))
    },

    clearBatch(worktreeId) {
      set((state) => {
        const batch = { ...state.batch }
        delete batch[worktreeId]
        return { batch }
      })
    },

    async send(terminalId, comments) {
      const terminal = useWorkspaceStore.getState().terminals[terminalId]
      if (terminal === undefined || !terminal.running || paneAgent(terminal) === undefined) return 'refused'
      if (comments.length === 0) return 'refused'
      const working = activityOf(terminal) === 'working'
      try {
        await write(terminalId, pasted(commentMessage(comments)))
        if (working) {
          set((state) => ({ queued: { ...state.queued, [terminalId]: true } }))
          return 'queued'
        }
        await new Promise((resolve) => setTimeout(resolve, PASTE_SETTLE_MS))
        await write(terminalId, '\r')
        return 'sent'
      } catch {
        return 'failed'
      }
    },

    async sendBatch(worktreeId, terminalId) {
      const outcome = await get().send(terminalId, get().batch[worktreeId] ?? [])
      if (outcome === 'sent' || outcome === 'queued') get().clearBatch(worktreeId)
      return outcome
    },

    async sendQueued(terminalId) {
      get().forgetQueued(terminalId)
      await write(terminalId, '\r').catch(() => undefined)
    },

    forgetQueued(terminalId) {
      set((state) => {
        if (!state.queued[terminalId]) return {}
        const queued = { ...state.queued }
        delete queued[terminalId]
        return { queued }
      })
    }
  }
})

// Going to a pane that holds a queued comment hands it over: what is typed there is the owner's to send.
useWorkspaceStore.subscribe((state, previous) => {
  const focused = focusedPane(state)
  if (focused !== null && focused !== focusedPane(previous)) useReviewStore.getState().forgetQueued(focused)
})

function focusedPane(state: ReturnType<typeof useWorkspaceStore.getState>): string | null {
  return state.activeWorktreeId === null ? null : (state.layouts[state.activeWorktreeId]?.focusedTerminalId ?? null)
}
