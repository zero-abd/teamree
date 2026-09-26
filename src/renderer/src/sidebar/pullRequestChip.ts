// A worktree's pull request as one chip: its number, its state when not plainly open, and the worst of its checks.

import type { PullRequestChecks, WorktreeLanding } from '@shared/entities'

type Pull = NonNullable<WorktreeLanding['pullRequest']>

export type PullRequestTone = 'pass' | 'fail' | 'pending' | 'none'

export type PullRequestChip = { text: string; tone: PullRequestTone; title: string }

const REVIEW_WORD = { approved: 'Approved', changes: 'Changes requested', required: 'Review required' } as const

export function reviewWord(review: Pull['review']): string | undefined {
  return review === undefined ? undefined : REVIEW_WORD[review]
}

/** `✗ 1 failing`, else `○ 2 pending`, else `✓ 3 passing`. */
export function checksWords(checks: PullRequestChecks | undefined): string | undefined {
  if (checks === undefined) return undefined
  if (checks.failing > 0) return `✗ ${checks.failing} failing`
  if (checks.pending > 0) return `○ ${checks.pending} pending`
  return `✓ ${checks.passing} passing`
}

export function checksTone(checks: PullRequestChecks | undefined): PullRequestTone {
  if (checks === undefined) return 'none'
  if (checks.failing > 0) return 'fail'
  if (checks.pending > 0) return 'pending'
  return checks.passing > 0 ? 'pass' : 'none'
}

export function pullRequestChip(pull: Pull | undefined): PullRequestChip | null {
  if (pull === undefined) return null
  const open = pull.state === 'open'
  const checks = open ? pull.checks : undefined
  const tone = checksTone(checks)
  const mark =
    tone === 'fail'
      ? `✗ ${checks?.failing}`
      : tone === 'pending'
        ? `○ ${checks?.pending}`
        : tone === 'pass'
          ? '✓'
          : undefined
  const state = !open ? pull.state : pull.draft === true ? 'draft' : undefined
  const text = [`PR #${pull.number}`, state, mark].filter(Boolean).join(' ')
  const review = open ? reviewWord(pull.review)?.toLowerCase() : undefined
  const head = [`Pull Request #${pull.number}`, pull.draft === true && open ? 'draft' : pull.state, review]
  const failing = checks?.list.filter((check) => check.state === 'fail').map((check) => check.name) ?? []
  const lines = [
    head.filter(Boolean).join(' · '),
    failing.length > 0 ? `${checks?.failing} failing: ${failing.join(', ')}` : '',
    checks !== undefined && checks.pending > 0 ? `${checks.pending} pending` : '',
    checks !== undefined && checks.passing > 0 ? `${checks.passing} passing` : ''
  ]
  return { text, tone, title: lines.filter(Boolean).join('\n') }
}
