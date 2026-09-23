/** @vitest-environment jsdom */

// The bottom rail: the git segment that opens the changes panel, and the two
// utilities at its left end — whether this Mac may sleep, and what everything
// this app spawned is costing.
//
// It shows state and never instructions. The keyboard legend that used to sit
// at its right end is gone: the chords are in the menu bar, the palette and the
// help page, and a strip of keycaps on every screen was a fourth copy of them.

import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, SystemResources, Terminal, Worktree, WorktreeStatus } from '@shared/entities'

const MB = 1024 * 1024

const resources: SystemResources = {
  sampledAt: 1000,
  cpu: 105.2,
  rss: 560 * MB,
  panes: [
    {
      terminalId: 't_1',
      worktreeId: 'w1',
      pid: 600,
      cpu: 102.9,
      rss: 63 * MB,
      processes: [
        { pid: 600, ppid: 500, cpu: 0, rss: 3 * MB, command: 'zsh' },
        { pid: 601, ppid: 600, cpu: 98.7, rss: 50 * MB, command: 'node' }
      ]
    }
  ],
  app: {
    pid: 500,
    cpu: 2.3,
    rss: 497 * MB,
    processes: [{ pid: 500, ppid: 1, cpu: 2.3, rss: 497 * MB, command: 'teamree' }]
  }
}

const calls: Array<{ method: string; params: unknown }> = []

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (method: string, params: unknown) => {
      calls.push({ method, params })
      if (method === 'system.resources') return Promise.resolve(resources)
      if (method === 'system.kill') return Promise.resolve({ signalled: true, pid: 601, group: false })
      return new Promise(() => {})
    },
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { StatusBar } = await import('./StatusBar')

const INITIAL = useWorkspaceStore.getState()

const project: Project = { id: 'p1', name: 'pager', path: '/repos/pager', baseRef: 'origin/main' }

const worktree: Worktree = {
  id: 'w1',
  projectId: 'p1',
  name: 'Rewrite the pager',
  branch: 'rewrite-the-pager',
  path: '/repos/pager-wt/rewrite',
  startedFrom: 'origin/main',
  state: 'ready',
  createdAt: 0
}

const status = (overrides: Partial<WorktreeStatus> = {}): WorktreeStatus => ({
  worktreeId: 'w1',
  branch: 'rewrite-the-pager',
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  readAt: 0,
  ...overrides
})

const toggleChanges = vi.fn()

function seed(overrides: Record<string, unknown> = {}): void {
  useWorkspaceStore.setState(
    { ...INITIAL, projects: [project], worktrees: [worktree], activeWorktreeId: 'w1', toggleChanges, ...overrides },
    true
  )
}

const mount = (): void => {
  render(<StatusBar />)
}

beforeEach(() => {
  toggleChanges.mockReset()
  calls.length = 0
  seed()
})

describe('the git segment', () => {
  it('opens the changes panel, and says which panel it is', () => {
    seed({ statuses: { w1: status({ behind: 2, unstaged: 1 }) } })
    mount()
    const git = screen.getByRole('button', { name: 'Changes, 2 behind · 1 uncommitted' })
    expect(git.textContent).toBe('git2 behind · 1 uncommitted')
    fireEvent.click(git)
    expect(toggleChanges).toHaveBeenCalledOnce()
  })

  it('says whether the panel is showing', () => {
    seed({ statuses: { w1: status({ unstaged: 1 }) }, rightPanelOpen: true, rightPanelTab: 'changes' })
    mount()
    expect(screen.getByRole('button', { name: 'Changes, 1 uncommitted' }).getAttribute('aria-pressed')).toBe('true')
  })

  // The panel open on another tab is not the changes panel showing: a click
  // then brings the changes tab up rather than putting the panel away, and a
  // pressed button would promise the opposite.
  it('is not pressed while the panel shows another tab', () => {
    seed({ statuses: { w1: status({ unstaged: 1 }) }, rightPanelOpen: true, rightPanelTab: 'files' })
    mount()
    expect(screen.getByRole('button', { name: 'Changes, 1 uncommitted' }).getAttribute('aria-pressed')).toBe('false')
  })

  // A clean tree is still a fact worth a button: the panel is where the last
  // commits are read, not only where dirty files are staged.
  it('is offered for a clean worktree as well', () => {
    seed({ statuses: { w1: status() } })
    mount()
    expect(screen.getByRole('button', { name: 'Changes, clean, in sync' })).toBeTruthy()
  })

  it('is not offered before the status has been read, because there is nothing to open on', () => {
    mount()
    expect(screen.queryByRole('button', { name: /Changes/ })).toBeNull()
  })
})

describe('the rail as a whole', () => {
  it('shows state and no keycaps', () => {
    mount()
    expect(document.querySelectorAll('kbd')).toHaveLength(0)
    expect(screen.queryByText('split')).toBeNull()
    expect(screen.queryByText('move')).toBeNull()
  })
})

describe('the pane count', () => {
  const pane = (id: string, worktreeId: string): Terminal => ({
    id,
    worktreeId,
    title: 'zsh',
    cwd: '/repos/pager-wt',
    shell: '/bin/zsh',
    cols: 80,
    rows: 24,
    running: true,
    busy: false,
    lastOutputAt: 0
  })

  // `terminals 1 / 14` beside a Panes badge of 4: two numbers, neither the tab's.
  it('shows one number, every pane in the window, with the split on hover', () => {
    const other: Worktree = { ...worktree, id: 'w2', name: 'Fix the index' }
    seed({
      worktrees: [worktree, other],
      terminals: { a: pane('a', 'w1'), b: pane('b', 'w2'), c: pane('c', 'w2'), d: pane('d', 'gone') }
    })
    mount()
    const count = screen.getByText('3 panes')
    expect(count.getAttribute('title')).toBe('1 in this worktree · 3 across 2 worktrees')
    expect(screen.queryByText('terminals')).toBeNull()
  })

  it('says one pane in the singular', () => {
    seed({ terminals: { a: pane('a', 'w1') } })
    mount()
    expect(screen.getByText('1 pane')).toBeTruthy()
  })
})

// The runtime segment is a dot and nothing else. `● Runtime ready 0.2.0` was
// three facts where one glance needs one: the colour is the state, and the
// words and the version are on the hover for whoever wants them. The version
// keeps its places in Settings and the About box.
describe('the runtime dot', () => {
  it('shows no words and no version, and puts both on its hover', () => {
    seed({ runtimeVersion: '0.2.0', connection: { phase: 'ready' } })
    mount()
    expect(screen.queryByText(/Runtime ready/)).toBeNull()
    expect(screen.queryByText(/0\.2\.0/)).toBeNull()
    const dot = document.querySelector('.statusbar__connection')
    expect(dot?.textContent).toBe('')
    expect(dot?.getAttribute('title')).toBe('Runtime 0.2.0')
    expect(dot?.classList.contains('statusbar__connection--ready')).toBe(true)
  })

  it('says it is starting, and then why it is down, on the hover alone', () => {
    seed({ connection: { phase: 'connecting' } })
    const { unmount } = render(<StatusBar />)
    expect(document.querySelector('.statusbar__connection')?.getAttribute('title')).toBe('Runtime starting')
    unmount()

    seed({ connection: { phase: 'offline', detail: 'the runtime socket refused the connection' } })
    mount()
    const dot = document.querySelector('.statusbar__connection')
    expect(dot?.getAttribute('title')).toBe('the runtime socket refused the connection')
    expect(dot?.classList.contains('statusbar__connection--offline')).toBe(true)
    expect(dot?.textContent).toBe('')
  })
})

describe('keep awake', () => {
  it('shows the mode, follows the agents by default, and offers the three modes upward', () => {
    mount()
    const button = screen.getByRole('button', { name: /Keep awake/ })
    expect(button.textContent).toBe('Awake · agent')
    fireEvent.click(button)
    const radios = screen.getAllByRole('radio')
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
    expect(screen.getByRole('dialog', { name: 'Keep awake' })).toBeTruthy()
  })

  it('changes the mode and remembers it', () => {
    const setKeepAwake = vi.fn()
    seed({ keepAwake: 'agent', setKeepAwake })
    mount()
    fireEvent.click(screen.getByRole('button', { name: /Keep awake/ }))
    fireEvent.click(screen.getByRole('radio', { name: /^On/ }))
    expect(setKeepAwake).toHaveBeenCalledWith('on')
  })

  it('says so on the button once the mode is off', () => {
    seed({ keepAwake: 'off' })
    mount()
    expect(screen.getByRole('button', { name: /Keep awake/ }).textContent).toBe('Sleep ok')
  })

  it('closes on Escape and gives the focus back to the button', () => {
    mount()
    const button = screen.getByRole('button', { name: /Keep awake/ })
    fireEvent.click(button)
    expect(screen.getByRole('dialog', { name: 'Keep awake' })).toBeTruthy()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Keep awake' })).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it('closes on a press outside', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: /Keep awake/ }))
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog', { name: 'Keep awake' })).toBeNull()
  })
})

describe('resources', () => {
  const flush = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('shows the total on the button and the tree in the popover', async () => {
    seed({
      terminals: {
        t_1: {
          id: 't_1',
          worktreeId: 'w1',
          title: 'claude',
          cwd: '/',
          shell: '/bin/zsh',
          cols: 80,
          rows: 24,
          running: true,
          busy: false,
          lastOutputAt: 0,
          agent: 'claude'
        }
      }
    })
    mount()
    await flush()
    const button = screen.getByRole('button', { name: /Resources/ })
    expect(button.textContent).toBe('560 MB')
    fireEvent.click(button)
    await flush()
    const popover = screen.getByRole('dialog', { name: 'Resources' })
    expect(popover.textContent).toContain('105.2%')
    expect(popover.textContent).toContain('Rewrite the pager')
    expect(popover.textContent).toContain('Claude Code')
    expect(popover.textContent).toContain('63 MB')
    // The app's own row, last.
    expect(popover.textContent).toMatch(/teamree.*497 MB/)
  })

  it('opens a pane to its processes and kills one only on the second press', async () => {
    mount()
    await flush()
    fireEvent.click(screen.getByRole('button', { name: /Resources/ }))
    await flush()
    fireEvent.click(screen.getByRole('button', { name: /Show processes of t_1/ }))
    const row = screen.getByText('node').closest('li')
    expect(row?.textContent).toContain('601')
    const kill = screen.getByRole('button', { name: 'Kill 601' })
    fireEvent.click(kill)
    expect(calls.filter((call) => call.method === 'system.kill')).toHaveLength(0)
    expect(kill.textContent).toBe('Confirm')
    fireEvent.click(kill)
    await flush()
    expect(calls.filter((call) => call.method === 'system.kill')).toEqual([
      { method: 'system.kill', params: { pid: 601 } }
    ])
  })

  it('never offers to kill the app itself', async () => {
    mount()
    await flush()
    fireEvent.click(screen.getByRole('button', { name: /Resources/ }))
    await flush()
    expect(screen.queryByRole('button', { name: 'Kill 500' })).toBeNull()
  })

  it('samples again on Refresh', async () => {
    mount()
    await flush()
    fireEvent.click(screen.getByRole('button', { name: /Resources/ }))
    await flush()
    const before = calls.filter((call) => call.method === 'system.resources').length
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await flush()
    expect(calls.filter((call) => call.method === 'system.resources').length).toBe(before + 1)
  })
})
