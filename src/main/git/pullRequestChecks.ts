// A pull request's checks and review as `gh pr view --json` reports them, and the tail of a failed
// check's log as `gh run view --log-failed` prints it.

import type { PullRequestCheck, PullRequestChecks, WorktreeLanding } from '../../shared/entities'

export const EXCERPT_LINES = 40
export const EXCERPT_CHARS = 3000
const LISTED_CHECKS = 50

type Review = NonNullable<NonNullable<WorktreeLanding['pullRequest']>['review']>

const REVIEWS: Record<string, Review> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes',
  REVIEW_REQUIRED: 'required'
}

/** `reviewDecision`; undefined for the empty string a repository without required reviews reports. */
export function readReview(decision: unknown): Review | undefined {
  return typeof decision === 'string' ? REVIEWS[decision] : undefined
}

const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'])
const ORDER: Record<PullRequestCheck['state'], number> = { fail: 0, pending: 1, pass: 2 }

/** `statusCheckRollup`: check runs and commit statuses alike, the later of two with one name kept. */
export function readChecks(rollup: unknown): PullRequestChecks | undefined {
  if (!Array.isArray(rollup)) return undefined
  const byName = new Map<string, PullRequestCheck>()
  for (const entry of rollup) {
    const check = readCheck(entry)
    if (check === undefined) continue
    byName.delete(check.name)
    byName.set(check.name, check)
  }
  if (byName.size === 0) return undefined
  const all = [...byName.values()]
  const count = (state: PullRequestCheck['state']): number => all.filter((check) => check.state === state).length
  return {
    passing: count('pass'),
    failing: count('fail'),
    pending: count('pending'),
    list: all.sort((a, b) => ORDER[a.state] - ORDER[b.state]).slice(0, LISTED_CHECKS)
  }
}

function readCheck(entry: unknown): PullRequestCheck | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const value = entry as Record<string, unknown>
  const text = (key: string): string => (typeof value[key] === 'string' ? (value[key] as string) : '')
  const run = value.__typename !== 'StatusContext'
  const name = run ? text('name') : text('context')
  if (name === '') return undefined
  const url = run ? text('detailsUrl') : text('targetUrl')
  let state: PullRequestCheck['state']
  if (run) {
    const conclusion = text('conclusion')
    state = text('status') !== 'COMPLETED' ? 'pending' : FAILED.has(conclusion) ? 'fail' : 'pass'
    if (state === 'pass' && !PASSED.has(conclusion)) state = 'pending'
  } else {
    const status = text('state')
    state = status === 'SUCCESS' ? 'pass' : FAILED.has(status) ? 'fail' : 'pending'
  }
  return { name, state, ...(url === '' ? {} : { url }) }
}

/** The `gh` arguments for a check's failed log: its job when the link names one, else its run; null off Actions. */
export function failureLogArgs(url: string | undefined): string[] | null {
  const found = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(url ?? '')
  if (found === null) return null
  const [, run = '', job] = found
  return job === undefined ? ['run', 'view', run, '--log-failed'] : ['run', 'view', '--job', job, '--log-failed']
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
const TIMESTAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z ?/

/** The last lines of `--log-failed` output for the job named `name` (every job when none is), capped. */
export function failureExcerpt(log: string, name: string): string {
  const rows = log
    .replace(ANSI, '')
    .split('\n')
    .map((line) => {
      const [job = '', , ...text] = line.split('\t')
      return text.length === 0 ? { job: '', text: line } : { job, text: text.join('\t').replace(TIMESTAMP, '') }
    })
    .map((row) => ({ ...row, text: row.text.replace(/^﻿/, '').trimEnd() }))
    .filter((row) => row.text !== '' && !/^##\[(end)?group\]/.test(row.text))
  const named = rows.filter((row) => row.job === name)
  let lines = (named.length > 0 ? named : rows).map((row) => row.text.replace(/^##\[error\]/, 'error: '))
  let cut = lines.length > EXCERPT_LINES
  lines = lines.slice(-EXCERPT_LINES)
  while (lines.length > 1 && lines.join('\n').length > EXCERPT_CHARS) {
    lines = lines.slice(1)
    cut = true
  }
  const kept = lines.join('\n').slice(-EXCERPT_CHARS)
  return cut ? `…\n${kept}` : kept
}
