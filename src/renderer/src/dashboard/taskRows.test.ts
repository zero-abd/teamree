import { describe, expect, it } from 'vitest'
import type { Project, Terminal, Worktree, WorktreeStatus } from '@shared/entities'
import { isDoneStage, taskRows, taskStage, type StageFacts, type TaskRowsInput } from './taskRows'

const projects: Project[] = [{ id: 'p1', name: 'api', path: '/repos/api', baseRef: 'origin/main' }]

function worktree(overrides: Partial<Worktree> & { id: string }): Worktree {
  return {
    projectId: 'p1',
    name: overrides.id,
    branch: overrides.id,
    path: `/checkouts/${overrides.id}`,
    startedFrom: 'origin/main',
    state: 'ready',
    createdAt: 0,
    ...overrides
  }
}

function terminal(overrides: Partial<Terminal> & { id: string; worktreeId: string }): Terminal {
  return {
    title: 'claude',
    cwd: '/checkouts',
    shell: '/bin/zsh',
    agent: 'claude',
    cols: 80,
    rows: 24,
    running: true,
    busy: false,
    lastOutputAt: 0,
    ...overrides
  }
}

function status(worktreeId: string, overrides: Partial<WorktreeStatus> = {}): WorktreeStatus {
  return {
    worktreeId,
    branch: worktreeId,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    readAt: 0,
    ...overrides
  }
}

const clean = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }
const facts = (overrides: Partial<StageFacts>): StageFacts => ({
  worktree: { state: 'ready' },
  tone: null,
  status: clean,
  ahead: 0,
  landed: false,
  ...overrides
})

describe('a task’s stage, derived and never set', () => {
  it.each([
    ['working', facts({ tone: 'working' })],
    ['asking', facts({ tone: 'waiting' })],
    ['stopped', facts({ tone: 'quiet' })],
    ['stopped', facts({})],
    ['ready', facts({ tone: 'quiet', ahead: 2 })],
    ['stopped', facts({ tone: 'quiet', ahead: 2, status: { ...clean, unstaged: 1 } })],
    ['done', facts({ tone: 'quiet', worktree: { state: 'ready', report: done('succeeded') } })],
    ['failed', facts({ worktree: { state: 'ready', report: done('failed') } })],
    ['landed', facts({ landed: true, worktree: { state: 'ready', report: done('succeeded') } })],
    ['failed', facts({ tone: 'failed' })],
    ['failed', facts({ worktree: { state: 'failed' } })],
    ['working', facts({ worktree: { state: 'creating' } })]
  ] as const)('is %s', (stage, input) => {
    expect(taskStage(input)).toBe(stage)
  })

  // A live pane outranks what was reported: an agent asked again after `done` is asking.
  it('puts a pane asking or working over a report or a landing', () => {
    const report = { state: 'ready' as const, report: done('succeeded') }
    expect(taskStage(facts({ tone: 'waiting', worktree: report }))).toBe('asking')
    expect(taskStage(facts({ tone: 'working', landed: true }))).toBe('working')
  })

  it('counts done and landed as done', () => {
    expect(['done', 'landed', 'ready'].map((stage) => isDoneStage(stage as never))).toEqual([true, true, false])
  })
})

function done(outcome: 'succeeded' | 'failed') {
  return { outcome, summary: 'Added the limiter.', paths: [], at: 0 }
}

describe('the Tasks board rows', () => {
  const NOW = 3 * 60 * 60_000
  const input = (overrides: Partial<TaskRowsInput> = {}): TaskRowsInput => ({
    projects,
    worktrees: [
      worktree({ id: 'auth', name: 'Rework auth session', createdAt: 0 }),
      worktree({ id: 'limits', name: 'Add rate limits', createdAt: 60_000 }),
      worktree({ id: 'tests', name: 'Update the tests', parentId: 'auth', createdAt: NOW - 5 * 60_000 }),
      worktree({ id: 'migration', name: 'Write the migration', parentId: 'auth' })
    ],
    terminals: [
      terminal({ id: 't1', worktreeId: 'auth', busy: true }),
      terminal({ id: 't2', worktreeId: 'tests', screenSays: 'waiting' }),
      terminal({ id: 't3', worktreeId: 'tests', agent: undefined, title: 'zsh' })
    ],
    statuses: { migration: status('migration') },
    mergePreviews: { migration: { ahead: 3 } },
    landings: {},
    changes: {
      auth: {
        changes: [{ added: 100, removed: 8 }, { added: 20 }]
      }
    },
    now: NOW,
    ...overrides
  })

  it('lists tasks in tree order with their depth', () => {
    const rows = taskRows(input())
    expect(rows.map((row) => [row.title, row.depth])).toEqual([
      ['Rework auth session', 0],
      ['Update the tests', 1],
      ['Write the migration', 1],
      ['Add rate limits', 0]
    ])
  })

  it('gives each its stage, a dot per pane, its changes and its age', () => {
    const [auth, tests, migration] = taskRows(input())
    expect(auth).toMatchObject({ stage: 'working', added: 120, removed: 8, age: NOW })
    expect(tests?.stage).toBe('asking')
    expect(tests?.panes.map((pane) => pane.tone)).toEqual(['waiting', 'idle'])
    expect(tests?.age).toBe(5 * 60_000)
    expect(migration).toMatchObject({ stage: 'ready', ahead: 3, added: null, removed: null })
  })

  it('tallies a parent’s children, done counting landed', () => {
    const [auth, , , limits] = taskRows(input({ landings: { migration: { merged: true } } }))
    expect(auth?.tally).toEqual({ done: 1, total: 2 })
    expect(limits?.tally).toBeUndefined()
  })
})
