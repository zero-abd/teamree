import { describe, expect, it } from 'vitest'
import { MAX_AGENT_ARGS_CHARS } from '@shared/agentLaunch'
import type { IssueEntry } from '@shared/entities'
import { filterIssues, issueBranch, issueTask, MAX_ISSUE_TASK_CHARS } from './issueModel'
import { branchProblem, taskCreates } from './taskPlan'

const issue = (number: number, title: string, overrides: Partial<IssueEntry> = {}): IssueEntry => ({
  number,
  title,
  url: `https://github.com/acme/pager/issues/${number}`,
  labels: [],
  body: '',
  updatedAt: null,
  ...overrides
})

describe('issueTask', () => {
  it('is the number and title, then the body', () => {
    expect(issueTask(issue(123, 'Login redirect loops', { body: 'Steps:\n1. Sign in' }))).toBe(
      '#123 Login redirect loops\n\nSteps:\n1. Sign in'
    )
  })

  it('is the title alone for an empty body', () => {
    expect(issueTask(issue(7, ' Dark mode ', { body: '  \n ' }))).toBe('#7 Dark mode')
  })

  it('drops template comments and runs of blank lines', () => {
    const body = '<!-- Describe the bug -->\nIt loops.\n\n\n\n<!--\nsteps\n-->\nAlways.  '
    expect(issueTask(issue(1, 'Loop', { body }))).toBe('#1 Loop\n\nIt loops.\n\nAlways.')
  })

  it('caps a long body, marking the cut, within what an agent can be handed', () => {
    const task = issueTask(issue(9, 'Big', { body: 'word '.repeat(5000) }))
    expect(task.length).toBeLessThanOrEqual(MAX_ISSUE_TASK_CHARS)
    expect(MAX_ISSUE_TASK_CHARS).toBeLessThanOrEqual(MAX_AGENT_ARGS_CHARS)
    expect(task.startsWith('#9 Big\n\nword word')).toBe(true)
    expect(task.endsWith('…')).toBe(true)
  })
})

describe('issueBranch', () => {
  it('is the number and a slug of the title', () => {
    expect(issueBranch(issue(123, 'Fix: login redirect loops!'))).toBe('123-fix-login-redirect-loops')
  })

  it('follows the branch rules: bounded and one the composer accepts', () => {
    const branch = issueBranch(issue(4567, 'A very long title about '.repeat(6)))
    expect(branch.startsWith('4567-a-very-long-title')).toBe(true)
    expect(branch.length).toBeLessThanOrEqual(60)
    expect(branchProblem(taskCreates('x', [], branch), [])).toBeNull()
  })
})

describe('filterIssues', () => {
  const issues = [
    issue(123, 'Login redirect loops', { labels: ['bug', 'auth'] }),
    issue(12, 'Dark mode', { labels: ['design'] }),
    issue(40, 'Pager drops lines')
  ]
  const numbers = (query: string): number[] => filterIssues(issues, query).map((entry) => entry.number)

  it('keeps every issue for an empty query', () => {
    expect(numbers('  ')).toEqual([123, 12, 40])
  })

  it('matches the title, a label, or the number with or without its #', () => {
    expect(numbers('login')).toEqual([123])
    expect(numbers('design')).toEqual([12])
    expect(numbers('#12')).toEqual([123, 12])
    expect(numbers('40')).toEqual([40])
  })

  it('needs every word', () => {
    expect(numbers('bug dark')).toEqual([])
    expect(numbers('pager lines')).toEqual([40])
  })
})
