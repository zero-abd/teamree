// Reviewing a teammate's task: its diff read on this machine, and line comments sent back to its owner.
// No zod here: the window imports this. The schemas are in `reviewMethods.ts`.

/** The most of a task's diff its owner's machine sends over the relay, in UTF-8 bytes. */
export const MAX_PEER_PATCH_BYTES = 1024 * 1024
export const MAX_REVIEW_COMMENTS = 100
/** Lines one comment may quote. */
export const MAX_REVIEW_LINES = 40
export const MAX_REVIEW_LINE_CHARS = 2000
export const MAX_REVIEW_NOTE_CHARS = 4000
/** Review requests one presence snapshot carries. */
export const MAX_REVIEW_REQUESTS = 20

/** One quoted line of the patch, numbered on both sides as `patch.ts` numbers it. */
export type ReviewLine = {
  kind: 'added' | 'removed' | 'context'
  text: string
  oldNumber: number | null
  newNumber: number | null
}

/** A comment on some lines of one file. The same shape as the window's review comment. */
export type ReviewNote = { path: string; lines: ReviewLine[]; note: string }

/** What `peer.taskPatch` answers: the task's branch against its base, uncommitted work included. */
export type PeerTaskPatch = { branch: string; patch: string; truncated: boolean }

/** A teammate's task diff as read here. `origin`: their pushed branch; `peer`: sent by their machine. */
export type TeammateDiff = {
  /** The teammate worktree's id as `teamwork.presence` names it. */
  worktreeId: string
  handle: string
  branch: string
  source: 'origin' | 'peer'
  patch: string
  truncated: boolean
  readAt: number
}

/** What crosses the wire as `peer.review`. The sender is the link's key, never a field. */
export type PeerReview = { reviewId: string; worktreeId: string; comments: ReviewNote[]; sentAt: number }

/**
 * A review asked of one teammate, carried in presence until they send one. Incoming, `worktreeId` is the
 * task's id as `teamwork.presence` names it and `from` is this roster's handle for the sender.
 */
export type PeerReviewRequest = {
  id: string
  /** The reviewer's handle; only they draw it. */
  to: string
  from?: string
  worktreeId: string
  worktreeName: string
  branch: string
  at: number
  /** Incoming only: its popup has been answered. */
  seen?: true
}

export type TeamworkReviewRequests = { incoming: PeerReviewRequest[]; outgoing: PeerReviewRequest[] }

/** A teammate's comments on one of this machine's worktrees. */
export type ReceivedReview = {
  /** This machine's id for this one arrival. */
  id: string
  projectId: string
  worktreeId: string
  handle: string
  publicKey: string
  comments: ReviewNote[]
  /** The sender's clock. */
  sentAt: number
  /** This machine's clock. */
  receivedAt: number
  /** Its popup has been answered. */
  seen: boolean
}
