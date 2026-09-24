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

import { fireEvent, render, screen } from '@testing-library/react'
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
vi.mock('../sidebar/usePaneEvidence', () => ({ usePaneEvidence: () => printed }))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { Dashboard } = await import('./Dashboard')

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
    expect(filters()).toEqual(['2 stopped', '2 idle'])
    expect(document.querySelectorAll('.activity')).toHaveLength(0)
  })

  it('counts what the rows show, word for word', () => {
    seedMixed()
    render(<Dashboard />)
    const states = [...document.querySelectorAll('.board-row__state')].map((state) => state.textContent ?? '')
    expect(states.sort()).toEqual(['idle', 'stopped', 'working'])
    expect(filters()).toEqual(['1 working', '1 stopped', '1 idle'])
  })

  it('shows one state’s panes when its count is pressed, and every pane when pressed again', () => {
    seedMixed()
    render(<Dashboard />)
    const stopped = screen.getByRole('button', { name: '1 stopped' })
    fireEvent.click(stopped)
    expect(stopped.getAttribute('aria-pressed')).toBe('true')
    expect([...document.querySelectorAll('.board-row__state')].map((state) => state.textContent)).toEqual(['stopped'])
    fireEvent.click(stopped)
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

  it('colours the state word only when the pane needs somebody', () => {
    seed({
      terminals: {
        failed: { ...PANE, id: 'failed', title: 'npm test', running: false, exitCode: 1 },
        quiet: { ...PANE, id: 'quiet', title: 'zsh' }
      }
    })
    render(<Dashboard />)
    const classes = [...document.querySelectorAll('.board-row__state')].map((state) => state.className)
    expect(classes).toEqual(['board-row__state board-row__state--failed', 'board-row__state'])
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
})
