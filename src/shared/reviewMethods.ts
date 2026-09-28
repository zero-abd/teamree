// Methods for reviewing a teammate's task. Merged into the contract through methods.ts; the
// types and caps are in `teammateReview.ts`, which the window can load without zod.

import { z } from 'zod'
import {
  MAX_PEER_PATCH_BYTES,
  MAX_REVIEW_COMMENTS,
  MAX_REVIEW_LINE_CHARS,
  MAX_REVIEW_LINES,
  MAX_REVIEW_NOTE_CHARS,
  type PeerReviewRequest,
  type PeerTaskPatch,
  type ReceivedReview,
  type TeammateDiff,
  type TeamworkReviewRequests
} from './teammateReview'

const Id = z.string().min(1).max(256)
const Line = z.number().int().nonnegative().nullable()
const encoder = new TextEncoder()

export const ReviewNoteSchema = z.object({
  path: z.string().min(1).max(4096),
  lines: z
    .array(
      z.object({
        kind: z.enum(['added', 'removed', 'context']),
        text: z.string().max(MAX_REVIEW_LINE_CHARS),
        oldNumber: Line,
        newNumber: Line
      })
    )
    .min(1)
    .max(MAX_REVIEW_LINES),
  note: z.string().trim().min(1).max(MAX_REVIEW_NOTE_CHARS)
})

const Comments = z.array(ReviewNoteSchema).min(1).max(MAX_REVIEW_COMMENTS)

/** A teammate's answer to `peer.taskPatch`, checked before anything here reads it. */
export const PeerTaskPatchSchema = z.object({
  branch: z.string().min(1).max(512),
  patch: z.string().refine((patch) => encoder.encode(patch).length <= MAX_PEER_PATCH_BYTES),
  truncated: z.boolean()
})

export const ReviewParams = {
  /** A teammate's task diff: their pushed branch when origin has it, else their machine's patch. */
  teamworkTeammateDiff: z.object({ projectId: Id, worktreeId: Id }),
  /** Sends comments on a teammate's task to its owner; refused while they are offline. */
  teamworkSendReview: z.object({ projectId: Id, worktreeId: Id, comments: Comments }),
  /** Teammates' comments on this machine's worktrees, oldest first. */
  teamworkReviews: z.object({ projectId: Id.optional() }),
  /** `seen` retires its popup; `closed` forgets it. */
  teamworkSettleReview: z.object({ id: Id, how: z.enum(['seen', 'closed']) }),
  /** Asks one teammate on the roster to review one of this machine's tasks; it rides presence to them. */
  teamworkRequestReview: z.object({ worktreeId: Id, to: z.string().trim().min(1).max(160) }),
  /** Reviews asked of this machine in one project, and the ones it asked. */
  teamworkReviewRequests: z.object({ projectId: Id }),
  /** `seen` retires an incoming request's popup; `opened` also moves it to Reviewing; `later` drops it here. */
  teamworkSettleReviewRequest: z.object({ projectId: Id, id: Id, how: z.enum(['seen', 'later', 'opened']) }),
  /** PEER-ONLY. One of this machine's tasks as a patch against its base; see `MAX_PEER_PATCH_BYTES`. */
  peerTaskPatch: z.object({ worktreeId: Id }),
  /** PEER-ONLY. A teammate's comments on one of this machine's worktrees; the sender is the link's key. */
  peerReview: z.object({ reviewId: Id, worktreeId: Id, comments: Comments, sentAt: z.number().int().nonnegative() })
} as const

type P = typeof ReviewParams

export type ReviewMethodContract = {
  'teamwork.teammateDiff': { params: z.infer<P['teamworkTeammateDiff']>; result: TeammateDiff }
  'teamwork.sendReview': { params: z.infer<P['teamworkSendReview']>; result: { delivered: true } }
  'teamwork.reviews': { params: z.infer<P['teamworkReviews']>; result: ReceivedReview[] }
  'teamwork.settleReview': { params: z.infer<P['teamworkSettleReview']>; result: { settled: boolean } }
  'teamwork.requestReview': { params: z.infer<P['teamworkRequestReview']>; result: PeerReviewRequest }
  'teamwork.reviewRequests': { params: z.infer<P['teamworkReviewRequests']>; result: TeamworkReviewRequests }
  'teamwork.settleReviewRequest': {
    params: z.infer<P['teamworkSettleReviewRequest']>
    result: { settled: boolean }
  }
  'peer.taskPatch': { params: z.infer<P['peerTaskPatch']>; result: PeerTaskPatch }
  'peer.review': { params: z.infer<P['peerReview']>; result: { received: true } }
}
