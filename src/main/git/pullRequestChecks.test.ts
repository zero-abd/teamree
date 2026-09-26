import { describe, expect, it } from 'vitest'
import { EXCERPT_CHARS, EXCERPT_LINES, failureExcerpt, failureLogArgs } from './pullRequestChecks'
import { parsePullRequest } from './worktreeLanding'

const URL = 'https://github.com/acme/api/pull/42'

const view = (fields: Record<string, unknown>): string => JSON.stringify({ number: 42, url: URL, ...fields })

const run = (name: string, status: string, conclusion: string, id = 1): Record<string, unknown> => ({
  __typename: 'CheckRun',
  name,
  workflowName: 'CI',
  status,
  conclusion,
  detailsUrl: `https://github.com/acme/api/actions/runs/${id}/job/${id + 100}`
})

describe('parsePullRequest', () => {
  it('reads open, draft, merged and closed', () => {
    expect(parsePullRequest(view({ state: 'OPEN', isDraft: false }))).toEqual({ number: 42, url: URL, state: 'open' })
    expect(parsePullRequest(view({ state: 'OPEN', isDraft: true }))).toMatchObject({ state: 'open', draft: true })
    expect(parsePullRequest(view({ state: 'MERGED' }))).toMatchObject({ state: 'merged' })
    expect(parsePullRequest(view({ state: 'CLOSED' }))).toMatchObject({ state: 'closed' })
    expect(parsePullRequest(view({ state: 'LOCKED' }))).toBeUndefined()
    expect(parsePullRequest('not json')).toBeUndefined()
  })

  it('reads each review decision, and none when the repository asks for none', () => {
    expect(parsePullRequest(view({ state: 'OPEN', reviewDecision: 'APPROVED' }))?.review).toBe('approved')
    expect(parsePullRequest(view({ state: 'OPEN', reviewDecision: 'CHANGES_REQUESTED' }))?.review).toBe('changes')
    expect(parsePullRequest(view({ state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED' }))?.review).toBe('required')
    expect(parsePullRequest(view({ state: 'OPEN', reviewDecision: '' }))).not.toHaveProperty('review')
  })

  it('counts check runs and status contexts, failing first', () => {
    const pull = parsePullRequest(
      view({
        state: 'OPEN',
        statusCheckRollup: [
          run('lint', 'COMPLETED', 'SUCCESS', 1),
          run('test', 'COMPLETED', 'FAILURE', 2),
          run('e2e', 'IN_PROGRESS', '', 3),
          run('docs', 'COMPLETED', 'SKIPPED', 4),
          run('slow', 'COMPLETED', 'TIMED_OUT', 5),
          { __typename: 'StatusContext', context: 'ci/circle', state: 'PENDING', targetUrl: 'https://circle/1' },
          { __typename: 'StatusContext', context: 'vercel', state: 'ERROR', targetUrl: 'https://vercel/1' },
          { __typename: 'StatusContext', context: 'codecov', state: 'SUCCESS' }
        ]
      })
    )

    expect(pull?.checks).toMatchObject({ passing: 3, failing: 3, pending: 2 })
    expect(pull?.checks?.list.map((check) => `${check.state} ${check.name}`)).toEqual([
      'fail test',
      'fail slow',
      'fail vercel',
      'pending e2e',
      'pending ci/circle',
      'pass lint',
      'pass docs',
      'pass codecov'
    ])
    expect(pull?.checks?.list[0]).toEqual({
      name: 'test',
      state: 'fail',
      url: 'https://github.com/acme/api/actions/runs/2/job/102'
    })
  })

  it('keeps only the latest run of a check that ran twice', () => {
    const pull = parsePullRequest(
      view({ state: 'OPEN', statusCheckRollup: [run('test', 'COMPLETED', 'FAILURE', 1), run('test', 'QUEUED', '', 2)] })
    )
    expect(pull?.checks).toMatchObject({ passing: 0, failing: 0, pending: 1 })
  })

  it('says nothing about checks when there are none', () => {
    expect(parsePullRequest(view({ state: 'OPEN', statusCheckRollup: [] }))).not.toHaveProperty('checks')
    expect(parsePullRequest(view({ state: 'OPEN', statusCheckRollup: 'nonsense' }))).not.toHaveProperty('checks')
  })
})

describe('failureLogArgs', () => {
  it('reads one job when the check names it, else the whole run, else nothing', () => {
    expect(failureLogArgs('https://github.com/acme/api/actions/runs/9/job/77')).toEqual([
      'run',
      'view',
      '--job',
      '77',
      '--log-failed'
    ])
    expect(failureLogArgs('https://github.com/acme/api/actions/runs/9')).toEqual(['run', 'view', '9', '--log-failed'])
    expect(failureLogArgs('https://ci.example.com/build/9')).toBeNull()
    expect(failureLogArgs(undefined)).toBeNull()
  })
})

describe('failureExcerpt', () => {
  const line = (job: string, text: string): string => `${job}\tRun npm test\t2026-09-26T18:00:00.1234567Z ${text}`

  it('keeps the named job’s lines, without the job, step and timestamp columns or colour codes', () => {
    const log = [
      line('lint', 'lint is fine'),
      line('test', '\x1b[31mFAIL\x1b[0m src/sum.test.ts'),
      line('test', '##[group]Details'),
      line('test', '##[error]Process completed with exit code 1.')
    ].join('\n')

    expect(failureExcerpt(log, 'test')).toBe('FAIL src/sum.test.ts\nerror: Process completed with exit code 1.')
  })

  it('keeps every job’s lines when none is named after the check', () => {
    expect(failureExcerpt([line('build (ubuntu)', 'one'), line('build (macos)', 'two')].join('\n'), 'build')).toBe(
      'one\ntwo'
    )
  })

  it('keeps the last lines, where the failure is', () => {
    const log = Array.from({ length: EXCERPT_LINES + 30 }, (_, index) => line('test', `line ${index}`)).join('\n')
    const excerpt = failureExcerpt(log, 'test').split('\n')

    expect(excerpt[0]).toBe('…')
    expect(excerpt).toHaveLength(EXCERPT_LINES + 1)
    expect(excerpt.at(-1)).toBe(`line ${EXCERPT_LINES + 29}`)
  })

  it('caps the characters too, cutting at a line', () => {
    const log = Array.from({ length: 20 }, (_, index) => line('test', `${index} ${'x'.repeat(400)}`)).join('\n')
    const excerpt = failureExcerpt(log, 'test')

    expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_CHARS + 2)
    expect(excerpt.startsWith('…\n')).toBe(true)
    expect(
      excerpt
        .split('\n')
        .slice(1)
        .every((kept) => /^\d+ x+$/.test(kept))
    ).toBe(true)
    expect(excerpt.endsWith(`19 ${'x'.repeat(400)}`)).toBe(true)
  })

  it('is empty for an empty log', () => {
    expect(failureExcerpt('', 'test')).toBe('')
  })
})
