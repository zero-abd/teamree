// Messages between agents in one project: ask, reply, done, note. Local only;
// never sent to teammates.

import type { TaskOutcome } from './tasks'

/** Most bytes a message body may carry; also the most one paste into a pane carries. */
export const MAX_MESSAGE_BYTES = 8192

/** Most options an ask may offer. */
export const MAX_MESSAGE_OPTIONS = 8

export type MessageKind = 'ask' | 'reply' | 'done' | 'note'

export const MESSAGE_KINDS: readonly MessageKind[] = ['ask', 'reply', 'done', 'note']

export type MessageState = 'queued' | 'delivered' | 'read' | 'answered'

/** One end of a message: a worktree, one pane in it, or the person at the window. */
export type MessageParty = { worktreeId?: string; terminalId?: string; you?: true }

/** Where `message.send` may aim: a party, or one relative to the sender's worktree. */
export type MessageAddress = MessageParty | { relation: 'parent' | 'children' | 'siblings' }

export type TaskMessage = {
  id: number
  projectId: string
  kind: MessageKind
  from: MessageParty
  to: MessageParty
  text: string
  options?: string[]
  replyTo?: number
  outcome?: TaskOutcome
  paths?: string[]
  at: number
  state: MessageState
  answeredBy?: MessageParty
}
