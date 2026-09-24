/** @vitest-environment jsdom */

// What an empty right-hand side says: a dead runtime, a first run, and worktrees with none open are told
// apart. No header over the panes. A teammate's pane is an ordinary sibling cell with a gutter, and
// survives the navigations that replace everything else here.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstalledAgent, Layout, Project, Worktree, WorktreeStatus } from '@shared/entities'
import { resolvePlatformModifier } from '../keyboard/platformModifier'

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

// Each has its own coverage; none of them decides which placeholder is right.
vi.mock('../panes/PaneTree', () => ({ PaneTree: () => <div data-testid="panes" /> }))
// The viewer is tested in its own file; this decides which panes exist and where.
vi.mock('../terminal/WatchedPaneView', () => ({
  WatchedPaneView: ({ handle, paneId }: { handle: string; paneId: string }) => (
    <div data-testid={`watched-${handle}-${paneId}`} />
  )
}))
vi.mock('./rightPanel/RightPanel', () => ({ RightPanel: () => null }))
vi.mock('../dashboard/Dashboard', () => ({ Dashboard: () => <div data-testid="dashboard" /> }))
// Tested elsewhere; this checks only that they take the area.
vi.mock('../settings/SettingsView', () => ({ SettingsView: () => <div data-testid="settings" /> }))
vi.mock('../help/HelpView', () => ({ HelpView: () => <div data-testid="help" /> }))
vi.mock('./TerminalTabs', () => ({ TerminalTabs: () => null }))
// jsdom has no browser; the welcome must use the one path that does.
vi.mock('../shell/openInBrowser', () => ({ openInBrowser: vi.fn() }))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { WorkspaceArea } = await import('./WorkspaceArea')
const { startMenuItems } = await import('./startMenu')

const INITIAL = useWorkspaceStore.getState()
const MAC = resolvePlatformModifier('darwin')

const project: Project = { id: 'p1', name: 'pager', path: '/repos/pager', baseRef: 'origin/main' }

const worktree = (overrides: Partial<Worktree> = {}): Worktree => ({
  id: 'w1',
  projectId: 'p1',
  name: 'Rewrite the pager',
  branch: 'rewrite-the-pager',
  path: '/repos/pager-wt/rewrite',
  startedFrom: 'origin/main',
  state: 'ready',
  createdAt: 0,
  ...overrides
})

const layout = (): Layout => ({
  worktreeId: 'w1',
  root: { kind: 'leaf', terminalId: 't1' },
  focusedTerminalId: 't1'
})

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

const openDialog = vi.fn()
const pushActiveWorktree = vi.fn()
const createTerminal = vi.fn()
const startAgent = vi.fn()
const openWorktree = vi.fn()
const openTeamwork = vi.fn()
const revealInFinder = vi.fn()

function seed(overrides: Record<string, unknown> = {}): void {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      openDialog,
      pushActiveWorktree,
      createTerminal,
      startAgent,
      openWorktree,
      openTeamwork,
      revealInFinder,
      restoring: false,
      ...overrides
    },
    true
  )
}

const mount = (): void => {
  render(<WorkspaceArea modifier={MAC} isAppChord={() => false} />)
}

beforeEach(() => {
  openDialog.mockReset()
  pushActiveWorktree.mockReset()
  createTerminal.mockReset()
  startAgent.mockReset()
  openWorktree.mockReset()
  openTeamwork.mockReset()
  revealInFinder.mockReset()
  seed()
})

describe('when there is nothing open', () => {
  // Where somebody is looking, and every shortcut would be inert.
  it('says the runtime is not running, and offers no chord that cannot answer', () => {
    seed({ projects: [project], connection: { phase: 'offline', detail: 'the runtime exited with code 1' } })
    mount()
    expect(screen.getByRole('heading', { name: 'The runtime is not running' })).toBeTruthy()
    expect(screen.getByText('the runtime exited with code 1')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(document.querySelector('kbd')).toBeNull()
  })

  it('says the runtime is not running even when nothing said why', () => {
    seed({ connection: { phase: 'offline' } })
    mount()
    expect(screen.getByRole('heading', { name: 'The runtime is not running' })).toBeTruthy()
  })

  // A dead runtime outranks a first run: "add project" cannot work.
  it('prefers the dead runtime to the welcome when both are true', () => {
    seed({ projects: [], connection: { phase: 'offline' } })
    mount()
    expect(screen.queryByRole('button', { name: 'Open Folder…' })).toBeNull()
  })

  // First run: the two ways to a project, side by side; no task button until there is one.
  it('welcomes a first run with the mark and the two ways to add a project', () => {
    const chooseProjectFolder = vi.fn(() => Promise.resolve())
    seed({ projects: [], chooseProjectFolder })
    mount()
    expect(document.querySelector('.welcome .brand__mark')).toBeTruthy()
    expect(screen.getByText('teamree')).toBeTruthy()
    expect(screen.queryByRole('heading')).toBeNull()
    const actions = document.querySelector('.welcome__actions') as HTMLElement
    expect([...actions.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      'Open Folder…',
      'Clone…'
    ])
    const open = screen.getByRole('button', { name: 'Open Folder…' })
    expect(open.className).toContain('button--primary')
    fireEvent.click(open)
    expect(chooseProjectFolder).toHaveBeenCalledOnce()
    expect(openDialog).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Clone…' }))
    expect(openDialog).toHaveBeenCalledExactlyOnceWith({ kind: 'clone-project' })
    expect(screen.queryByRole('button', { name: 'New Task' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'New Terminal' })).toBeNull()
  })

  // With a project the page's one job is a task; the sidebar's + adds projects.
  it('offers only a new task once there is a project, and no agent by name', () => {
    seed({ projects: [project], agents: [{ kind: 'claude', command: 'claude', binary: '/usr/local/bin/claude' }] })
    mount()
    const actions = document.querySelector('.welcome__actions') as HTMLElement
    expect([...actions.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['New Task'])
    expect(screen.getByRole('button', { name: 'New Task' }).className).toContain('button--primary')
    expect(screen.queryByRole('button', { name: 'Open Folder…' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clone…' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'New Task' }))
    expect(openDialog).toHaveBeenCalledExactlyOnceWith({ kind: 'new-task', projectId: 'p1' })
    expect(screen.queryByRole('button', { name: /^Start / })).toBeNull()
    expect(screen.queryByRole('button', { name: 'New Terminal' })).toBeNull()
  })

  it('starts the new task in the project added last', () => {
    seed({ projects: [project, { ...project, id: 'p2', name: 'ledger', path: '/repos/ledger' }] })
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'New Task' }))
    expect(openDialog).toHaveBeenCalledExactlyOnceWith({ kind: 'new-task', projectId: 'p2' })
  })

  it('names the chords, New Task’s first once there is a project for it', () => {
    seed({ projects: [project] })
    mount()
    const keys = [...document.querySelectorAll('.welcome kbd')].map((node) => node.textContent)
    expect(keys).toEqual(['⌘N', '⌘K', '⌘B'])
    cleanup()
    seed({ projects: [] })
    mount()
    expect([...document.querySelectorAll('.welcome kbd')].map((node) => node.textContent)).toEqual(['⌘K', '⌘B'])
  })

  // The last window's front tab is on its way: a welcome in the meantime is a screen that flashes past.
  it('shows nothing while the last window is being brought back', () => {
    seed({ projects: [project], restoring: true })
    mount()
    expect(screen.getByRole('main').textContent).toBe('')
  })

  it('still says the runtime is not running while it would be bringing a window back', () => {
    seed({ restoring: true, connection: { phase: 'offline' } })
    mount()
    expect(screen.getByRole('heading', { name: 'The runtime is not running' })).toBeTruthy()
  })

  it('shows the teamwork setup instead of any of that when it has the area', () => {
    seed({ projects: [project], teamworkProjectId: 'p1' })
    mount()
    expect(screen.getByRole('main', { name: 'Set up teamwork in pager' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open Folder…' })).toBeNull()
  })

  it('shows the dashboard instead of any of that when it is open', () => {
    seed({ projects: [], dashboardOpen: true })
    mount()
    expect(screen.getByTestId('dashboard')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open Folder…' })).toBeNull()
  })
})

// The + menu's rows as buttons, under the worktree's name and branch; the front door is not shown.
describe('a worktree with no panes in it', () => {
  const claude: InstalledAgent = { kind: 'claude', command: 'claude', binary: '/usr/local/bin/claude' }
  const codex: InstalledAgent = { kind: 'codex', command: 'codex', binary: '/opt/bin/codex' }
  const openEmpty = (overrides: Partial<Worktree> = {}): void => {
    seed({ projects: [project], worktrees: [worktree(overrides)], activeWorktreeId: 'w1', agents: [claude, codex] })
    mount()
  }
  // The label only: a glyph's <title> is text too.
  const startButtons = (): string[] =>
    [...document.querySelectorAll('.worktree-start__actions button')].map(
      (button) => button.lastChild?.textContent ?? ''
    )

  // `perf / perf`: the branch is said only when it is not the name slugified.
  it('names the worktree, its branch only when it says more, and none of the front door', () => {
    openEmpty()
    expect(screen.getByRole('heading', { name: 'Rewrite the pager' })).toBeTruthy()
    expect(screen.queryByText('rewrite-the-pager')).toBeNull()
    cleanup()
    openEmpty({ branch: 'feature/pager' })
    expect(screen.getByText('feature/pager')).toBeTruthy()
    for (const name of ['Open Folder…', 'New Task', 'Star on GitHub']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    expect(document.querySelector('.brand__mark')).toBeNull()
    expect(document.querySelector('kbd')).toBeNull()
  })

  // `29-after-close.png` was titled by the stored name, agent word first.
  it('titles one of a task’s runs by the task, its agent as the glyph', () => {
    openEmpty({ name: 'Rewrite the pager claude', branch: 'rewrite-the-pager-claude', task: 'Rewrite the pager' })
    const heading = screen.getByRole('heading', { name: 'Rewrite the pager (Claude Code)' })
    expect(heading.textContent).toBe('Rewrite the pager')
    expect(heading.querySelector('[data-agent="claude"]')).not.toBeNull()
  })

  it('offers every pane the + menu offers, in its order', () => {
    openEmpty()
    const menu = startMenuItems([claude, codex], MAC, {
      newTerminal: () => {},
      newMarkdown: () => {},
      startAgent: () => {},
      openAgentSettings: () => {}
    })
    expect(startButtons()).toEqual(menu.map((item) => item.label).filter((label) => label !== 'Agent Settings…'))
    expect(startButtons()).toEqual(['New Terminal', 'New Markdown', 'Claude Code', 'Codex'])
  })

  it('marks each agent with its harness glyph', () => {
    openEmpty()
    const button = screen.getByRole('button', { name: 'Codex' })
    expect(button.querySelector('svg[data-agent="codex"]')).toBeTruthy()
  })

  it('starts the agent chosen, or a terminal, in this worktree', () => {
    openEmpty()
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }))
    expect(startAgent).toHaveBeenCalledExactlyOnceWith('codex')
    fireEvent.click(screen.getByRole('button', { name: 'New Terminal' }))
    expect(createTerminal).toHaveBeenCalledExactlyOnceWith('w1')
  })

  it('offers nothing to start while the checkout is still being prepared', () => {
    openEmpty({ state: 'creating' })
    expect(screen.getByRole('heading', { name: 'Rewrite the pager' })).toBeTruthy()
    expect(startButtons()).toEqual([])
    expect(screen.queryByRole('button', { name: 'Open Folder…' })).toBeNull()
  })

  // Ready on paper, gone from disk: anything started here would fail with a path.
  it('offers nothing to start in a worktree whose checkout is missing', () => {
    openEmpty({ missing: true })
    expect(startButtons()).toEqual([])
  })
})

// No header between the strip and the panes; everything it said is printed elsewhere.
describe('over an open worktree', () => {
  beforeEach(() => {
    seed({
      projects: [project],
      worktrees: [worktree()],
      activeWorktreeId: 'w1',
      layouts: { w1: layout() },
      statuses: { w1: status({ ahead: 2, unstaged: 3 }) }
    })
    mount()
  })

  it('renders the panes and no row above them', () => {
    expect(screen.getByTestId('panes')).toBeTruthy()
    expect(document.querySelector('.workspace__head')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Rewrite the pager' })).toBeNull()
    expect(screen.queryByText('/repos/pager-wt/rewrite')).toBeNull()
  })

  it('offers none of what the row used to', () => {
    for (const name of [/^Changes/, /^Push/, /^Show the/]) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    expect(pushActiveWorktree).not.toHaveBeenCalled()
    expect(revealInFinder).not.toHaveBeenCalled()
  })
})

// Settings and help take the area; the empty state links to both.
describe('settings and help', () => {
  it('gives the area to settings, ahead of the empty state somebody opened it from', () => {
    seed({ projects: [project], settingsOpen: true })
    mount()
    expect(screen.getByTestId('settings')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open Folder…' })).toBeNull()
  })

  it('gives the area to help on the same terms', () => {
    seed({ projects: [project], helpOpen: true })
    mount()
    expect(screen.getByTestId('help')).toBeTruthy()
  })
})

describe('a teammate’s pane beside your own', () => {
  const watch = (handle: string, paneId: string) => ({
    id: `watch:p1:${paneId}`,
    projectId: 'p1',
    paneId,
    label: 'claude',
    handle
  })

  const openWorktreeWith = (watches: ReturnType<typeof watch>[]): void => {
    seed({
      projects: [project],
      worktrees: [worktree()],
      activeWorktreeId: 'w1',
      layouts: { w1: layout() },
      watches
    })
    mount()
  }

  // Nobody watched: no gutter, no second cell.
  it('takes no room at all while nobody is being watched', () => {
    openWorktreeWith([])
    expect(document.querySelectorAll('.workspace-split > .split__cell')).toHaveLength(1)
    expect(screen.queryByRole('separator')).toBeNull()
  })

  it('takes a cell of its own, with a gutter to drag between it and the workspace', () => {
    openWorktreeWith([watch('priya', 'priya:t7')])
    expect(screen.getByTestId('watched-priya-priya:t7')).toBeTruthy()
    expect(document.querySelectorAll('.workspace-split > .split__cell')).toHaveLength(2)
    expect(screen.getAllByRole('separator')).toHaveLength(1)
  })

  it('gives every watched pane a cell, and a gutter between each pair', () => {
    openWorktreeWith([watch('priya', 'priya:t7'), watch('ana', 'ana:t2')])
    expect(document.querySelectorAll('.workspace-split > .split__cell')).toHaveLength(3)
    expect(screen.getAllByRole('separator')).toHaveLength(2)
  })

  // Resized by the same component, so the same handle, arithmetic and arrow keys.
  it('is resized by the gutter, and the width is the window’s to keep', () => {
    const setWatchSizes = vi.fn()
    seed({
      projects: [project],
      worktrees: [worktree()],
      activeWorktreeId: 'w1',
      layouts: { w1: layout() },
      watches: [watch('priya', 'priya:t7')],
      setWatchSizes
    })
    mount()
    // jsdom has no layout; the drag axis is stated.
    const split = document.querySelector('.workspace-split') as HTMLElement
    Object.defineProperty(split, 'clientWidth', { get: () => 1000 })
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' })
    const [sizes] = setWatchSizes.mock.calls[0] as [number[]]
    expect(sizes).toHaveLength(2)
    expect(sizes[0] ?? 1).toBeLessThan(0.5)
    expect((sizes[0] ?? 0) + (sizes[1] ?? 0)).toBeCloseTo(1)
  })

  // Navigating must not close and reopen a watched pane's subscription.
  it('stays where it is when the pane board takes the area', () => {
    openWorktreeWith([watch('priya', 'priya:t7')])
    act(() => {
      useWorkspaceStore.setState({ dashboardOpen: true })
    })
    expect(screen.getByTestId('dashboard')).toBeTruthy()
    expect(screen.getByTestId('watched-priya-priya:t7')).toBeTruthy()
  })

  // Teamwork setup is a cell of the same split, so a push's progress sits beside a watched pane.
  it('stays where it is when teamwork setup takes the area', () => {
    openWorktreeWith([watch('priya', 'priya:t7')])
    act(() => {
      useWorkspaceStore.setState({ teamworkProjectId: 'p1' })
    })
    expect(screen.getByRole('main', { name: 'Set up teamwork in pager' })).toBeTruthy()
    expect(screen.getByTestId('watched-priya-priya:t7')).toBeTruthy()
  })

  it('stays where it is with no worktree open at all', () => {
    seed({ projects: [project], watches: [watch('priya', 'priya:t7')] })
    mount()
    expect(screen.getByRole('button', { name: 'New Task' })).toBeTruthy()
    expect(screen.getByTestId('watched-priya-priya:t7')).toBeTruthy()
  })
})

// Generated from the menu's table, so labels cannot go stale; at most three rows.
describe('the welcome’s shortcut list and the menu bar use one set of words', () => {
  it('names every command exactly as the menu bar names it, with its chord', async () => {
    const { menuBarSpec } = await import('../menu/menuBar')
    const { commandNamed, shortcutHint } = await import('../keyboard/workspaceShortcuts')
    seed({ projects: [project], worktrees: [] })
    mount()

    const menu = new Map(menuBarSpec(useWorkspaceStore.getState()).map((item) => [item.command, item.label]))
    const rows = [...document.querySelectorAll('.welcome__shortcuts > div')]
    expect(rows.map((row) => row.getAttribute('data-command'))).toEqual([
      'new-worktree',
      'open-palette',
      'toggle-sidebar'
    ])
    for (const row of rows) {
      const command = commandNamed(row.getAttribute('data-command') ?? '')
      expect(command, row.textContent ?? '').not.toBeNull()
      expect(row.querySelector('dt')?.textContent).toBe(menu.get(command as never))
      expect(row.querySelector('kbd')?.textContent).toBe(shortcutHint(command as never, MAC))
    }
  })
})

// The star is Help's and the About panel's, not the first screen's.
describe('the first screen', () => {
  it('asks nobody for a star', () => {
    seed({ projects: [] })
    mount()
    expect(screen.queryByRole('button', { name: 'Star on GitHub' })).toBeNull()
  })
})

// The zoom cross-fades: the class changing is what restarts the fade.
describe('a zoomed pane', () => {
  const split: Layout = {
    worktreeId: 'w1',
    root: {
      kind: 'split',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [
        { kind: 'leaf', terminalId: 't1' },
        { kind: 'leaf', terminalId: 't2' }
      ]
    },
    focusedTerminalId: 't2'
  }
  const panes = (): Element | null => document.querySelector('.workspace__panes')

  it('marks the panes zoomed while one fills them, and only then', () => {
    seed({ projects: [project], worktrees: [worktree()], activeWorktreeId: 'w1', layouts: { w1: split } })
    mount()
    expect(panes()?.className).toBe('workspace__panes')
    act(() => useWorkspaceStore.setState({ expandedTerminalId: 't2' }))
    expect(panes()?.className).toBe('workspace__panes workspace__panes--zoomed')
  })
})
