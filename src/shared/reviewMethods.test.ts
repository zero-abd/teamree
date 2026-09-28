import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PeerTaskPatchSchema, ReviewParams } from './reviewMethods'
import { MAX_PEER_PATCH_BYTES, MAX_REVIEW_COMMENTS, MAX_REVIEW_LINES, type ReviewNote } from './teammateReview'

const note = (over: Partial<ReviewNote> = {}): ReviewNote => ({
  path: 'footer.txt',
  lines: [{ kind: 'added', text: 'new', oldNumber: null, newNumber: 1 }],
  note: 'Say the brand name',
  ...over
})

const review = (comments: ReviewNote[]) => ({ reviewId: 'r', worktreeId: 'w', comments, sentAt: 1 })

describe('what a review may carry', () => {
  it('takes comments within their bounds, and nothing past them', () => {
    expect(ReviewParams.peerReview.safeParse(review([note()])).success).toBe(true)
    expect(ReviewParams.peerReview.safeParse(review([])).success).toBe(false)
    expect(ReviewParams.peerReview.safeParse(review([note({ note: '  ' })])).success).toBe(false)
    const tooMany = Array.from({ length: MAX_REVIEW_COMMENTS + 1 }, () => note())
    expect(ReviewParams.peerReview.safeParse(review(tooMany)).success).toBe(false)
    const long = Array.from({ length: MAX_REVIEW_LINES + 1 }, () => note().lines[0]!)
    expect(ReviewParams.peerReview.safeParse(review([note({ lines: long })])).success).toBe(false)
  })

  it('refuses a teammate’s patch over the cap, counted in bytes', () => {
    const at = (patch: string) => PeerTaskPatchSchema.safeParse({ branch: 'b', patch, truncated: false }).success
    expect(at('x'.repeat(MAX_PEER_PATCH_BYTES))).toBe(true)
    expect(at('é'.repeat(MAX_PEER_PATCH_BYTES / 2 + 1))).toBe(false)
  })
})

describe('the module the window imports', () => {
  it('loads no zod', () => {
    expect(readFileSync(new URL('./teammateReview.ts', import.meta.url), 'utf8')).not.toMatch(/from 'zod'/)
  })
})
