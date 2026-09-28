/** @vitest-environment jsdom */

// The board's two keyboard promises, both of which it used to half keep.
//
// The ordering and the counting are `dashboardRows.test.ts`'s business and are
// not repeated here. What is here is the part that only exists once the rows
// are on a screen: Escape leaves, and the keyboard lands somewhere it can act.
// Both were written against a window that had fewer things in it than it has
// now — a modal nobody in this window opened, and a list that is empty for the
// first moments of every launch — and each of them was wrong in the state the
// person is most likely to be in when it matters.

import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsentRequest, PaneConsent, Project, Terminal, Worktree } from '@shared/entities'

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: () => new Promise(() => {}),
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

/** What each pane last printed, as the sidebar's reader would have it. */
const printed: Record<string, string | null> = {}
vi.mock('../sidebar/usePaneEvidence', () => ({ usePaneEvidence: () => printed, useWatchEvidence: () => ({}) }))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { Dashboard } = await import('./Dashboard')
const { useTaskTreeStore } = await import('../state/taskTreeStore')
const { useUsageStore } = await import('../state/usageStore')

const INITIAL = useWorkspaceStore.getState()

const toggleDashboard = vi.fn()

const PROJECT: Project = { id: 'p1', name: 'teamree', path: '/repos/teamree', baseRef: 'origin/main' }

const WORKTREE: Worktree = {
  id: 'w1',
  projectId: 'p1',
  name: 'atlas',
  branch: 'atlas',
  path: '/repos/teamree/.worktrees/atlas',
  startedFrom: 'origin/main',
  state: 'ready',
  createdAt: 0
}

const PANE: Terminal = {
  id: 't1',
  worktreeId: 'w1',
  title: 'zsh',
  cwd: WORKTREE.path,
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy: false,
  lastOutputAt: Date.now()
}

/** A teammate's held keystrokes, waiting on this machine's owner to answer. */
const QUESTION: ConsentRequest = {
  id: 'c1',
  projectId: 'p1',
  terminalId: 't1',
  handle: 'sam',
  publicKey: 'k',
  since: 1,
  at: 2,
  expiresAt: Number.MAX_SAFE_INTEGER,
  writes: 3,
  bytes: 9,
  preview: 'rm -rf .',
  clipped: false
}

const ASKING: PaneConsent = { projectId: 'p1', requests: [QUESTION], standing: [], readAt: 2 }

function seed(over: Partial<ReturnType<typeof useWorkspaceStore.getState>> = {}): void {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      projects: [PROJECT],
      worktrees: [WORKTREE],
      terminals: { [PANE.id]: PANE },
      toggleDashboard,
      ...over
    },
    true
  )
}

beforeEach(() => {
  toggleDashboard.mockReset()
  for (const key of Object.keys(printed)) delete printed[key]
  seed()
})

// Six coloured dots, four of them beside a zero: only the states some pane is in are named.
describe('the legend', () => {
  function seedMixed(): void {
    seed({
      terminals: {
        agent: { ...PANE, id: 'agent', agent: 'codex', title: 'codex' },
        shell: { ...PANE, id: 'shell', title: 'zsh' },
        busy: { ...PANE, id: 'busy', title: 'npm test', busy: true }
      }
    })
  }

  const filters = (): string[] => [...document.querySelectorAll('.board-filter')].map((f) => f.textContent ?? '')

  it('names only the states some pane is in, as text, with no dots', () => {
    seed({
      terminals: {
        a: { ...PANE, id: 'a', agent: 'claude', title: 'claude' },
        b: { ...PANE, id: 'b', agent: 'codex', title: 'codex' },
        c: { ...PANE, id: 'c', title: 'zsh' },
        d: { ...PANE, id: 'd', title: 'zsh' }
      }
    })
    render(<Dashboard />)
    expect(filters()).toEqual(['2 ready', '2 idle'])
    expect(document.querySelectorAll('.activity')).toHaveLength(0)
  })

  it('counts what the rows show, word for word', () => {
    seedMixed()
    render(<Dashboard />)
    const states = [...document.querySelectorAll('.board-row__state')].map((state) => state.textContent ?? '')
    expect(states.sort()).toEqual(['idle', 'ready', 'working'])
    expect(filters()).toEqual(['1 working', '1 ready', '1 idle'])
  })

  it('shows one state’s panes when its count is pressed, and every pane when pressed again', () => {
    seedMixed()
    render(<Dashboard />)
    const ready = screen.getByRole('button', { name: '1 ready' })
    fireEvent.click(ready)
    expect(ready.getAttribute('aria-pressed')).toBe('true')
    expect([...document.querySelectorAll('.board-row__state')].map((state) => state.textContent)).toEqual(['ready'])
    fireEvent.click(ready)
    expect(document.querySelectorAll('.board-row')).toHaveLength(3)
  })
})

describe('a row', () => {
  it('quotes what its pane last printed, and draws no dot', () => {
    printed.agent = 'Added sub to src/math.ts:9, matching the style of add and mul.'
    seed({ terminals: { agent: { ...PANE, id: 'agent', agent: 'claude', title: 'claude' } } })
    render(<Dashboard />)
    const row = document.querySelector('.board-row') as HTMLElement
    expect(row.querySelector('.board-row__evidence')?.textContent).toBe(printed.agent)
    expect(row.querySelector('.activity')).toBeNull()
    expect(row.querySelector('.agent-glyph')).not.toBeNull()
  })

  it('draws the state as a pill in its own tone', () => {
    seed({
      terminals: {
        failed: { ...PANE, id: 'failed', title: 'npm test', running: false, exitCode: 1 },
        quiet: { ...PANE, id: 'quiet', title: 'zsh' }
      }
    })
    render(<Dashboard />)
    const pills = [...document.querySelectorAll('.board-row__state .status-pill')]
    expect(pills.map((pill) => pill.classList.contains('status--failed'))).toEqual([true, false])
    expect(pills.map((pill) => pill.classList.contains('status--ended'))).toEqual([false, true])
  })
})

describe('leaving the board', () => {
  it('sits in the shared page frame, the counts and the filter in its head', () => {
    render(<Dashboard />)
    const main = screen.getByRole('main', { name: 'Every pane' })
    const head = main.querySelector('.page__head') as HTMLElement
    expect(head.querySelector('h1')?.textContent).toBe('All Panes')
    expect(head.contains(screen.getByRole('button', { name: 'Unread Only' }))).toBe(true)
    expect(main.querySelector('.page__body .page__column .board__list')).not.toBeNull()
  })

  it('closes on Escape, which is what a reader tries first', () => {
    render(<Dashboard />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(toggleDashboard).toHaveBeenCalledTimes(1)
  })

  it('stands aside while a dialog this window opened is on top of it', () => {
    seed({ dialog: { kind: 'palette' } })
    render(<Dashboard />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(toggleDashboard).not.toHaveBeenCalled()
  })

  // The case the old check missed entirely. A question about a teammate's
  // keystrokes is not in `dialog` — nobody in this window opened it — and it is
  // the one modal here that refuses to be dismissed, so Escape used to go
  // straight past it and close the board underneath a scrim the owner could
  // neither see through nor get out of without answering.
  it('stands aside for a question about a teammate’s keystrokes, which nobody here opened', () => {
    seed({ consent: { p1: ASKING } })
    render(<Dashboard />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(toggleDashboard).not.toHaveBeenCalled()
  })
})

describe('where the keyboard lands', () => {
  it('puts the focus on the first row, which is both the answer and the way to it', () => {
    render(<Dashboard />)
    const row = screen.getByRole('button', { name: /atlas/ })
    expect(document.activeElement).toBe(row)
  })

  // The board is reachable before the runtime has answered, and the empty state
  // renders no list at all — so a mount-only focus effect focused nothing, and
  // the rows that arrived a moment later could not be reached from the keyboard
  // at all. This is the shape of every launch.
  it('lands on the first row that arrives after the board was already open', () => {
    seed({ worktrees: [], terminals: {} })
    const view = render(<Dashboard />)
    expect(screen.getByText('Nothing running')).toBeTruthy()
    // The heading is the whole of it. "Open a terminal with ⌘T." under it was
    // an instruction where a state belongs, and a sixth place teaching a chord.
    expect(document.querySelector('.placeholder__body')).toBeNull()
    expect(document.querySelector('.placeholder kbd')).toBeNull()
    expect(screen.getByRole('button', { name: 'Back to the panes' }).getAttribute('title')).toBe('Back to the panes')

    useWorkspaceStore.setState({ worktrees: [WORKTREE], terminals: { [PANE.id]: PANE } })
    view.rerender(<Dashboard />)

    expect(document.activeElement).toBe(screen.getByRole('button', { name: /atlas/ }))
  })
})

describe('the arrow keys', () => {
  it('move between the rows', () => {
    seed({
      terminals: { alpha: { ...PANE, id: 'alpha', title: 'alpha' }, beta: { ...PANE, id: 'beta', title: 'beta' } }
    })
    render(<Dashboard />)
    const [alpha, beta] = [...document.querySelectorAll<HTMLElement>('.board-row')]
    expect(document.activeElement).toBe(alpha)
    fireEvent.keyDown(alpha as HTMLElement, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(beta)
    fireEvent.keyDown(beta as HTMLElement, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(beta)
    fireEvent.keyDown(beta as HTMLElement, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(alpha)
  })
})

// The board is where the question "which of these said something while I was
// away" is asked across every worktree at once, so it is the one surface that
// gets a filter rather than only a mark.
describe('the unread filter', () => {
  const printed = (id: string, title: string): Terminal => ({ ...PANE, id, title })

  function seedTwo(): void {
    seed({
      terminals: { alpha: printed('alpha', 'alpha'), beta: printed('beta', 'beta') },
      // Beta was in front of this person after it last printed; alpha has said
      // something since.
      paneSeenAt: { beta: Date.now() + 60_000 }
    })
  }

  it('hides the panes that have already been read', () => {
    seedTwo()
    render(<Dashboard />)
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getByText('beta')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Unread Only' }))

    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.queryByText('beta')).toBeNull()
  })

  it('marks the unread pane by weight, not by a dot', () => {
    seedTwo()
    render(<Dashboard />)
    const alpha = screen.getByText('alpha').closest('.board-row')
    expect(alpha?.classList.contains('board-row--unread')).toBe(true)
    expect(alpha?.querySelectorAll('.activity, .pip')).toHaveLength(0)
  })

  it('goes back to every pane when it is pressed again', () => {
    seedTwo()
    render(<Dashboard />)
    const toggle = screen.getByRole('button', { name: 'Unread Only' })

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByText('beta')).toBeTruthy()
  })
})

// Answering from the board: the asking row carries its menu's answers, a working row none.
describe('answers on the board', () => {
  it('offers an asking pane’s answers beside its row, and nothing on the others', () => {
    seed({
      terminals: {
        asks: {
          ...PANE,
          id: 'asks',
          agent: 'claude',
          screenSays: 'waiting',
          screenMenu: {
            prompt: 'abcd1234',
            choices: [
              { label: 'Trust', keys: ['\u001b[B', '\r'] },
              { label: 'Exit', keys: ['\r'] }
            ]
          }
        },
        busy: { ...PANE, id: 'busy', agent: 'codex', busy: true }
      }
    })
    render(<Dashboard />)
    const groups = screen.getAllByRole('group', { name: 'Answer' })
    expect(groups).toHaveLength(1)
    expect([...groups[0]!.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Trust', 'Exit'])
    expect(groups[0]!.closest('li')?.querySelector('.board-row__state')?.textContent).toBe('asking')
  })

  // The same buttons as the sidebar's asking rows, reached with Tab from the row.
  it('names each answer in a word, and reaches them with Tab from the row', async () => {
    const user = userEvent.setup()
    seed({
      terminals: {
        asks: {
          ...PANE,
          id: 'asks',
          agent: 'claude',
          screenSays: 'waiting',
          screenMenu: {
            prompt: 'p',
            choices: [
              { label: 'Yes', keys: ['\r'] },
              { label: 'Yes, Always', keys: ['2'] },
              { label: 'No…', keys: null }
            ]
          }
        }
      }
    })
    render(<Dashboard />)
    const group = screen.getByRole('group', { name: 'Answer' })
    expect([...group.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Yes', 'Always', 'No…'])
    const row = group.closest('li')?.querySelector<HTMLElement>('.board-row')
    row?.focus()
    await user.tab()
    expect(document.activeElement?.textContent).toBe('Yes')
  })

  it('lists a teammate’s asking pane, whose it is, and answers it through their machine', () => {
    const answerTeammatePane = vi.fn(async () => {})
    const menu = { prompt: '1a2b3c4d', choices: [{ label: 'Yes', keys: ['\r'] }] }
    seed({
      answerTeammatePane,
      teammates: {
        p1: {
          state: 'read',
          projectId: 'p1',
          readAt: 1,
          teammates: [],
          worktrees: [
            {
              id: 'peer:sam:w1',
              name: 'billing',
              branch: 'billing',
              state: 'ready',
              handle: 'sam',
              publicKey: 'sam-key',
              heardAt: Date.now(),
              live: true,
              panes: [
                {
                  id: 'peer:sam:t1',
                  title: 'claude',
                  shell: '/bin/zsh',
                  agent: 'claude',
                  running: true,
                  busy: false,
                  quietForMs: 0,
                  asking: true,
                  menu
                }
              ]
            }
          ]
        }
      }
    })
    render(<Dashboard />)
    const group = screen.getByRole('group', { name: 'Answer' })
    const item = group.closest('li') as HTMLElement
    expect(item.querySelector('.board-row__worktree')?.textContent).toBe('sam · billing')
    expect(item.querySelector('.board-row__state')?.textContent).toBe('asking')
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    expect(answerTeammatePane).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ terminalId: 'peer:sam:t1', answering: '1a2b3c4d' }),
      menu.choices[0]
    )
  })
})

// A glyph named `Codex` beside the word Codex read `CodexCodex`.
describe('what a pane row says', () => {
  it('is named once: the pane, its worktree, its state and the line it shows', () => {
    printed.t1 = 'Edited calc.js'
    seed({ terminals: { t1: { ...PANE, agent: 'codex', title: 'codex' } } })
    render(<Dashboard />)
    const row = screen.getByRole('button', { name: 'Codex, atlas, ready: Edited calc.js, unread' })
    expect(row.querySelector('.agent-glyph')?.getAttribute('aria-hidden')).toBe('true')
  })
})

// The same board, by task: tree order, and a stage nobody sets.
describe('the Tasks view', () => {
  const openWorktree = vi.fn()
  const child = (id: string, name: string, overrides: Partial<Worktree> = {}): Worktree => ({
    ...WORKTREE,
    id,
    name,
    branch: `atlas--${id}`,
    parentId: 'w1',
    ...overrides
  })

  beforeEach(() => {
    openWorktree.mockReset()
    useTaskTreeStore.setState({ boardMode: 'panes' })
    seed({
      worktrees: [WORKTREE, child('w2', 'Write the migration'), child('w3', 'Update the tests')],
      terminals: {
        [PANE.id]: PANE,
        t2: { ...PANE, id: 't2', worktreeId: 'w2', agent: 'claude', screenSays: 'waiting' }
      },
      openWorktree
    })
  })

  const rows = (): string[] =>
    [...document.querySelectorAll('.task-row')].map((row) => row.querySelector('.task-row__name')?.textContent ?? '')

  it('switches from Panes to Tasks, and remembers the choice', () => {
    render(<Dashboard />)
    expect(screen.getByRole('button', { name: 'Panes' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }))
    expect(useTaskTreeStore.getState().boardMode).toBe('tasks')
    expect(rows()).toEqual(['atlas', 'Write the migration', 'Update the tests'])
    expect(document.querySelector('.page__title')?.textContent).toBe('Tasks')
    expect(document.querySelector('.page__lede')?.textContent).toBe('3')
  })

  it('shows each task’s stage and indents children', () => {
    useTaskTreeStore.setState({ boardMode: 'tasks' })
    render(<Dashboard />)
    const stages = [...document.querySelectorAll('.task-row__stage')].map((cell) => cell.textContent)
    expect(stages).toEqual(['stopped', 'asking', 'stopped'])
    expect(screen.getByText('0/2 done')).toBeTruthy()
    const depth = [...document.querySelectorAll<HTMLElement>('.task-row')].map((row) =>
      row.style.getPropertyValue('--depth')
    )
    expect(depth).toEqual(['', '1', '1'])
  })

  it('opens the parent at its Children from its tally', async () => {
    const { useChildren } = await import('../workspace/rightPanel/childrenStore')
    const showChildren = vi.fn(async () => {})
    useChildren.setState({ showChildren })
    useTaskTreeStore.setState({ boardMode: 'tasks' })
    render(<Dashboard />)
    fireEvent.click(screen.getByText('0/2 done'))
    expect(showChildren).toHaveBeenCalledWith('w1')
    expect(openWorktree).not.toHaveBeenCalled()
  })

  it('says merged, and not pushed under it while the merge is only in the local main', () => {
    const landing = {
      worktreeId: 'w1',
      branch: 'atlas',
      base: 'main',
      host: null,
      published: false,
      unmerged: 0,
      readAt: 0
    }
    useWorkspaceStore.setState({ landings: { w1: { ...landing, merged: true, notPushed: true } } })
    useTaskTreeStore.setState({ boardMode: 'tasks' })
    render(<Dashboard />)
    expect(document.querySelector('.task-row__stage')?.textContent).toBe('mergednot pushed')
    expect(document.querySelector('.task-row__unpushed')?.textContent).toBe('not pushed')
  })

  it('marks a task sharing files with another, red for a conflict, and nothing for hot files alone', async () => {
    const { useOverlaps } = await import('../state/overlapStore')
    useOverlaps.setState({
      byProject: {
        p1: [
          { worktreeId: 'w2', with: { worktreeId: 'w3' }, paths: ['src/db.ts'], conflicts: ['src/db.ts'] },
          { worktreeId: 'w3', with: { worktreeId: 'w2' }, paths: ['src/db.ts'], conflicts: ['src/db.ts'] },
          {
            worktreeId: 'w1',
            with: { worktreeId: 'w9' },
            paths: ['package.json'],
            conflicts: [],
            hot: ['package.json']
          }
        ]
      }
    })
    useTaskTreeStore.setState({ boardMode: 'tasks' })
    render(<Dashboard />)
    const marks = [...document.querySelectorAll('.task-row')].map(
      (row) => row.querySelector('.overlap')?.textContent ?? ''
    )
    expect(marks).toEqual(['', '⚠db.ts', '⚠db.ts'])
    expect(document.querySelectorAll('.task-row .overlap--conflict')).toHaveLength(2)
    expect((document.querySelector('.task-row .overlap') as HTMLElement).title).toBe(
      'src/db.ts · Update the tests · conflict'
    )
    useOverlaps.setState({ byProject: {} })
  })

  it('shows each task’s tokens, a parent’s subtree beside its own, and ≈$ only with Show Cost', () => {
    const read = { input: 0, cacheRead: 0, cacheWrite: 0, sessions: 1, unknownPanes: 0, readAt: Date.now() }
    const usage = {
      w1: {
        ...read,
        worktreeId: 'w1',
        output: 1_200_000,
        costUsd: 3.1,
        subtree: { ...read, output: 3_400_000, costUsd: 9 }
      },
      w2: { ...read, worktreeId: 'w2', output: 2_200_000, costUsd: 5.9 }
    }
    useUsageStore.setState({ usage, showCost: false })
    useTaskTreeStore.setState({ boardMode: 'tasks' })
    const { unmount } = render(<Dashboard />)
    const cells = (): string[] =>
      [...document.querySelectorAll('.task-row__tokens')].map((cell) => cell.textContent ?? '')
    expect(cells()).toEqual(['1.2M tokΣ 3.4M tok', '2.2M tok', ''])
    unmount()

    useUsageStore.setState({ showCost: true })
    render(<Dashboard />)
    expect(cells()[0]).toBe('1.2M tok · ≈$3.10Σ 3.4M tok · ≈$9.00')
  })

  it('carries each task’s pull request chip, in both views', () => {
    const pull = (number: number, failing: number) => ({
      worktreeId: `w${number}`,
      branch: 'b',
      base: 'main',
      host: 'github' as const,
      published: true,
      unmerged: 1,
      merged: false,
      readAt: 0,
      pullRequest: {
        number,
        url: `https://github.com/a/b/pull/${number}`,
        state: 'open' as const,
        checks: { passing: 1, failing, pending: 0, list: [] }
      }
    })
    useWorkspaceStore.setState({ landings: { w1: pull(1, 0), w2: pull(2, 2) } })
    const chips = (): string[] =>
      [...document.querySelectorAll('.board-row')].map((row) => row.querySelector('.prchip')?.textContent ?? '')

    const said = (): string[] =>
      [...document.querySelectorAll('.board-row')].map((row) => row.getAttribute('aria-label') ?? '')

    const { unmount } = render(<Dashboard />)
    expect(chips().sort()).toEqual(['PR #1 ✓', 'PR #2 ✗ 2'])
    expect(said().some((name) => name.includes('PR 2, 2 checks failing'))).toBe(true)
    unmount()
    useTaskTreeStore.setState({ boardMode: 'tasks' })
    render(<Dashboard />)
    expect(chips()).toEqual(['PR #1 ✓', 'PR #2 ✗ 2', ''])
    expect(said()[0]).toContain('PR 1, 1 check passing')
  })

  it('names each task row in words, column by column', async () => {
    const { useOverlaps } = await import('../state/overlapStore')
    useUsageStore.setState({ usage: {} })
    useOverlaps.setState({
      byProject: {
        p1: [{ worktreeId: 'w2', with: { worktreeId: 'w3' }, paths: ['src/db.ts'], conflicts: ['src/db.ts'] }]
      }
    })
    useTaskTreeStore.setState({ boardMode: 'tasks' })
    render(<Dashboard />)
    const row = document.querySelectorAll<HTMLElement>('.task-row')[1]!
    expect(row.getAttribute('aria-label')).toMatch(
      /^Write the migration, asking, would conflict with Update the tests in db\.ts, Claude Code asking, \S+ old$/
    )
    expect(row.querySelector('.overlap')?.closest('[aria-hidden="true"]')).not.toBeNull()
    useOverlaps.setState({ byProject: {} })
  })

  it('opens the worktree from its row', () => {
    useTaskTreeStore.setState({ boardMode: 'tasks' })
    render(<Dashboard />)
    fireEvent.click(document.querySelectorAll<HTMLElement>('.task-row')[1]!)
    expect(openWorktree).toHaveBeenCalledWith('w2')
  })
})

// Finished tasks with work, landed from the board rather than one worktree at a time.
describe('the landing queue', () => {
  const openWorktree = vi.fn(async () => {})
  const removeWorktree = vi.fn(async () => {})
  const done = { outcome: 'succeeded' as const, summary: 'Fixed.', paths: [], at: 0 }
  const task = (id: string, name: string): Worktree => ({ ...WORKTREE, id, name, branch: id, report: done })
  const clean = (worktreeId: string) => ({
    worktreeId,
    branch: worktreeId,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    readAt: 0
  })
  const ahead = (worktreeId: string, count: number) => ({
    worktreeId,
    baseRef: 'main',
    state: count > 0 ? ('clean' as const) : ('nothingToMerge' as const),
    ahead: count,
    conflicts: [],
    readAt: 0
  })
  const landing = (worktreeId: string, unmerged: number) => ({
    worktreeId,
    branch: worktreeId,
    base: 'main',
    host: null,
    published: false,
    unmerged,
    merged: false,
    readAt: 0
  })
  const queued = (): string[] =>
    [...document.querySelectorAll('.landq__row')].map((row) => row.querySelector('.landq__name')?.textContent ?? '')
  const row = (name: string): HTMLElement => document.querySelector<HTMLElement>(`.landq__row[aria-label="${name}"]`)!

  beforeEach(async () => {
    openWorktree.mockClear()
    removeWorktree.mockClear()
    const { useChildren } = await import('../workspace/rightPanel/childrenStore')
    useChildren.setState({ merging: {}, stopped: {}, skipped: {} })
    useTaskTreeStore.setState({ boardMode: 'tasks' })
    const ids = ['w1', 'w2', 'w3', 'w4']
    seed({
      worktrees: [task('w1', 'fix one'), task('w2', 'fix two'), task('w3', 'fix three'), task('w4', 'fix four')],
      terminals: {},
      statuses: Object.fromEntries(ids.map((id) => [id, clean(id)])),
      mergePreviews: { w1: ahead('w1', 1), w2: ahead('w2', 2), w3: ahead('w3', 0), w4: ahead('w4', 1) },
      landings: { w1: landing('w1', 1), w2: landing('w2', 2), w3: landing('w3', 0), w4: landing('w4', 1) },
      openWorktree,
      removeWorktree
    })
  })

  it('lists finished tasks with work to land, and leaves out one with nothing', () => {
    render(<Dashboard />)
    expect(screen.getByRole('heading', { name: /^Ready to land/ })).toBeTruthy()
    expect(queued()).toEqual(['fix one', 'fix two', 'fix four'])
    for (const name of ['Review', 'Land', 'Discard'])
      expect(within(row('fix one')).getByRole('button', { name })).toBeTruthy()
  })

  it('Land All lands them in order through the ordered merge, leaving out a predicted conflict', async () => {
    const { useOverlaps } = await import('../state/overlapStore')
    const { LANDING_QUEUE, useChildren } = await import('../workspace/rightPanel/childrenStore')
    const mergeChildren = vi.fn(async () => true)
    useChildren.setState({ mergeChildren })
    useOverlaps.setState({
      byProject: { p1: [{ worktreeId: 'w2', with: { base: 'main' }, paths: ['money.js'], conflicts: ['money.js'] }] }
    })
    render(<Dashboard />)

    fireEvent.click(screen.getByRole('button', { name: 'Land All' }))
    expect(mergeChildren).toHaveBeenCalledWith(LANDING_QUEUE, ['w1', 'w4'], [])
    expect(row('fix two').querySelector('.child__conflict')?.getAttribute('title')).toBe(
      'Conflicts with main in money.js'
    )
    useOverlaps.setState({ byProject: {} })
  })

  it('says where the run stopped, with a way into that merge', async () => {
    const { LANDING_QUEUE, useChildren } = await import('../workspace/rightPanel/childrenStore')
    useChildren.setState({
      stopped: { [LANDING_QUEUE]: { worktreeId: 'w4', error: 'x', conflicts: ['money.js'] } }
    })
    render(<Dashboard />)
    expect(screen.getByRole('alert').textContent).toContain('Stopped at fix four: conflicts in money.js')
    fireEvent.click(screen.getByRole('button', { name: 'Resolve…' }))
    expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'confirm-merge', worktreeId: 'w4' })
  })

  it('lands one from its row through the merge dialog, reviews it, and discards it', async () => {
    const { useReviewStore } = await import('../review/reviewStore')
    const reviewBranch = vi.fn()
    useReviewStore.setState({ reviewBranch })
    render(<Dashboard />)

    fireEvent.click(within(row('fix one')).getByRole('button', { name: 'Land' }))
    expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'confirm-merge', worktreeId: 'w1' })

    fireEvent.click(within(row('fix two')).getByRole('button', { name: 'Discard' }))
    expect(removeWorktree).toHaveBeenCalledWith('w2')

    fireEvent.click(within(row('fix four')).getByRole('button', { name: 'Review' }))
    await vi.waitFor(() => expect(reviewBranch).toHaveBeenCalledWith('w4'))
    expect(openWorktree).toHaveBeenCalledWith('w4')
  })

  it('is not there when nothing is ready to land', () => {
    useWorkspaceStore.setState({ mergePreviews: {}, landings: {} })
    render(<Dashboard />)
    expect(screen.queryByRole('heading', { name: /^Ready to land/ })).toBeNull()
  })
})
