/** @vitest-environment jsdom */

// The bottom rail: state that is not on screen. The runtime only when it is not ready, keep-awake and
// memory as icons, the git line, the pane count, and how many panes anywhere are asking or failed.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
let answer: SystemResources = resources

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (method: string, params: unknown) => {
      calls.push({ method, params })
      if (method === 'system.resources') return Promise.resolve(answer)
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
const revealPane = vi.fn(() => Promise.resolve())

function seed(overrides: Record<string, unknown> = {}): void {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      projects: [project],
      worktrees: [worktree],
      activeWorktreeId: 'w1',
      toggleChanges,
      revealPane,
      ...overrides
    },
    true
  )
}

const pane = (id: string, worktreeId: string, overrides: Partial<Terminal> = {}): Terminal => ({
  id,
  worktreeId,
  title: 'zsh',
  cwd: '/repos/pager-wt',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy: false,
  lastOutputAt: 0,
  ...overrides
})

const mount = (): void => {
  render(<StatusBar />)
}

beforeEach(() => {
  toggleChanges.mockReset()
  revealPane.mockClear()
  calls.length = 0
  answer = resources
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

describe('the worktree', () => {
  // The strip, the sidebar and the pane header already name it.
  it('is not named on the rail', () => {
    seed({ statuses: { w1: status({ unstaged: 1 }) } })
    mount()
    const rail = document.querySelector('.statusbar') as HTMLElement
    expect(rail.textContent).not.toContain('Rewrite the pager')
    expect(rail.textContent).not.toContain('worktree')
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
  // `terminals 1 / 14` beside a Panes badge of 4: two numbers, neither the tab's.
  // The Panes tab counts one worktree's; the bar, counting every worktree's, says how many it spans.
  it('shows every pane in the window and the worktrees they span, with the split on hover', () => {
    const other: Worktree = { ...worktree, id: 'w2', name: 'Fix the index' }
    seed({
      worktrees: [worktree, other],
      terminals: { a: pane('a', 'w1'), b: pane('b', 'w2'), c: pane('c', 'w2'), d: pane('d', 'gone') }
    })
    mount()
    const count = screen.getByText('3 panes · 2 worktrees')
    expect(count.getAttribute('title')).toBe('1 in this worktree · 3 across 2 worktrees')
    expect(screen.queryByText('terminals')).toBeNull()
  })

  it('says one pane in the singular', () => {
    seed({ terminals: { a: pane('a', 'w1') } })
    mount()
    expect(screen.getByText('1 pane')).toBeTruthy()
  })

  // The first-run welcome has nothing open; a zero there is noise.
  it('says nothing while there are no panes', () => {
    seed({ terminals: {} })
    mount()
    expect(screen.queryByText(/\bpanes?\b/)).toBeNull()
  })
})

describe('the runtime', () => {
  it('says nothing while it is ready', () => {
    seed({ runtimeVersion: '0.2.0', connection: { phase: 'ready' } })
    mount()
    expect(document.querySelector('.statusbar__connection')).toBeNull()
    expect(screen.queryByText(/Runtime/)).toBeNull()
  })

  it('says it is starting, reconnecting or down, with the reason on the hover', () => {
    seed({ connection: { phase: 'connecting' } })
    const first = render(<StatusBar />)
    expect(document.querySelector('.statusbar__connection')?.textContent).toBe('Runtime starting')
    first.unmount()

    seed({ connection: { phase: 'retrying' } })
    const second = render(<StatusBar />)
    expect(document.querySelector('.statusbar__connection')?.textContent).toBe('Reconnecting')
    second.unmount()

    seed({ connection: { phase: 'offline', detail: 'the runtime socket refused the connection' } })
    mount()
    const item = document.querySelector('.statusbar__connection')
    expect(item?.textContent).toBe('Runtime down')
    expect(item?.getAttribute('title')).toBe('the runtime socket refused the connection')
    expect(item?.querySelector('.statusbar__dot')).toBeTruthy()
  })
})

describe('keep awake', () => {
  it('is an icon with the mode on its hover, follows the agents by default, and offers the three modes upward', () => {
    mount()
    const button = screen.getByRole('button', { name: 'Keep awake, agent' })
    expect(button.textContent).toBe('')
    expect(button.getAttribute('title')).toBe('Keep awake · Agent')
    expect(button.querySelector('svg')).toBeTruthy()
    expect(button.querySelector('.statusbar__dot')).toBeNull()
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

  const filled = (): boolean =>
    screen.getByRole('button', { name: /Keep awake/ }).classList.contains('statusbar__icon--on')

  it('is filled only while it holds the machine awake', () => {
    seed({ keepAwake: 'off', terminals: { a: pane('a', 'w1', { agent: 'claude', busy: true }) } })
    const off = render(<StatusBar />)
    expect(filled()).toBe(false)
    off.unmount()

    seed({ keepAwake: 'agent' })
    const idle = render(<StatusBar />)
    expect(filled()).toBe(false)
    idle.unmount()

    seed({ keepAwake: 'agent', terminals: { a: pane('a', 'w1', { agent: 'claude', busy: true }) } })
    const busy = render(<StatusBar />)
    expect(filled()).toBe(true)
    busy.unmount()

    seed({ keepAwake: 'on' })
    mount()
    expect(filled()).toBe(true)
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

  it('is an icon alone until the app holds more than 2 GB', async () => {
    mount()
    await flush()
    const button = screen.getByRole('button', { name: /Resources/ })
    expect(button.textContent).toBe('')
    expect(button.querySelector('svg')).toBeTruthy()
    cleanup()

    answer = { ...resources, rss: 2.5 * 1024 * MB }
    mount()
    await flush()
    expect(screen.getByRole('button', { name: /Resources/ }).textContent).toBe('2.5 GB')
  })

  it('shows the total on the button while the popover is open, and the tree in the popover', async () => {
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
    fireEvent.click(button)
    await flush()
    expect(button.textContent).toBe('560 MB')
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

describe('what needs you', () => {
  const other: Worktree = { ...worktree, id: 'w2', name: 'Fix the index', branch: 'fix-the-index' }
  const asking = (id: string, worktreeId: string): Terminal =>
    pane(id, worktreeId, { agent: 'claude', agentEvent: { event: 'Notification', at: 1 } })

  it('says nothing while no pane is asking or failed', () => {
    seed({ terminals: { a: pane('a', 'w1', { agent: 'claude', busy: true }), b: pane('b', 'w1') } })
    mount()
    expect(document.querySelector('.statusbar__attention')).toBeNull()
  })

  it('counts asking panes in every worktree, and a click goes to the first', () => {
    seed({
      worktrees: [worktree, other],
      terminals: { a: pane('a', 'w1'), b: asking('b', 'w2'), c: asking('c', 'w2') }
    })
    mount()
    const button = screen.getByRole('button', { name: '2 asking' })
    expect(button.textContent).toBe('2 asking')
    expect(button.querySelector('.statusbar__asking')).toBeTruthy()
    fireEvent.click(button)
    expect(revealPane).toHaveBeenCalledWith('w2', 'b')
  })

  it('counts failed panes beside them, and goes to a failed one first', () => {
    seed({
      worktrees: [worktree, other],
      terminals: { a: asking('a', 'w1'), b: pane('b', 'w2', { agent: 'claude', running: false, exitCode: 1 }) }
    })
    mount()
    const button = screen.getByRole('button', { name: '1 asking, 1 failed' })
    expect(button.querySelector('.statusbar__failed')?.textContent).toBe('1 failed')
    fireEvent.click(button)
    expect(revealPane).toHaveBeenCalledWith('w2', 'b')
  })
})
