import { describe, expect, it } from 'vitest'
import type { Project, Terminal, Worktree } from '@shared/entities'
import { activityCounts, dashboardRows, type DashboardRow } from './dashboardRows'

const projects: Project[] = [
  { id: 'p1', name: 'atlas', path: '/repos/atlas', baseRef: 'origin/main' },
  { id: 'p2', name: 'ledger', path: '/repos/ledger', baseRef: 'origin/trunk' }
]

function worktree(overrides: Partial<Worktree> & { id: string }): Worktree {
  return {
    projectId: 'p1',
    name: overrides.id,
    branch: `task/${overrides.id}`,
    path: `/checkouts/${overrides.id}`,
    startedFrom: 'origin/main',
    state: 'ready',
    createdAt: 0,
    ...overrides
  }
}

function terminal(overrides: Partial<Terminal> & { id: string }): Terminal {
  return {
    worktreeId: 'wt1',
    title: 'bash',
    cwd: '/checkouts/wt1',
    shell: '/bin/bash',
    cols: 80,
    rows: 24,
    running: true,
    busy: false,
    lastOutputAt: 0,
    ...overrides
  }
}

/** `now` well past every `lastOutputAt`, so silences are whatever a case sets. */
const NOW = 10 * 60_000

const build = (terminals: Terminal[], worktrees: Worktree[], now = NOW): DashboardRow[] =>
  dashboardRows({ terminals, worktrees, projects, now })

describe('dashboardRows', () => {
  it('flattens every pane in every worktree into one list', () => {
    const rows = build(
      [
        terminal({ id: 'a', worktreeId: 'wt1' }),
        terminal({ id: 'b', worktreeId: 'wt2' }),
        terminal({ id: 'c', worktreeId: 'wt2' })
      ],
      [worktree({ id: 'wt1' }), worktree({ id: 'wt2', projectId: 'p2' })]
    )

    expect(rows.map((row) => row.terminalId).sort()).toEqual(['a', 'b', 'c'])
  })

  it('says which worktree and project a pane belongs to', () => {
    const [row] = build(
      [terminal({ id: 'a', worktreeId: 'wt2' })],
      [worktree({ id: 'wt2', name: 'schema migration', branch: 'task/schema', projectId: 'p2' })]
    )

    expect(row).toMatchObject({ worktreeName: 'schema migration', branch: 'task/schema', projectName: 'ledger' })
  })

  // Ordered by what would make somebody look. A failure is finished and wrong;
  // work in progress is merely unfinished; a finished pane asks for nothing.
  it('ranks failures above work in progress, work above waiting, waiting above finished', () => {
    const rows = build(
      [
        terminal({ id: 'done', running: false, exitCode: 0 }),
        terminal({ id: 'quiet' }),
        terminal({ id: 'working', busy: true }),
        terminal({ id: 'failed', running: false, exitCode: 1 })
      ],
      [worktree({ id: 'wt1' })]
    )

    expect(rows.map((row) => row.terminalId)).toEqual(['failed', 'working', 'quiet', 'done'])
  })

  // The pane that has been sitting there is the one being neglected.
  it('puts the longest silence first inside a state', () => {
    const rows = build(
      [
        terminal({ id: 'recent', lastOutputAt: NOW - 30_000 }),
        terminal({ id: 'ancient', lastOutputAt: NOW - 600_000 }),
        terminal({ id: 'middling', lastOutputAt: NOW - 120_000 })
      ],
      [worktree({ id: 'wt1' })]
    )

    expect(rows.map((row) => row.terminalId)).toEqual(['ancient', 'middling', 'recent'])
  })

  // A list whose order depends on the clock would reshuffle under the pointer
  // every time the silences tick level with each other.
  it('breaks a tie the same way every time, whatever order the panes arrive in', () => {
    const panes = [
      terminal({ id: 't1', worktreeId: 'wt2', title: 'zsh' }),
      terminal({ id: 't2', worktreeId: 'wt1', title: 'npm test' })
    ]
    const trees = [worktree({ id: 'wt1', name: 'alpha' }), worktree({ id: 'wt2', name: 'beta' })]

    const forwards = build(panes, trees).map((row) => row.terminalId)
    const backwards = build([...panes].reverse(), [...trees].reverse()).map((row) => row.terminalId)

    expect(forwards).toEqual(['t2', 't1'])
    expect(backwards).toEqual(forwards)
  })

  // A row whose whole purpose is to say where to look is worse than no row
  // when the worktree it named has already gone.
  it('drops a pane whose worktree the runtime no longer lists', () => {
    const rows = build([terminal({ id: 'orphan', worktreeId: 'gone' })], [worktree({ id: 'wt1' })])
    expect(rows).toEqual([])
  })

  it('names the pane by its agent, and a plain shell by its title', () => {
    const rows = build(
      [terminal({ id: 'a', agent: 'claude', title: 'node' }), terminal({ id: 'b', title: 'npm test' })],
      [worktree({ id: 'wt1' })]
    )

    expect(rows.map((row) => row.label).sort()).toEqual(['claude', 'npm test'])
    expect(rows.find((row) => row.terminalId === 'b')?.agent).toBeUndefined()
  })
})

describe('activityCounts', () => {
  it('counts the panes in each state', () => {
    const rows = build(
      [
        terminal({ id: 'a' }),
        terminal({ id: 'b' }),
        terminal({ id: 'c', busy: true }),
        terminal({ id: 'd', running: false, exitCode: 2 })
      ],
      [worktree({ id: 'wt1' })]
    )

    expect(activityCounts(rows)).toEqual({ failed: 1, working: 1, quiet: 2, done: 0 })
  })

  // Every state present, so the row of counts keeps its shape as panes move
  // between them rather than reflowing under the reader.
  it('reports a zero for a state nothing is in, including with no panes at all', () => {
    expect(activityCounts([])).toEqual({ failed: 0, working: 0, quiet: 0, done: 0 })
  })
})
