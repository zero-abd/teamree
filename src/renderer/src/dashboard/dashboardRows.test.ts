import { describe, expect, it } from 'vitest'
import type { Project, Terminal, Worktree } from '@shared/entities'
import { dashboardRows, toneCounts, type DashboardRow } from './dashboardRows'

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

  // `perf perf`, and the stored "Add a subtract function to claude" twice over.
  it('names the worktree as the sidebar does, the branch only when it says more', () => {
    const task = 'Add a subtract function to src/math.ts'
    const rows = build(
      [
        terminal({ id: 'agent', worktreeId: 'run', agent: 'claude', label: 'Add a subtract function to claude' }),
        terminal({ id: 'shell', worktreeId: 'perf' })
      ],
      [
        worktree({
          id: 'run',
          name: 'Add a subtract function to claude',
          branch: 'add-a-subtract-function-to-claude',
          task
        }),
        worktree({ id: 'perf', name: 'perf', branch: 'perf' })
      ]
    )

    const agent = rows.find((row) => row.terminalId === 'agent')
    expect(agent).toMatchObject({ label: 'Claude Code', worktreeName: `claude · ${task}` })
    expect(agent?.branch).toBeUndefined()
    const shell = rows.find((row) => row.terminalId === 'shell')
    expect(shell).toMatchObject({ label: 'bash', worktreeName: 'perf' })
    expect(shell?.branch).toBeUndefined()
  })

  // Ordered by what would make somebody look. A failure is finished and wrong;
  // a pane that has asked for something cannot move without you; work in
  // progress is merely unfinished; a finished pane asks for nothing.
  it('ranks failures above asking, asking above working, working above stopped, stopped above idle, idle above finished', () => {
    const rows = build(
      [
        terminal({ id: 'done', running: false, exitCode: 0 }),
        terminal({ id: 'idle' }),
        terminal({ id: 'quiet', agent: 'codex' }),
        terminal({ id: 'working', busy: true }),
        terminal({ id: 'waiting', agent: 'claude', lastBellAt: 1_000 }),
        terminal({ id: 'failed', running: false, exitCode: 1 })
      ],
      [worktree({ id: 'wt1' })]
    )

    expect(rows.map((row) => row.terminalId)).toEqual(['failed', 'waiting', 'working', 'quiet', 'idle', 'done'])
  })

  // The case the board exists for: five panes, four of them fine, and the one
  // that rang the bell at the top whatever its silence is next to theirs.
  it('puts the pane that rang the bell above panes that have been quiet far longer', () => {
    const rows = build(
      [
        terminal({ id: 'silent-an-hour', lastOutputAt: NOW - 3_600_000 }),
        terminal({ id: 'silent-ten-minutes', lastOutputAt: NOW - 600_000 }),
        terminal({ id: 'rang-just-now', agent: 'claude', lastOutputAt: NOW - 5_000, lastBellAt: NOW - 5_000 })
      ],
      [worktree({ id: 'wt1' })]
    )

    expect(rows.map((row) => row.terminalId)).toEqual(['rang-just-now', 'silent-an-hour', 'silent-ten-minutes'])
  })

  // The board once listed idle shells 1, 13, 9, 3, 7: longest silence first reshuffles with every tick.
  it('orders a state by worktree as the sidebar lists them, then by tab, whatever the clock says', () => {
    const trees = [worktree({ id: 'wt2', name: 'beta' }), worktree({ id: 'wt1', name: 'alpha' })]
    const panes = [
      terminal({ id: 'a1', worktreeId: 'wt1', lastOutputAt: NOW - 30_000 }),
      terminal({ id: 'a2', worktreeId: 'wt1', lastOutputAt: NOW - 600_000 }),
      terminal({ id: 'a3', worktreeId: 'wt1', lastOutputAt: NOW - 120_000 }),
      terminal({ id: 'b1', worktreeId: 'wt2', lastOutputAt: NOW - 5_000 })
    ]
    const leaf = (terminalId: string) => ({ kind: 'leaf' as const, terminalId })
    const layouts = {
      wt1: {
        root: { kind: 'split' as const, direction: 'row' as const, sizes: [1, 1], children: [leaf('a3'), leaf('a1')] }
      }
    }

    const order = (now: number, arrived = panes): string[] =>
      dashboardRows({ terminals: arrived, worktrees: trees, projects, layouts, now }).map((row) => row.terminalId)

    // a2 is in no layout, so it follows the tabs in the order it was opened.
    expect(order(NOW)).toEqual(['b1', 'a3', 'a1', 'a2'])
    expect(order(NOW + 3_600_000)).toEqual(order(NOW))
    expect(order(NOW, [panes[3]!, ...panes.slice(0, 3)])).toEqual(order(NOW))
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

    expect(rows.map((row) => row.label).sort()).toEqual(['Claude Code', 'npm test'])
    expect(rows.find((row) => row.terminalId === 'b')?.agent).toBeUndefined()
  })
})

describe('dashboardRows, quoting', () => {
  it('carries each pane’s last line, and nothing for a pane with none', () => {
    const rows = dashboardRows({
      terminals: [terminal({ id: 'a' }), terminal({ id: 'b' })],
      worktrees: [worktree({ id: 'wt1' })],
      projects,
      now: NOW,
      evidence: { a: 'Added sub to src/math.ts:9' }
    })
    expect(Object.fromEntries(rows.map((row) => [row.terminalId, row.evidence]))).toEqual({
      a: 'Added sub to src/math.ts:9',
      b: null
    })
  })
})

describe('toneCounts', () => {
  it('counts the panes by the colour of their dot, a quiet agent apart from a quiet shell', () => {
    const rows = build(
      [
        terminal({ id: 'a' }),
        terminal({ id: 'b', agent: 'codex' }),
        terminal({ id: 'c', busy: true }),
        terminal({ id: 'd', running: false, exitCode: 2 })
      ],
      [worktree({ id: 'wt1' })]
    )

    expect(toneCounts(rows)).toEqual({ failed: 1, waiting: 0, working: 1, quiet: 1, idle: 1, done: 0 })
  })

  // Every state present, so the row of counts keeps its shape as panes move
  // between them rather than reflowing under the reader.
  it('reports a zero for a state nothing is in, including with no panes at all', () => {
    expect(toneCounts([])).toEqual({ failed: 0, waiting: 0, working: 0, quiet: 0, idle: 0, done: 0 })
  })
})
