/** @vitest-environment jsdom */

// The surface somebody is actually looking at when there is nothing to look at.
//
// Three quite different situations all produce an empty right-hand side, and
// the app is only honest if it tells them apart: a runtime that never came up,
// a first run with no repository, and a window with worktrees but none open.
// Getting that wrong is the worst failure in the app that is not a crash — a
// dead runtime rendered as an ordinary empty state leaves somebody pressing
// chords at a window that will never answer.
//
// The header that used to sit over the panes is here too, as an absence. It
// was two lines once — a name, sixty characters of path, six buttons — then one
// line of two counts, and now nothing: every fact it carried is printed by the
// sidebar's selected row, the status bar or the row's menu, so the area over a
// worktree is its panes and nothing else.
//
// And the slot a teammate's pane takes beside all of it. That pane used to
// float over the window; the thing to prove now is that it is laid out as an
// ordinary sibling of the workspace — a cell with a gutter, which is what makes
// it draggable — and that it stays put through the navigations that replace
// everything else in this area, because unmounting it would close and reopen a
// stream nobody stopped watching.

import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Layout, Project, Worktree, WorktreeStatus } from '@shared/entities'
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
// Standing in for the whole viewer, which is exercised in its own file: what
// this one decides is which panes exist and where they sit, not what is in them.
vi.mock('../terminal/WatchedPaneView', () => ({
  WatchedPaneView: ({ handle, paneId }: { handle: string; paneId: string }) => (
    <div data-testid={`watched-${handle}-${paneId}`} />
  )
}))
vi.mock('./rightPanel/RightPanel', () => ({ RightPanel: () => null }))
vi.mock('../dashboard/Dashboard', () => ({ Dashboard: () => <div data-testid="dashboard" /> }))
// Both have their own files. What this one decides is that they take the area
// at all, which is the part that lives here.
vi.mock('../settings/SettingsView', () => ({ SettingsView: () => <div data-testid="settings" /> }))
vi.mock('../help/HelpView', () => ({ HelpView: () => <div data-testid="help" /> }))
// The strip above the panes is `TerminalTabs` now — one tab per pane in the
// worktree on screen, where it used to be one per open worktree.
vi.mock('./TerminalTabs', () => ({ TerminalTabs: () => null }))
// jsdom has no browser to open; what matters is that the welcome asks the one
// path that does.
vi.mock('../shell/openInBrowser', () => ({ openInBrowser: vi.fn() }))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { WorkspaceArea } = await import('./WorkspaceArea')

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
  // The status bar says this in three words at the bottom of the screen. This
  // is where somebody is looking, and every shortcut the ordinary empty state
  // would offer is inert.
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

  // A dead runtime outranks a first run: with nothing answering, "add project"
  // is a button that cannot work.
  it('prefers the dead runtime to the welcome when both are true', () => {
    seed({ projects: [], connection: { phase: 'offline' } })
    mount()
    expect(screen.queryByRole('button', { name: 'Add project' })).toBeNull()
  })

  // The genuine first run: the mark, the name, and the one action that can
  // work. A task needs a project to make its worktree in, so that button waits.
  it('welcomes a first run with the mark and the one action that can work', () => {
    seed({ projects: [] })
    mount()
    expect(document.querySelector('.welcome .brand__mark')).toBeTruthy()
    expect(screen.getByText('teamree')).toBeTruthy()
    expect(screen.queryByRole('heading')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }))
    expect(openDialog).toHaveBeenCalledExactlyOnceWith({ kind: 'add-project' })
    expect((screen.getByRole('button', { name: 'New task' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'New terminal' })).toBeNull()
  })

  // The same welcome once there is a project, with the task button live: the
  // composer is where an agent is chosen, so nothing here names one.
  it('offers a new task in the project once there is one, and no agent by name', () => {
    seed({ projects: [project], agents: [{ kind: 'claude', command: 'claude', binary: '/usr/local/bin/claude' }] })
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    expect(openDialog).toHaveBeenCalledExactlyOnceWith({ kind: 'new-task', projectId: 'p1' })
    expect(screen.queryByRole('button', { name: /^Start / })).toBeNull()
    expect(screen.queryByRole('button', { name: 'New terminal' })).toBeNull()
  })

  it('names the chords once there is a project for them to act on', () => {
    seed({ projects: [project] })
    mount()
    const keys = [...document.querySelectorAll('.welcome kbd')].map((node) => node.textContent)
    expect(keys).toEqual(['⌘N', '⌘K', '⌘B'])
  })

  it('shows the teamwork setup instead of any of that when it has the area', () => {
    seed({ projects: [project], teamworkProjectId: 'p1' })
    mount()
    expect(screen.getByRole('main', { name: 'Set up teamwork in pager' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add project' })).toBeNull()
  })

  it('shows the dashboard instead of any of that when it is open', () => {
    seed({ projects: [], dashboardOpen: true })
    mount()
    expect(screen.getByTestId('dashboard')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add project' })).toBeNull()
  })
})

describe('a worktree with no panes in it', () => {
  it('offers nothing to start while the checkout is still being prepared', () => {
    seed({
      projects: [project],
      worktrees: [worktree({ state: 'creating' })],
      activeWorktreeId: 'w1'
    })
    mount()
    expect(screen.getByRole('button', { name: 'Add project' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'New terminal' })).toBeNull()
  })

  // The owner's note on the old state: "it should be like create project or
  // open project, no need to have buttons for claude, codex". A terminal is a
  // different thing from an agent, so it stays; the agents are the composer's
  // and the panes tab's to offer.
  it('offers a plain terminal once the checkout is ready, and no agent by name', () => {
    seed({
      projects: [project],
      worktrees: [worktree()],
      activeWorktreeId: 'w1',
      agents: [{ kind: 'claude', command: 'claude', binary: '/usr/local/bin/claude' }]
    })
    mount()
    expect(screen.queryByRole('button', { name: 'Start claude' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'New terminal' }))
    expect(createTerminal).toHaveBeenCalledWith('w1')
    expect(startAgent).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    expect(openDialog).toHaveBeenCalledExactlyOnceWith({ kind: 'new-task', projectId: 'p1' })
  })

  // Ready on paper, gone from disk: a terminal offered here would fail with a
  // path, which is the notice this whole shape was found by.
  it('offers no terminal in a worktree whose checkout is missing', () => {
    seed({ projects: [project], worktrees: [worktree({ missing: true })], activeWorktreeId: 'w1' })
    mount()
    expect(screen.queryByRole('button', { name: 'New terminal' })).toBeNull()
    expect(screen.getByRole('button', { name: 'New task' })).toBeTruthy()
  })
})

// The header row that sat between the strip and the panes is gone: a name the
// sidebar's selected row and the status bar both already print, a folder icon
// the row menu already carries, and two counts the status bar already reads.
// The area over a worktree is its panes and nothing else.
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

// One main area, and the two pages added to it are read rather than worked in.
// The empty state is where somebody with nothing open goes looking for either,
// so it carries a way to both rather than only a chord to memorise.
describe('settings and help', () => {
  it('gives the area to settings, ahead of the empty state somebody opened it from', () => {
    seed({ projects: [project], settingsOpen: true })
    mount()
    expect(screen.getByTestId('settings')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add project' })).toBeNull()
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

  // No gutter and no second cell: a window nobody is watching from must look
  // exactly as it did before any of this existed.
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

  // The claim the whole change rests on: it is resized by the same handle, the
  // same arithmetic and the same arrow keys as two of your own panes, because
  // it is literally the same component doing it.
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
    // jsdom has no layout, so the axis a drag divides has to be stated.
    const split = document.querySelector('.workspace-split') as HTMLElement
    Object.defineProperty(split, 'clientWidth', { get: () => 1000 })
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' })
    const [sizes] = setWatchSizes.mock.calls[0] as [number[]]
    expect(sizes).toHaveLength(2)
    expect(sizes[0] ?? 1).toBeLessThan(0.5)
    expect((sizes[0] ?? 0) + (sizes[1] ?? 0)).toBeCloseTo(1)
  })

  // Every navigation in this area replaces what is under it. A watched pane
  // that went with it would close its subscription and reopen it on the way
  // back, which is the relay budget paid twice for a pane nobody closed.
  it('stays where it is when the pane board takes the area', () => {
    openWorktreeWith([watch('priya', 'priya:t7')])
    act(() => {
      useWorkspaceStore.setState({ dashboardOpen: true })
    })
    expect(screen.getByTestId('dashboard')).toBeTruthy()
    expect(screen.getByTestId('watched-priya-priya:t7')).toBeTruthy()
  })

  // The other navigation that takes the whole area, and the one most likely to
  // be running for minutes at a time: a push streams its progress here while
  // somebody watches a teammate work beside it. The setup panel is a cell of
  // the same split for exactly that reason, rather than a layer over it.
  it('stays where it is when teamwork setup takes the area', () => {
    openWorktreeWith([watch('priya', 'priya:t7')])
    act(() => {
      useWorkspaceStore.setState({ teamworkProjectId: 'p1' })
    })
    expect(screen.getByRole('main', { name: 'Set up teamwork in pager' })).toBeTruthy()
    expect(screen.getByTestId('watched-priya-priya:t7')).toBeTruthy()
  })

  // The window somebody is most likely to be watching a teammate from is the
  // one with nothing of their own open.
  it('stays where it is with no worktree open at all', () => {
    seed({ projects: [project], watches: [watch('priya', 'priya:t7')] })
    mount()
    expect(screen.getByRole('button', { name: 'Add project' })).toBeTruthy()
    expect(screen.getByTestId('watched-priya-priya:t7')).toBeTruthy()
  })
})

// The list under the welcome names each command the way the menu bar names it,
// and it is generated from the same table, so a rebind or a rename in one
// place cannot leave a stale word here. One wording per command — and no more
// than three rows, because this is the one surface in the window that teaches
// chords besides the menu bar, the palette and the help page.
describe('the welcome’s shortcut list and the menu bar use one set of words', () => {
  it('names every command exactly as the menu bar names it, with its chord', async () => {
    const { menuBarSpec } = await import('../menu/menuBar')
    const { commandNamed, shortcutHint } = await import('../keyboard/workspaceShortcuts')
    seed({ projects: [project], worktrees: [] })
    mount()

    const menu = new Map(menuBarSpec(useWorkspaceStore.getState()).map((item) => [item.command, item.label]))
    const rows = [...document.querySelectorAll('.welcome__shortcuts > div')]
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      const command = commandNamed(row.getAttribute('data-command') ?? '')
      expect(command, row.textContent ?? '').not.toBeNull()
      expect(row.querySelector('dt')?.textContent).toBe(menu.get(command as never))
      expect(row.querySelector('kbd')?.textContent).toBe(shortcutHint(command as never, MAC))
    }
  })
})

// Under the shortcuts and quiet, because it is not what the window is for.
// Through the one path anything here takes to the browser, so the main
// process's answer about where a link may go is the answer here too.
describe('the star', () => {
  it('opens the repository through the window’s one browser path', async () => {
    const { openInBrowser } = await import('../shell/openInBrowser')
    seed({ projects: [] })
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Star on GitHub' }))
    expect(openInBrowser).toHaveBeenCalledExactlyOnceWith('https://github.com/zero-abd/teamree')
  })
})
