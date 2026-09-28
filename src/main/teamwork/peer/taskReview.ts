// Reviewing a teammate's task: their pushed branch read here, and the comments teammates sent
// this machine, kept in `<userData>/reviews.json` so a review outlives a restart.

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ReviewNoteSchema } from '../../../shared/reviewMethods'
import type { ReceivedReview } from '../../../shared/teammateReview'
import type { GitRunner } from '../../git/gitProcess'
import { assertRefShape } from '../../git/repository'
import { cutToBytes } from '../../git/worktreeChanges'
import { readJsonFile, writeJsonFileAtomically } from '../../store/atomicJsonFile'

export const REVIEWS_FILE = 'reviews.json'

/** Reviews kept per project; the oldest seen one makes room. */
export const MAX_HELD_REVIEWS = 50

/** Unseen reviews one teammate may have waiting here. */
export const MAX_UNSEEN_REVIEWS_PER_SENDER = 20

/** The most of a pushed branch's diff read here. */
export const MAX_BRANCH_PATCH_BYTES = 8 * 1024 * 1024

/** What the app announces of a review that arrived. */
export type TaskReviewNotice = { handle: string; task: string; comments: number }

export type ArrivingReview = Omit<ReceivedReview, 'id' | 'receivedAt' | 'seen'>

const ReviewSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  worktreeId: z.string().min(1),
  handle: z.string(),
  publicKey: z.string().min(1),
  comments: z.array(ReviewNoteSchema),
  sentAt: z.number(),
  receivedAt: z.number(),
  seen: z.boolean()
})

const FileSchema = z.object({ reviews: z.array(ReviewSchema).catch([]) })

export class ReviewInbox {
  #reviews: ReceivedReview[] = []
  #writing: Promise<void> = Promise.resolve()
  readonly #path: string | undefined
  readonly #now: () => number
  readonly #onError: (error: unknown) => void

  constructor(options: { path?: string; now: () => number; onError?: (error: unknown) => void }) {
    this.#path = options.path
    this.#now = options.now
    this.#onError = options.onError ?? (() => {})
  }

  /** Reads the file; a missing or damaged one starts empty. */
  async load(): Promise<void> {
    if (this.#path === undefined) return
    const parsed = FileSchema.safeParse(await readJsonFile(this.#path))
    if (parsed.success) this.#reviews = parsed.data.reviews
  }

  /** Files a review. Throws when its sender already has too many waiting, or nothing seen can make room. */
  add(arriving: ArrivingReview): ReceivedReview {
    const unseen = this.#reviews.filter((held) => !held.seen && held.publicKey === arriving.publicKey)
    if (unseen.length >= MAX_UNSEEN_REVIEWS_PER_SENDER) throw new Error('too many unread reviews from this teammate')
    const mine = this.#reviews.filter((held) => held.projectId === arriving.projectId)
    if (mine.length >= MAX_HELD_REVIEWS) {
      const drop = mine.find((held) => held.seen)
      if (drop === undefined) throw new Error('too many unread reviews on this project')
      this.#reviews = this.#reviews.filter((held) => held !== drop)
    }
    const review: ReceivedReview = { ...arriving, id: randomUUID(), receivedAt: this.#now(), seen: false }
    this.#reviews.push(review)
    this.#save()
    return review
  }

  list(projectId?: string): ReceivedReview[] {
    return this.#reviews.filter((held) => projectId === undefined || held.projectId === projectId)
  }

  settle(id: string, how: 'seen' | 'closed'): boolean {
    const held = this.#reviews.find((review) => review.id === id)
    if (held === undefined) return false
    if (how === 'closed') this.#reviews = this.#reviews.filter((review) => review !== held)
    else held.seen = true
    this.#save()
    return true
  }

  /** Resolves once every change so far is on disk. */
  flush(): Promise<void> {
    return this.#writing
  }

  #save(): void {
    const path = this.#path
    if (path === undefined) return
    const snapshot = { reviews: this.#reviews }
    this.#writing = this.#writing
      .then(() => writeJsonFileAtomically(path, snapshot))
      .catch((error: unknown) => this.#onError(error))
  }
}

/**
 * A teammate's branch as `origin` has it, against the project's base; undefined when the fetch fails,
 * which is what a branch never pushed does. `commits` counts what the pushed branch has past its base.
 */
export async function readPushedBranch(
  runner: GitRunner,
  input: { projectPath: string; branch: string; baseRef: string }
): Promise<{ patch: string; truncated: boolean; commits: number } | undefined> {
  // The name came from a teammate's presence: a ref shaped like a flag must never reach git's argv.
  assertRefShape(input.branch, 'branch')
  assertRefShape(input.baseRef, 'base')
  const base = input.baseRef.startsWith('origin/') ? input.baseRef.slice('origin/'.length) : undefined
  const refspecs = [input.branch, ...(base === undefined ? [] : [base])].map(
    (name) => `+refs/heads/${name}:refs/remotes/origin/${name}`
  )
  const fetched = await runner.tryRun({
    args: ['fetch', '--no-tags', 'origin', ...refspecs],
    cwd: input.projectPath,
    timeoutMs: 120_000
  })
  if (fetched.exitCode !== 0) return undefined
  const range = `${input.baseRef}...refs/remotes/origin/${input.branch}`
  const [diff, count] = await Promise.all([
    runner.tryRun({
      args: ['diff', '--no-color', range],
      cwd: input.projectPath,
      readOnly: true,
      stdoutLimitBytes: MAX_BRANCH_PATCH_BYTES + 1,
      timeoutMs: 60_000
    }),
    runner.tryRun({
      args: ['rev-list', '--count', `${input.baseRef}..refs/remotes/origin/${input.branch}`],
      cwd: input.projectPath,
      readOnly: true,
      timeoutMs: 30_000
    })
  ])
  if (diff.exitCode !== 0 && diff.stdoutClipped !== true) return undefined
  return {
    patch: cutToBytes(diff.stdout, MAX_BRANCH_PATCH_BYTES),
    truncated: diff.stdoutClipped === true || Buffer.byteLength(diff.stdout, 'utf8') > MAX_BRANCH_PATCH_BYTES,
    commits: Number.parseInt(count.stdout.trim(), 10) || 0
  }
}
