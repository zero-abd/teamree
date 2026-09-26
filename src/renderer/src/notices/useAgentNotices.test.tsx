/** @vitest-environment jsdom */

// The window's half of the notification: what it says about itself, and what it
// does with the one thing that comes back.
//
// Two claims are worth pinning here and neither can be seen from the main
// process. The first is that the settings it publishes are the settings —
// nothing else knows which pane has the focus, so a wrong answer here is a
// notification suppressed about a pane nobody was reading. The second is that a
// reveal arriving over IPC is checked before it is acted on: it opens a
// worktree tab, and an id for a worktree this window does not have would open
// an empty one.

import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@shared/entities'

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
const { useAgentNotices } = await import('./useAgentNotices')

type Settings = {
  preference: string
  focusedPaneId: string | null
  names?: Record<string, string>
  activeWorktreeId?: string | null
}

const INITIAL = useWorkspaceStore.getState()

const publish = vi.fn<(settings: Settings) => void>()
const revealPane = vi.fn(async () => {})

/** Whatever the main process would call when a notification is clicked. */
let reveal: ((pane: { worktreeId: string; terminalId: string }) => void) | null = null
let listening = 0

function Harness(): null {
  useAgentNotices()
  return null
}

function seed(overrides: Record<string, unknown> = {}): void {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      revealPane,
      worktrees: [
        {
          id: 'w1',
          projectId: 'p1',
          name: 'fix the parser',
          branch: 'fix-the-parser',
          path: '/w1',
          startedFrom: 'origin/main',
          state: 'ready',
          createdAt: 0
        }
      ],
      activeWorktreeId: 'w1',
      layouts: { w1: { worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' } },
      ...overrides
    },
    true
  )
}

/** The most recent publish. */
function latest(): Settings | undefined {
  return publish.mock.calls.at(-1)?.[0]
}

beforeEach(() => {
  publish.mockReset()
  revealPane.mockReset()
  reveal = null
  listening = 0
  ;(window as unknown as { teamree: unknown }).teamree = {
    notices: {
      publish,
      onReveal: (listener: (pane: { worktreeId: string; terminalId: string }) => void) => {
        reveal = listener
        listening += 1
        return () => {
          reveal = null
          listening -= 1
        }
      }
    }
  }
})

afterEach(() => {
  delete (window as unknown as { teamree?: unknown }).teamree
})

describe('what the window tells the main process', () => {
  it('says what it wants, which pane and which worktree it is looking at, as soon as it is up', () => {
    seed()
    render(<Harness />)

    expect(publish).toHaveBeenCalledTimes(1)
    expect(latest()).toEqual({ preference: 'notify', focusedPaneId: 't1', names: {}, activeWorktreeId: 'w1' })
  })

  // What a notification calls a pane is what the board calls it.
  it('says what each of its own panes is called', () => {
    const pane = (id: string, ordinal: number): Terminal => ({
      id,
      worktreeId: 'w1',
      title: 'node',
      cwd: '/w1',
      shell: '/bin/zsh',
      cols: 80,
      rows: 24,
      running: true,
      busy: false,
      lastOutputAt: 0,
      agent: 'claude',
      ordinal
    })
    seed({ terminals: { t2: pane('t2', 2), t1: pane('t1', 1) } })
    render(<Harness />)

    expect(latest()?.names).toEqual({ t1: 'Claude Code', t2: 'Claude Code 2' })
  })

  // A teammate's pane is somebody else's session. No notification raised here
  // is ever about one, so calling it the focused pane would suppress a notice
  // about a pane of your own.
  it('names no pane while a teammate’s has the focus', () => {
    seed({ focusedWatchId: 'watch_1' })
    render(<Harness />)

    expect(latest()?.focusedPaneId).toBeNull()
  })

  it('says again when the focus moves', () => {
    seed()
    render(<Harness />)

    useWorkspaceStore.setState({
      layouts: {
        w1: {
          worktreeId: 'w1',
          root: { kind: 'leaf', terminalId: 't1' },
          focusedTerminalId: 't2'
        }
      }
    })

    expect(publish).toHaveBeenCalledTimes(2)
    expect(latest()?.focusedPaneId).toBe('t2')
  })

  it('says again when the preference changes', () => {
    seed()
    render(<Harness />)

    useWorkspaceStore.getState().setAgentNotices('sound')

    expect(latest()?.preference).toBe('sound')
  })

  // The store changes many times a second while a pane is printing, and none of
  // those change either answer.
  it('says nothing again when the change was not about either', () => {
    seed()
    render(<Harness />)
    expect(publish).toHaveBeenCalledTimes(1)

    useWorkspaceStore.setState({ sidebarWidth: 321 })
    useWorkspaceStore.setState({ dashboardOpen: true })

    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('stops listening and stops publishing when the window goes', () => {
    seed()
    const view = render(<Harness />)
    expect(listening).toBe(1)

    view.unmount()
    expect(listening).toBe(0)

    useWorkspaceStore.setState({ activeWorktreeId: null })
    expect(publish).toHaveBeenCalledTimes(1)
  })
})

describe('what comes back when a notification is clicked', () => {
  it('opens that worktree and focuses that pane', () => {
    seed()
    render(<Harness />)

    reveal?.({ worktreeId: 'w1', terminalId: 't7' })
    expect(revealPane).toHaveBeenCalledExactlyOnceWith('w1', 't7')
  })

  it('does nothing for a worktree this window does not have', () => {
    seed()
    render(<Harness />)

    reveal?.({ worktreeId: 'w-nowhere', terminalId: 't7' })
    expect(revealPane).not.toHaveBeenCalled()
  })
})
