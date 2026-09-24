/** @vitest-environment jsdom */

// The sidebar, assembled: projects, your worktrees, and your teammates' worktrees under
// the same project. What is only true here is the wiring between the rows, and the
// three different sentences for having nothing to show.

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Project,
  TeammatePresence,
  TeammatePresenceRead,
  TeamworkStatus,
  Terminal,
  Worktree
} from '@shared/entities'

const call = vi.fn<(method: string, params: unknown) => Promise<unknown>>()
const watchPane = vi.fn()

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (method: string, params: unknown) => call(method, params),
    watchPane: (projectId: string, paneId: string) => watchPane(projectId, paneId),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { Sidebar } = await import('./Sidebar')
const { worktreeOrder } = await import('./worktreeOrder')

const INITIAL = useWorkspaceStore.getState()
const NOW = Date.now()

const project: Project = { id: 'p1', name: 'pager', path: '/repos/pager', baseRef: 'origin/main' }

const worktree = (overrides: Partial<Worktree> = {}): Worktree => ({
  id: 'w1',
  projectId: 'p1',
  name: 'Rewrite the pager',
  branch: 'rewrite-the-pager',
  path: '/repos/pager-wt/rewrite',
  startedFrom: 'origin/main',
  state: 'ready',
  createdAt: NOW,
  ...overrides
})

const presence = (overrides: Partial<TeammatePresenceRead> = {}): TeammatePresence => ({
  state: 'read',
  projectId: 'p1',
  worktrees: [],
  teammates: [],
  readAt: NOW,
  ...overrides
})

const theirWorktree = (handle: string, paneId: string) => ({
  id: `${handle}:w1`,
  projectId: 'p1',
  name: `${handle}'s task`,
  branch: `${handle}-task`,
  state: 'ready' as const,
  panes: [
    {
      id: paneId,
      title: 'claude',
      shell: '/bin/zsh',
      agent: 'claude' as const,
      running: true,
      busy: true,
      cols: 120,
      rows: 40,
      quietForMs: 0
    }
  ],
  handle,
  publicKey: `${handle}-key`,
  heardAt: NOW,
  live: true
})

const openDialog = vi.fn()
const toggleProject = vi.fn()
const openTeamwork = vi.fn()
const closeTeamwork = vi.fn()
const toggleDashboard = vi.fn()
const toggleSettings = vi.fn()
const toggleHelp = vi.fn()
const toggleSidebar = vi.fn()

function seed(overrides: Record<string, unknown> = {}): void {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      projects: [project],
      openDialog,
      toggleProject,
      openTeamwork,
      closeTeamwork,
      toggleDashboard,
      toggleSidebar,
      restoring: false,
      ...overrides
    },
    true
  )
}

const mount = (): void => {
  render(<Sidebar searchHint="⌘K" />)
}

beforeEach(() => {
  call.mockReset()
  call.mockRejectedValue(new Error('not asked for in this test'))
  watchPane.mockReset()
  watchPane.mockReturnValue(new Promise(() => {}))
  openDialog.mockReset()
  toggleProject.mockReset()
  openTeamwork.mockReset()
  closeTeamwork.mockReset()
  toggleDashboard.mockReset()
  toggleSidebar.mockReset()
  seed()
})

// The name lives in the sidebar's own header, beside the one control that puts the sidebar away.
describe('the sidebar’s own header', () => {
  it('carries the app name, in the sidebar rather than in a strip of its own', () => {
    mount()
    const header = document.querySelector('.sidebar__brand') as HTMLElement
    expect(header).toBeTruthy()
    expect(within(header).getByText('teamree')).toBeTruthy()
    expect(document.querySelector('.titlebar')).toBeNull()
  })

  // The chord is taught in four places already; a hover is not a fifth.
  it('puts the sidebar away from its own header, without naming a chord', () => {
    mount()
    const hide = screen.getByRole('button', { name: 'Hide sidebar' })
    expect(hide.getAttribute('title')).toBe('Hide sidebar')
    fireEvent.click(hide)
    expect(toggleSidebar).toHaveBeenCalledOnce()
  })

  // The header is the macOS drag region, so the button must opt out of it — a class the stylesheet keys on.
  it('keeps the control inside the header, where the drag region can exempt it', () => {
    mount()
    const header = document.querySelector('.sidebar__brand') as HTMLElement
    expect(within(header).getByRole('button', { name: 'Hide sidebar' })).toBeTruthy()
  })
})

describe('having nothing to show', () => {
  it('asks for a repository when there are no projects at all', () => {
    seed({ projects: [] })
    mount()
    expect(screen.getByText('No projects yet')).toBeTruthy()
  })

  it('says nothing about projects before the runtime has listed them', () => {
    seed({ projects: [], restoring: true })
    mount()
    expect(screen.queryByText('No projects yet')).toBeNull()
  })

  // The project row's New Task button is the way in; a sentence under it would be a second.
  it('draws nothing under a project with no worktrees', () => {
    mount()
    expect(screen.queryByText(/No worktrees yet/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start one' })).toBeNull()
    expect(document.querySelector('.project__none')).toBeNull()
  })

  // Never heard from is not away and not "no worktrees"; inventing a row would be inventing work.
  it('names teammates nothing has ever been heard from, without inventing rows for them', () => {
    seed({
      teammates: {
        p1: presence({
          teammates: [
            { handle: 'ana', publicKey: 'ana-key', connected: false, heardAt: null },
            { handle: 'bo', publicKey: 'bo-key', connected: false, heardAt: null }
          ]
        })
      }
    })
    mount()
    expect(screen.getByText('Nothing heard yet from ana, bo')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Watch/ })).toBeNull()
  })
})

describe('a project header', () => {
  // Open, the rows under it are the count.
  it('counts your worktrees and theirs apart only while folded', () => {
    const teammates = { p1: presence({ worktrees: [theirWorktree('priya', 'priya:t7')] }) }
    seed({ worktrees: [worktree()], teammates })
    mount()
    expect(screen.getByRole('treeitem', { expanded: true, name: /^pager/ }).textContent).toBe('pager')
    cleanup()
    seed({ worktrees: [worktree()], teammates, collapsedProjects: { p1: true } })
    mount()
    const toggle = screen.getByRole('treeitem', { expanded: false, name: /^pager/ })
    expect(within(toggle).getByText('1')).toBeTruthy()
    expect(within(toggle).getByText('+1')).toBeTruthy()
  })

  it('collapses, and says whether it is open', () => {
    seed({ worktrees: [worktree()], collapsedProjects: { p1: true } })
    mount()
    const toggle = screen.getByRole('treeitem', { expanded: false })
    expect(screen.queryByText('Rewrite the pager')).toBeNull()
    toggle.click()
    expect(toggleProject).toHaveBeenCalledExactlyOnceWith('p1')
  })

  const read = (overrides: Partial<Extract<TeamworkStatus, { state: 'read' }>> = {}): TeamworkStatus => ({
    state: 'read',
    projectId: 'p1',
    relay: null,
    disabledReason: null,
    origin: { ok: true, url: 'https://example.com/ada/pager.git' },
    enrolled: false,
    links: [],
    readAt: NOW,
    ...overrides
  })

  // `Teamwork · off` on every project was a fact nobody asked for; the rail still reaches the setup.
  it('says nothing about teamwork where it is off', () => {
    seed({ teamwork: { p1: read({ disabledReason: 'no .teamree/relay in this project' }) } })
    mount()
    expect(screen.queryByRole('button', { name: /Teamwork · off/ })).toBeNull()
    expect(document.querySelectorAll('.project__meta button')).toHaveLength(0)
  })

  it('says nothing about teamwork before anything has been read', () => {
    mount()
    expect(screen.queryByRole('button', { name: 'Teamwork in pager' })).toBeNull()
  })

  // Collapsing the causes into "offline" sends somebody to check their wifi because a colleague shut a laptop.
  it('says which of the ways teamwork is not working applies here, once it is on', () => {
    seed({ teamwork: { p1: read() } })
    mount()
    // One control, whose text is the state and whose hover is the reason.
    const control = screen.getByRole('button', { name: 'Teamwork · no key in pager' })
    expect(control.textContent).toBe('Teamwork · no key')
    expect(control.classList.contains('project__teamwork--off')).toBe(true)
    expect(document.querySelectorAll('.project__meta button')).toHaveLength(1)
  })

  // Named with the project: the rail has an entry of the same name, and two "Teamwork" buttons are one to a listener.
  it('opens the setup view for the project it belongs to', () => {
    seed({ teamwork: { p1: read() } })
    mount()
    screen.getByRole('button', { name: 'Teamwork · no key in pager' }).click()
    expect(openTeamwork).toHaveBeenCalledWith('p1')
  })

  it('lays the base ref and the teamwork control out as the one row under the name', () => {
    seed({ teamwork: { p1: read() } })
    mount()
    const meta = document.querySelector('.project__meta') as HTMLElement
    expect(meta.firstElementChild?.textContent).toBe('origin/main')
    expect(meta.lastElementChild).toBe(screen.getByRole('button', { name: 'Teamwork · no key in pager' }))
    expect(meta.children).toHaveLength(2)
  })

  it('starts a new task in the project the button belongs to', () => {
    mount()
    const add = screen.getByRole('button', { name: 'New Task in pager' })
    expect(add.getAttribute('title')).toBe('New Task')
    // Not the Projects header's plus, which adds a project.
    expect(add.innerHTML).not.toBe(screen.getByRole('button', { name: 'Add project' }).innerHTML)
    add.click()
    expect(openDialog).toHaveBeenCalledWith({ kind: 'new-task', projectId: 'p1' })
  })
})

// Selected by hover text: a pane button is labelled by its content ("claude"), so two teammates on
// the same agent are two identically named buttons. The text says what the next press would do.
const paneOf = (handle: string): HTMLElement => screen.getByTitle(new RegExp(`^(Watch|Stop watching) ${handle}`))

describe('watching a teammate’s pane', () => {
  const open = (): { projectId: string; paneId: string }[] =>
    useWorkspaceStore.getState().watches.map(({ projectId, paneId }) => ({ projectId, paneId }))

  beforeEach(() => {
    seed({
      teammates: {
        p1: presence({ worktrees: [theirWorktree('priya', 'priya:t7'), theirWorktree('ana', 'ana:t2')] })
      }
    })
    mount()
  })

  it('opens nothing until somebody asks for it', () => {
    expect(open()).toEqual([])
  })

  it('opens the pane that was pressed, on its own project', () => {
    act(() => paneOf('priya').click())
    expect(open()).toEqual([{ projectId: 'p1', paneId: 'priya:t7' }])
  })

  // A pane in the workspace is a pane, and a second one is a second pane.
  it('opens a second pane beside the first rather than replacing it', () => {
    act(() => paneOf('priya').click())
    act(() => paneOf('ana').click())
    expect(open()).toEqual([
      { projectId: 'p1', paneId: 'priya:t7' },
      { projectId: 'p1', paneId: 'ana:t2' }
    ])
  })

  // Keeps stopping reachable for somebody whose eye is on this list rather than the pane.
  it('stops watching when the same row is pressed again', () => {
    const row = (): HTMLElement => paneOf('priya')
    act(() => row().click())
    expect(row().getAttribute('aria-selected')).toBe('true')
    act(() => row().click())
    expect(open()).toEqual([])
    expect(row().getAttribute('aria-selected')).toBe('false')
  })

  it('goes on saying which rows are open once a pane is closed from the workspace', () => {
    act(() => paneOf('priya').click())
    act(() => paneOf('ana').click())
    act(() => useWorkspaceStore.getState().closeWatchedPane(useWorkspaceStore.getState().watches[0]!.id))
    expect(paneOf('priya').getAttribute('aria-selected')).toBe('false')
    expect(paneOf('ana').getAttribute('aria-selected')).toBe('true')
  })
})

// The CLI is a Settings concern: the row that leads to the fix carries the mark, and nothing
// else in the sidebar argues for itself.
describe('the CLI mark on Settings', () => {
  const badge = (): HTMLElement | null => document.querySelector('.rail__badge')

  it('is absent while there is nothing to fix', () => {
    mount()
    expect(badge()).toBeNull()
    expect(screen.queryByRole('button', { name: /PATH|teamree command/ })).toBeNull()
    expect(document.querySelector('.sidebar__foot')).toBeNull()
  })

  it('marks the Settings entry while the CLI is not linked to this build, and says why on hover', () => {
    seed({
      cli: {
        installable: true,
        packaged: true,
        state: 'absent',
        destination: '/usr/local/bin/teamree',
        directory: '/usr/local/bin',
        source: '/Applications/teamree.app/cli',
        bundle: '/Applications/teamree.app/cli.js',
        // Spelled out: the panel branches on `!== null`, so a seed omitting these describes a state the app never reports.
        impermanent: null,
        onPath: 'environment'
      },
      toggleSettings
    })
    mount()
    const mark = badge()
    expect(mark).toBeTruthy()
    expect(mark?.getAttribute('title')).toContain('/usr/local/bin/teamree')
    expect(mark?.getAttribute('aria-label')).toBe('Put teamree on my PATH')
    // Ink, not a coloured dot: colour is kept for what agents are doing.
    expect(mark?.textContent).toBe('!')
    // Inside the Settings entry, so pressing the mark is pressing Settings.
    const settings = screen.getByRole('button', { name: /Settings/ })
    expect(settings.contains(mark)).toBe(true)
    expect(document.querySelector('.sidebar__foot')).toBeNull()
    act(() => settings.click())
    expect(toggleSettings).toHaveBeenCalled()
  })

  it('goes as soon as it is linked', () => {
    seed({
      cli: {
        installable: true,
        state: 'linked',
        destination: '/usr/local/bin/teamree',
        source: '/Applications/teamree.app/cli',
        onPath: true
      }
    })
    mount()
    expect(badge()).toBeNull()
  })
})

// App-level places sit above the tree and say which one you are in without relying on a colour.
describe('the rail above the tree', () => {
  it('is a landmark of its own, separate from the tree', () => {
    mount()
    expect(screen.getByRole('navigation', { name: 'Go to' })).toBeTruthy()
  })

  // A field that filters this list would be a second, weaker search beside the real one.
  it('sends search to the palette rather than pretending to be one', () => {
    mount()
    const search = screen.getByRole('button', { name: 'Search worktrees and commands' })
    expect(search.textContent).toContain('⌘K')
    search.click()
    expect(openDialog).toHaveBeenCalledExactlyOnceWith({ kind: 'palette' })
  })

  it('goes to the teamwork setup for the project in hand', () => {
    mount()
    screen.getByRole('button', { name: 'Teamwork' }).click()
    expect(openTeamwork).toHaveBeenCalledExactlyOnceWith('p1')
  })

  it('says which destination you are in, and not only in colour', () => {
    seed({ teamworkProjectId: 'p1' })
    mount()
    expect(screen.getByRole('button', { name: 'Teamwork' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: 'All panes' }).getAttribute('aria-current')).toBeNull()
  })

  it('comes back from a destination you are already in', () => {
    seed({ teamworkProjectId: 'p1' })
    mount()
    screen.getByRole('button', { name: 'Teamwork' }).click()
    expect(closeTeamwork).toHaveBeenCalledOnce()
    expect(openTeamwork).not.toHaveBeenCalled()
  })

  it('goes to every pane in every worktree', () => {
    mount()
    screen.getByRole('button', { name: 'All panes' }).click()
    expect(toggleDashboard).toHaveBeenCalledOnce()
  })

  // Teamwork is set up per repository; with none added the entry says why.
  it('says why teamwork cannot be reached before a repository has been added', () => {
    seed({ projects: [] })
    mount()
    const teamwork = screen.getByRole('button', { name: 'Teamwork' }) as HTMLButtonElement
    expect(teamwork.disabled).toBe(true)
    expect(teamwork.getAttribute('title')).toBe('No projects yet')
  })
})

describe('the list itself', () => {
  it('is a landmark a reader can jump to', () => {
    mount()
    expect(screen.getByRole('navigation', { name: 'Projects and worktrees' })).toBeTruthy()
  })

  it('puts a teammate’s worktrees under the same project as your own', () => {
    seed({ worktrees: [worktree()], teammates: { p1: presence({ worktrees: [theirWorktree('priya', 'priya:t7')] }) } })
    mount()
    const list = document.querySelector('.project__worktrees') as HTMLElement
    expect(within(list).getByText('Rewrite the pager')).toBeTruthy()
    expect(within(list).getByText("priya's task")).toBeTruthy()
  })
})

// A surface with no entry in the rail and no row in the palette is one somebody has to already know about.
describe('the rail reaches the window-level surfaces', () => {
  it('opens settings from the rail', () => {
    seed({ settingsOpen: false, toggleSettings })
    mount()
    const entry = screen.getByRole('button', { name: /Settings/ })
    expect(entry.getAttribute('aria-current')).toBeNull()
    act(() => entry.click())
    expect(toggleSettings).toHaveBeenCalled()
  })

  it('opens the appearance sheet from the rail, and closes it from there too', () => {
    const showAppearance = vi.fn()
    seed({ showAppearance })
    const { unmount } = render(<Sidebar searchHint="⌘K" />)
    act(() => screen.getByRole('button', { name: /Appearance/ }).click())
    expect(showAppearance).toHaveBeenLastCalledWith(true)
    unmount()

    seed({ showAppearance, appearanceOpen: true })
    mount()
    const entry = screen.getByRole('button', { name: /Appearance/ })
    expect(entry.getAttribute('aria-pressed')).toBe('true')
    act(() => entry.click())
    expect(showAppearance).toHaveBeenLastCalledWith(false)
  })

  // Two ways in, one control: a menu under the +, not a dialog of two buttons.
  it('offers Open Folder… and Clone… under the projects +', () => {
    const chooseProjectFolder = vi.fn(() => Promise.resolve())
    seed({ chooseProjectFolder })
    mount()
    act(() => screen.getByRole('button', { name: 'Add project' }).click())
    const menu = screen.getByRole('menu', { name: 'Add project' })
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    ).toEqual(['Open Folder…', 'Clone…'])
    act(() => within(menu).getByRole('menuitem', { name: 'Open Folder…' }).click())
    expect(chooseProjectFolder).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()

    act(() => screen.getByRole('button', { name: 'Add project' }).click())
    act(() => screen.getByRole('menuitem', { name: 'Clone…' }).click())
    expect(openDialog).toHaveBeenCalledExactlyOnceWith({ kind: 'clone-project' })
  })

  it('marks settings as the page you are on while it has the area', () => {
    seed({ settingsOpen: true, toggleSettings })
    mount()
    expect(screen.getByRole('button', { name: /Settings/ }).getAttribute('aria-current')).toBe('page')
  })

  // The worktree's panes are not on screen under a page, so its row stops reading as selected.
  it('stands the open worktree down while any page holds the area', () => {
    for (const page of [
      { settingsOpen: true },
      { helpOpen: true },
      { dashboardOpen: true },
      { teamworkProjectId: 'p1' }
    ]) {
      seed({ worktrees: [worktree()], activeWorktreeId: 'w1', ...page })
      mount()
      expect(document.querySelector('.sidebar')?.classList.contains('sidebar--page'), JSON.stringify(page)).toBe(true)
      cleanup()
    }
    seed({ worktrees: [worktree()], activeWorktreeId: 'w1' })
    mount()
    expect(document.querySelector('.sidebar')?.classList.contains('sidebar--page')).toBe(false)
    expect(document.querySelector('.worktree--active')).toBeTruthy()
  })

  // The window has too many places explaining shortcuts; the search field keeps its one.
  it('draws no chord on any rail row but the search', () => {
    seed({ toggleHelp })
    mount()
    expect(screen.getByRole('button', { name: /Help/ }).querySelector('kbd')).toBeNull()
    expect(screen.getByRole('button', { name: /Settings/ }).querySelector('kbd')).toBeNull()
    expect(screen.getByRole('button', { name: /Appearance/ }).querySelector('kbd')).toBeNull()
    expect(document.querySelectorAll('.rail kbd')).toHaveLength(1)
    act(() => screen.getByRole('button', { name: /Help/ }).click())
    expect(toggleHelp).toHaveBeenCalled()
  })
})

// `worktreeOrder.test.ts` proves the function groups by project; only a rendered sidebar can say
// the function is what the sidebar renders.
describe('the order the chords walk', () => {
  it('is the order the rows are drawn in', () => {
    const projects = [project, { id: 'p2', name: 'relay', path: '/repos/relay', baseRef: 'origin/main' }]
    // Interleaved, which is how a runtime answer arrives.
    const worktrees = [
      worktree({ id: 'w1', projectId: 'p1', name: 'one' }),
      worktree({ id: 'w2', projectId: 'p2', name: 'two' }),
      worktree({ id: 'w3', projectId: 'p1', name: 'three' }),
      worktree({ id: 'w4', projectId: 'p2', name: 'four' })
    ]
    seed({ projects, worktrees })
    const { container } = render(<Sidebar searchHint="⌘K" />)

    const drawn = [...container.querySelectorAll('.worktree__name')].map((node) => node.textContent)
    expect(drawn).toEqual(['one', 'three', 'two', 'four'])
    expect(drawn).toEqual(worktreeOrder(projects, worktrees).map((entry) => entry.name))
  })
})

// The menu itself is `WorktreeRow.test.tsx`'s; what is only true here is that an item acts on
// the right worktree with the right project's editor.
describe('the row menu acts on the worktree it was opened on', () => {
  const openMenu = (): void => {
    mount()
    fireEvent.contextMenu(document.querySelector('.worktree') as HTMLElement)
  }

  it('puts the checkout path on the clipboard', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    seed({ worktrees: [worktree()] })
    openMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Path' }))
    await act(async () => undefined)

    expect(writeText).toHaveBeenCalledWith('/repos/pager-wt/rewrite')
    expect(useWorkspaceStore.getState().notices.at(-1)?.text).toContain('Copied')
  })

  it('copies the branch rather than the path when that is what was chosen', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    seed({ worktrees: [worktree()] })
    openMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Branch' }))
    await act(async () => undefined)

    expect(writeText).toHaveBeenCalledWith('rewrite-the-pager')
  })

  /** What a mouse actually sends an element, in the order it sends it. */
  const mouseClick = (target: Element): void => {
    fireEvent.pointerDown(target, { button: 0, pointerType: 'mouse' })
    fireEvent.mouseDown(target, { button: 0 })
    fireEvent.pointerUp(target, { button: 0, pointerType: 'mouse' })
    fireEvent.mouseUp(target, { button: 0 })
    fireEvent.click(target, { button: 0, detail: 1 })
  }

  // Reported as doing nothing, through a driver that sends press and release with no click count,
  // which never makes a click event; a mouse does, and the press lands inside the menu.
  it('asks about removing the worktree when Remove Worktree… is clicked with a mouse', async () => {
    seed({ worktrees: [worktree()] })
    mount()
    mouseClick(screen.getByRole('button', { name: 'More for Rewrite the pager' }))
    expect(screen.getByRole('menu', { name: 'Actions for Rewrite the pager' })).toBeTruthy()

    mouseClick(screen.getByRole('menuitem', { name: 'Remove Worktree…' }))
    await act(async () => undefined)

    expect(screen.queryByRole('menu')).toBeNull()
    expect(useWorkspaceStore.getState().dialog).toMatchObject({ kind: 'confirm-remove', worktreeId: 'w1' })
    expect(useWorkspaceStore.getState().worktrees).toHaveLength(1)
  })

  it('puts the name field up when the palette asks, and takes the request back', () => {
    seed({ worktrees: [worktree(), worktree({ id: 'w2', name: 'other' })] })
    mount()
    act(() => useWorkspaceStore.getState().editWorktreeName('w2'))

    expect((screen.getByRole('textbox', { name: 'Worktree name' }) as HTMLInputElement).value).toBe('other')
    expect(useWorkspaceStore.getState().editingWorktreeName).toBeNull()
  })

  it('renames the worktree it was opened on, and the row says the new name', async () => {
    call.mockImplementation(async (method, params) =>
      method === 'worktree.rename' ? worktree({ name: (params as { name: string }).name }) : undefined
    )
    seed({ worktrees: [worktree(), worktree({ id: 'w2', name: 'other' })] })
    mount()
    mouseClick(screen.getByRole('button', { name: 'More for Rewrite the pager' }))
    mouseClick(screen.getByRole('menuitem', { name: 'Rename…' }))

    const field = screen.getByRole('textbox', { name: 'Worktree name' })
    fireEvent.change(field, { target: { value: 'pager, the winner' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await act(async () => undefined)

    expect(call).toHaveBeenCalledWith('worktree.rename', { worktreeId: 'w1', name: 'pager, the winner' })
    expect(screen.getByRole('treeitem', { name: /^pager, the winner/ })).toBeTruthy()
    expect(useWorkspaceStore.getState().worktrees.map((entry) => entry.name)).toEqual(['pager, the winner', 'other'])
  })

  // Picking the better run is why a task fans out; a lone run has nothing to be compared with.
  it('offers a task’s run its siblings under Compare with, and opens the one chosen beside it', () => {
    const TASK = 'Add a sub function to src/math.ts'
    const run = (id: string, agent: string): Worktree =>
      worktree({ id, name: `${TASK} ${agent}`, branch: `add-a-sub-${agent}`, task: TASK })
    const openCompare = vi.fn(async () => {})
    seed({ worktrees: [run('w-claude', 'claude'), run('w-codex', 'codex'), worktree()], openCompare })
    mount()
    const [, codex, lone] = [...document.querySelectorAll('.worktree')] as HTMLElement[]

    fireEvent.contextMenu(lone!)
    expect(screen.queryByRole('menuitem', { name: 'Compare with' })).toBeNull()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

    fireEvent.contextMenu(codex!)
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Compare with' }))
    const runs = screen.getByRole('menu', { name: 'Compare with' })
    expect(
      within(runs)
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    ).toEqual(['claude'])
    fireEvent.click(within(runs).getByRole('menuitem', { name: 'claude' }))
    expect(openCompare).toHaveBeenCalledWith('w-codex', 'w-claude', 'codex vs claude')
  })

  const INSTALLED = [
    { command: 'com.microsoft.VSCode', label: 'VS Code', kind: 'editor' as const },
    { command: 'dev.zed.Zed', label: 'Zed', kind: 'editor' as const },
    { command: 'com.googlecode.iterm2', label: 'iTerm', kind: 'terminal' as const },
    { command: 'com.apple.finder', label: 'Finder', kind: 'finder' as const }
  ]
  const openIn = (): string[] => {
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Open in' }))
    return within(screen.getByRole('menu', { name: 'Open in' }))
      .getAllByRole('menuitem')
      .map((item) => item.textContent ?? '')
  }

  // Nothing else in the window pairs the project's editor with the worktree's path.
  it('offers what is installed, this project’s editor first', () => {
    seed({ worktrees: [worktree()], editors: INSTALLED, editorCommands: { p1: 'dev.zed.Zed' } })
    openMenu()

    expect(openIn()).toEqual(['Zed', 'VS Code', 'iTerm', 'Finder'])
  })

  it('opens the checkout in the app picked, and remembers an editor as this project’s', async () => {
    call.mockResolvedValue({ opened: true, editor: 'VS Code' })
    seed({ worktrees: [worktree()], editors: INSTALLED })
    openMenu()
    openIn()
    fireEvent.click(screen.getByRole('menuitem', { name: 'VS Code' }))
    await act(async () => undefined)

    expect(call).toHaveBeenCalledWith('editor.open', {
      path: '/repos/pager-wt/rewrite',
      command: 'com.microsoft.VSCode'
    })
    expect(useWorkspaceStore.getState().editorCommands).toEqual({ p1: 'com.microsoft.VSCode' })
  })

  it('does not make a terminal the project’s editor', async () => {
    call.mockResolvedValue({ opened: true, editor: 'iTerm' })
    seed({ worktrees: [worktree()], editors: INSTALLED, editorCommands: { p1: 'dev.zed.Zed' } })
    openMenu()
    openIn()
    fireEvent.click(screen.getByRole('menuitem', { name: 'iTerm' }))
    await act(async () => undefined)

    expect(call).toHaveBeenCalledWith('editor.open', {
      path: '/repos/pager-wt/rewrite',
      command: 'com.googlecode.iterm2'
    })
    expect(useWorkspaceStore.getState().editorCommands).toEqual({ p1: 'dev.zed.Zed' })
  })

  it('offers a program this project names itself, first', async () => {
    call.mockResolvedValue({ opened: true, editor: 'mate' })
    seed({ worktrees: [worktree()], editors: INSTALLED, editorCommands: { p1: 'mate' } })
    openMenu()

    expect(openIn()[0]).toBe('mate')
    fireEvent.click(screen.getByRole('menuitem', { name: 'mate' }))
    await act(async () => undefined)
    expect(call).toHaveBeenCalledWith('editor.open', { path: '/repos/pager-wt/rewrite', command: 'mate' })
  })

  // A refusal is the ordinary answer on a machine with no editor set up, and it has to reach the screen.
  it('says why nothing opened', async () => {
    call.mockResolvedValue({ opened: false, reason: 'no editor found' })
    seed({ worktrees: [worktree()], editors: [] })
    openMenu()

    expect(openIn()).toEqual(['Editor'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Editor' }))
    await act(async () => undefined)

    expect(call).toHaveBeenCalledWith('editor.open', { path: '/repos/pager-wt/rewrite' })
    expect(useWorkspaceStore.getState().notices.at(-1)?.text).toContain('no editor found')
  })
})

// Two agents on one task were "Add a subtract function to c…" twice at the sidebar's width.
describe('several runs of one task', () => {
  it('leads each with its agent, then the whole task line, and names it task first in words', () => {
    const task = 'Add a subtract function to src/math.ts'
    seed({
      worktrees: [
        worktree({
          id: 'w1',
          name: 'Add a subtract function to claude',
          branch: 'add-a-subtract-function-to-claude',
          task
        }),
        worktree({
          id: 'w2',
          name: 'Add a subtract function to codex',
          branch: 'add-a-subtract-function-to-codex',
          task
        })
      ]
    })
    mount()
    const heads = [...document.querySelectorAll('.worktree__title')]
    expect(heads.map((head) => head.querySelector('.worktree__agent')?.textContent)).toEqual(['', ''])
    expect(
      heads.map((head) => head.querySelector('.worktree__agent [data-agent]')?.getAttribute('data-agent'))
    ).toEqual(['claude', 'codex'])
    expect(heads.map((head) => head.querySelector('.worktree__name')?.textContent)).toEqual([task, task])
    expect(screen.getByRole('treeitem', { name: `${task} (Claude Code)` })).toBeTruthy()
    // The branch line said the name again, slugified.
    expect(screen.queryByText('add-a-subtract-function-to-claude')).toBeNull()
  })

  // The glyph tells claude from codex; only a second claude run needs its word to be told apart.
  it('drops the agent word where the glyph alone tells the runs apart', () => {
    const task = 'Add a subtract function to src/math.ts'
    const run = (id: string, name: string): Worktree =>
      worktree({ id, name, branch: name.toLowerCase().replaceAll(' ', '-'), task })
    const agentPane = (id: string, worktreeId: string, agent: 'claude' | 'codex'): Terminal => ({
      id,
      worktreeId,
      title: 'node',
      cwd: '/repos/pager-wt',
      shell: '/bin/zsh',
      cols: 80,
      rows: 24,
      running: true,
      busy: false,
      lastOutputAt: 0,
      agent,
      ordinal: 1
    })
    seed({
      worktrees: [
        run('w1', 'Add a subtract function to claude'),
        run('w2', 'Add a subtract function to claude 2'),
        run('w3', 'Add a subtract function to codex')
      ],
      terminals: {
        a: agentPane('a', 'w1', 'claude'),
        b: agentPane('b', 'w2', 'claude'),
        c: agentPane('c', 'w3', 'codex')
      }
    })
    mount()
    const words = [...document.querySelectorAll('.worktree__agent')].map((slot) => slot.textContent)
    expect(words).toEqual(['Claude Code', 'Claude Code 2', ''])
  })
})

// One Tab stop however many rows, and the arrows between them, as a Finder list or a source list.
describe('the tree from the keyboard', () => {
  const pane = { worktreeId: 'w1', cwd: '/repos/pager-wt/rewrite', shell: '/bin/zsh', cols: 80, rows: 24 }
  const terminals = {
    t1: { ...pane, id: 't1', title: 'zsh', running: true, busy: false, lastOutputAt: NOW },
    t2: { ...pane, id: 't2', title: 'claude', running: true, busy: true, lastOutputAt: NOW }
  }
  const items = (): HTMLElement[] => screen.getAllByRole('treeitem')
  const names = (): string[] => items().map((item) => item.textContent?.trim().split(/\s/)[0] ?? '')
  const stops = (): HTMLElement[] => items().filter((item) => item.tabIndex === 0)
  const press = (key: string): void => {
    fireEvent.keyDown(document.activeElement as HTMLElement, { key })
  }

  beforeEach(() => {
    seed({
      worktrees: [worktree(), worktree({ id: 'w2', name: 'Second', branch: 'second' })],
      activeWorktreeId: 'w2',
      terminals
    })
    mount()
  })

  it('is a tree of projects, worktrees and panes', () => {
    expect(screen.getByRole('tree', { name: 'Worktrees' })).toBeTruthy()
    const levels = items().map((item) => item.getAttribute('aria-level'))
    expect(levels).toEqual(['1', '2', '3', '3', '2'])
  })

  it('is one Tab stop, on the open worktree until another row is focused', () => {
    expect(stops()).toHaveLength(1)
    expect(stops()[0]?.textContent).toContain('Second')
    act(() => items()[0]?.focus())
    expect(stops()).toEqual([items()[0]])
  })

  it('walks the rows with ↑ and ↓, and jumps with Home and End', () => {
    act(() => items()[0]?.focus())
    press('ArrowDown')
    expect(document.activeElement).toBe(items()[1])
    press('ArrowDown')
    expect(document.activeElement).toBe(items()[2])
    press('ArrowUp')
    expect(document.activeElement).toBe(items()[1])
    press('End')
    expect(document.activeElement).toBe(items()[4])
    press('Home')
    expect(document.activeElement).toBe(items()[0])
    expect(stops()).toEqual([items()[0]])
  })

  it('goes into a row’s children on →, and back to its parent on ←', () => {
    act(() => items()[1]?.focus())
    press('ArrowRight')
    expect(document.activeElement).toBe(items()[2])
    press('ArrowLeft')
    expect(document.activeElement).toBe(items()[1])
    // The worktree folds first; the next ← goes up to the project.
    press('ArrowLeft')
    expect(items()).toHaveLength(3)
    press('ArrowLeft')
    expect(document.activeElement).toBe(items()[0])
  })

  it('folds and unfolds a project on ← and →', () => {
    act(() => items()[0]?.focus())
    press('ArrowLeft')
    expect(toggleProject).toHaveBeenCalledExactlyOnceWith('p1')
  })

  it('takes the other controls in it off the Tab order', () => {
    const tree = screen.getByRole('tree')
    const tabbable = [...tree.querySelectorAll<HTMLElement>('button, [tabindex]')].filter((node) => node.tabIndex >= 0)
    expect(tabbable).toHaveLength(1)
    expect(names()).toContain('Second')
  })
})

describe('starting a task in any project from the keyboard', () => {
  const other: Project = { id: 'p2', name: 'ledger', path: '/repos/ledger', baseRef: 'origin/main' }
  const projectRow = (name: string): HTMLElement =>
    screen
      .getAllByRole('treeitem')
      .find((item) => item.getAttribute('aria-level') === '1' && item.textContent?.includes(name)) as HTMLElement

  beforeEach(() => {
    seed({
      projects: [project, other],
      worktrees: [worktree(), worktree({ id: 'w2', projectId: 'p2', name: 'Balance the books', branch: 'balance' })],
      activeWorktreeId: 'w1'
    })
    mount()
  })

  it.each([
    ['⇧F10', { key: 'F10', shiftKey: true }],
    ['the menu key', { key: 'ContextMenu' }]
  ])('offers New Task… on %s from a project row, in that project', (_, key) => {
    const row = projectRow('ledger')
    act(() => row.focus())
    fireEvent.keyDown(row, key)
    const menu = screen.getByRole('menu', { name: 'Actions for ledger' })
    const item = within(menu).getByRole('menuitem', { name: 'New Task…' })
    expect(document.activeElement).toBe(item)
    fireEvent.keyDown(item, { key: 'Enter' })
    expect(openDialog).toHaveBeenCalledExactlyOnceWith({ kind: 'new-task', projectId: 'p2' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens the same menu on a right-click', () => {
    fireEvent.contextMenu(projectRow('ledger'), { clientX: 40, clientY: 60, detail: 1 })
    within(screen.getByRole('menu', { name: 'Actions for ledger' }))
      .getByRole('menuitem', { name: 'New Task…' })
      .click()
    expect(openDialog).toHaveBeenCalledExactlyOnceWith({ kind: 'new-task', projectId: 'p2' })
  })

  it("lists the project's recently removed worktrees in its menu, and restores the one chosen", () => {
    const restoreWorktree = vi.fn()
    const loadRemovedWorktrees = vi.fn(async () => {})
    cleanup()
    seed({
      projects: [project, other],
      worktrees: [worktree()],
      restoreWorktree,
      loadRemovedWorktrees,
      removedWorktrees: [
        {
          id: 'w9/2',
          projectId: 'p2',
          worktreeId: 'w9',
          name: 'Add a sub function',
          branch: 'add-sub',
          removedAt: Date.now() - 180_000
        },
        { id: 'w8/1', projectId: 'p1', worktreeId: 'w8', name: 'Elsewhere', branch: 'elsewhere', removedAt: 1 }
      ]
    })
    mount()
    fireEvent.contextMenu(projectRow('ledger'), { clientX: 40, clientY: 60, detail: 1 })
    expect(loadRemovedWorktrees).toHaveBeenCalledOnce()
    const menu = screen.getByRole('menu', { name: 'Actions for ledger' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Recently Removed' }))
    const removed = screen.getByRole('menu', { name: 'Recently Removed' })
    expect(
      within(removed)
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    ).toEqual(['Add a sub function3m ago'])
    fireEvent.click(within(removed).getByRole('menuitem', { name: 'Add a sub function' }))
    expect(restoreWorktree).toHaveBeenCalledExactlyOnceWith('p2', 'w9/2')
  })

  it('makes ⌘N start in the project whose row has the focus', async () => {
    const { runWorkspaceCommand } = await import('../keyboard/workspaceCommands')
    act(() => projectRow('ledger').focus())
    runWorkspaceCommand('new-worktree', useWorkspaceStore.getState())
    expect(openDialog).toHaveBeenLastCalledWith({ kind: 'new-task', projectId: 'p2' })
  })

  it('makes ⌘N start in the project of a focused worktree row, not the open one', async () => {
    const { runWorkspaceCommand } = await import('../keyboard/workspaceCommands')
    const row = screen.getAllByRole('treeitem').find((item) => item.textContent?.includes('Balance the books'))
    act(() => row?.focus())
    runWorkspaceCommand('new-worktree', useWorkspaceStore.getState())
    expect(openDialog).toHaveBeenLastCalledWith({ kind: 'new-task', projectId: 'p2' })
  })

  it('leaves ⌘N on the open worktree’s project with the focus outside the tree', async () => {
    const { runWorkspaceCommand } = await import('../keyboard/workspaceCommands')
    act(() => screen.getByRole('button', { name: 'Add project' }).focus())
    runWorkspaceCommand('new-worktree', useWorkspaceStore.getState())
    expect(openDialog).toHaveBeenLastCalledWith({ kind: 'new-task', projectId: 'p1' })
  })
})
