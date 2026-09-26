import { describe, expect, it } from 'vitest'
import type { PullRequestCheck, WorktreeLanding } from '@shared/entities'
import { checksWords, pullRequestChip, reviewWord } from './pullRequestChip'

type Pull = NonNullable<WorktreeLanding['pullRequest']>

const pull = (overrides: Partial<Pull> = {}): Pull => ({
  number: 42,
  url: 'https://github.com/acme/api/pull/42',
  state: 'open',
  ...overrides
})

const checks = (...states: PullRequestCheck['state'][]): Pull['checks'] => ({
  passing: states.filter((state) => state === 'pass').length,
  failing: states.filter((state) => state === 'fail').length,
  pending: states.filter((state) => state === 'pending').length,
  list: states.map((state, index) => ({ name: `${state}-${index}`, state }))
})

describe('pullRequestChip', () => {
  it('is nothing without a pull request', () => {
    expect(pullRequestChip(undefined)).toBeNull()
  })

  it('marks passing, failing and pending checks, failing first', () => {
    expect(pullRequestChip(pull({ checks: checks('pass', 'pass') }))).toMatchObject({ text: 'PR #42 ✓', tone: 'pass' })
    expect(pullRequestChip(pull({ checks: checks('pass', 'fail', 'fail', 'pending') }))).toMatchObject({
      text: 'PR #42 ✗ 2',
      tone: 'fail'
    })
    expect(pullRequestChip(pull({ checks: checks('pass', 'pending') }))).toMatchObject({
      text: 'PR #42 ○ 1',
      tone: 'pending'
    })
    expect(pullRequestChip(pull())).toMatchObject({ text: 'PR #42', tone: 'none' })
  })

  it('says draft, merged and closed, and colours none but an open one’s checks', () => {
    expect(pullRequestChip(pull({ draft: true, checks: checks('fail') }))).toMatchObject({
      text: 'PR #42 draft ✗ 1',
      tone: 'fail'
    })
    expect(pullRequestChip(pull({ state: 'merged', checks: checks('fail') }))).toMatchObject({
      text: 'PR #42 merged',
      tone: 'none'
    })
    expect(pullRequestChip(pull({ state: 'closed' }))).toMatchObject({ text: 'PR #42 closed', tone: 'none' })
  })

  it('names the failing checks and the review in its title', () => {
    const chip = pullRequestChip(
      pull({
        review: 'changes',
        checks: {
          passing: 1,
          failing: 2,
          pending: 0,
          list: [
            { name: 'test', state: 'fail' },
            { name: 'e2e', state: 'fail' },
            { name: 'lint', state: 'pass' }
          ]
        }
      })
    )
    expect(chip?.title).toBe('Pull Request #42 · open · changes requested\n2 failing: test, e2e\n1 passing')
  })
})

describe('words', () => {
  it('names each review decision', () => {
    expect(reviewWord('approved')).toBe('Approved')
    expect(reviewWord('changes')).toBe('Changes requested')
    expect(reviewWord('required')).toBe('Review required')
    expect(reviewWord(undefined)).toBeUndefined()
  })

  it('says the worst of the checks', () => {
    expect(checksWords(checks('pass', 'fail', 'pending'))).toBe('✗ 1 failing')
    expect(checksWords(checks('pass', 'pending', 'pending'))).toBe('○ 2 pending')
    expect(checksWords(checks('pass', 'pass'))).toBe('✓ 2 passing')
    expect(checksWords(undefined)).toBeUndefined()
  })
})
