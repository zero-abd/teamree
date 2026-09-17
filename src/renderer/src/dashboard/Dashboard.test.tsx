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

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { Dashboard } = await import('./Dashboard')
const { resolvePlatformModifier } = await import('../keyboard/platformModifier')

const INITIAL = useWorkspaceStore.getState()
const MODIFIER = resolvePlatformModifier('darwin')

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
  seed()
})

describe('leaving the board', () => {
  it('closes on Escape, which is what a reader tries first', () => {
    render(<Dashboard modifier={MODIFIER} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(toggleDashboard).toHaveBeenCalledTimes(1)
  })

  it('stands aside while a dialog this window opened is on top of it', () => {
    seed({ dialog: { kind: 'palette' } })
    render(<Dashboard modifier={MODIFIER} />)
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
    render(<Dashboard modifier={MODIFIER} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(toggleDashboard).not.toHaveBeenCalled()
  })
})

describe('where the keyboard lands', () => {
  it('puts the focus on the first row, which is both the answer and the way to it', () => {
    render(<Dashboard modifier={MODIFIER} />)
    const row = screen.getByRole('button', { name: /atlas/ })
    expect(document.activeElement).toBe(row)
  })

  // The board is reachable before the runtime has answered, and the empty state
  // renders no list at all — so a mount-only focus effect focused nothing, and
  // the rows that arrived a moment later could not be reached from the keyboard
  // at all. This is the shape of every launch.
  it('lands on the first row that arrives after the board was already open', () => {
    seed({ worktrees: [], terminals: {} })
    const view = render(<Dashboard modifier={MODIFIER} />)
    expect(screen.getByText('Nothing running')).toBeTruthy()

    useWorkspaceStore.setState({ worktrees: [WORKTREE], terminals: { [PANE.id]: PANE } })
    view.rerender(<Dashboard modifier={MODIFIER} />)

    expect(document.activeElement).toBe(screen.getByRole('button', { name: /atlas/ }))
  })
})
