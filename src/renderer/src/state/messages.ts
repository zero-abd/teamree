// Messages the window draws: asks for you, on the asking task's row, and each
// parent's latest child done. Re-read whenever the runtime says messages changed.

import { create } from 'zustand'
import type { TaskMessage } from '@shared/messages'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'

/** Enough history for every open ask and each parent's latest done. */
const READ_LIMIT = 500

type MessagesState = {
  messages: readonly TaskMessage[]
  load: () => Promise<void>
  /** Sends your answer, as a note once nobody waits on it; false when refused, e.g. somebody answered first. */
  answer: (ask: TaskMessage, text: string) => Promise<boolean>
  dismiss: (ask: TaskMessage) => Promise<void>
}

export const useMessageStore = create<MessagesState>()((set, get) => ({
  messages: [],
  async load() {
    try {
      set({ messages: await runtimeClient.call('message.list', { kinds: ['ask', 'done'], limit: READ_LIMIT }) })
    } catch {
      // A runtime without messages, or one restarting: the rows draw without them.
    }
  },
  async answer(ask, text) {
    const trimmed = text.trim()
    if (trimmed === '') return false
    try {
      await runtimeClient.call('message.send', {
        from: { you: true },
        to: ask.from,
        kind: waitedOn(ask) ? 'reply' : 'note',
        replyTo: ask.id,
        text: trimmed
      })
      return true
    } catch {
      return false
    } finally {
      await get().load()
    }
  },
  async dismiss(ask) {
    try {
      await runtimeClient.call('message.read', { ids: [ask.id] })
    } catch {
      // Still drawn; the next click tries again.
    }
    await get().load()
  }
}))

/** Something still waits on this ask's answer. */
export function waitedOn(ask: TaskMessage): boolean {
  return ask.expiredAt === undefined
}

function openForYou(message: TaskMessage): boolean {
  // Only Dismiss marks an ask for you read.
  const dismissed = message.state === 'read'
  return message.kind === 'ask' && message.to.you === true && message.state !== 'answered' && !dismissed
}

/** The newest ask this worktree put to you that is neither answered nor dismissed. */
export function askForYou(messages: readonly TaskMessage[], worktreeId: string): TaskMessage | undefined {
  return messages.findLast((message) => openForYou(message) && message.from.worktreeId === worktreeId)
}

/** Worktrees with an ask for you something still waits on. */
export function askingWorktrees(messages: readonly TaskMessage[]): Set<string> {
  return new Set(
    messages.flatMap((message) =>
      openForYou(message) && waitedOn(message) && message.from.worktreeId !== undefined ? [message.from.worktreeId] : []
    )
  )
}

/** The newest done a child sent this worktree. */
export function childDone(messages: readonly TaskMessage[], worktreeId: string): TaskMessage | undefined {
  return messages.findLast((message) => message.kind === 'done' && message.to.worktreeId === worktreeId)
}

/** A summary's first sentence, for a row's one line. */
export function firstSentence(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  const end = line.search(/[.!?](\s|$)/)
  return end === -1 ? line : line.slice(0, end + 1)
}
