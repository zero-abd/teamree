/** @vitest-environment jsdom */

// The sidebar, assembled: projects, your worktrees, and your teammates'
// worktrees under the same project.
//
// The rows have their own files. What is only true here is the wiring between
// them — that pressing a teammate's pane opens *that* pane, that pressing it
// again closes it rather than opening a second one, and that the row goes on
// saying which of them this window has open.
//
// The pane itself is not here any more. It used to be: a card this component
// rendered, floating over the whole window, which is what made it the one
// surface in the app that could not be moved, resized or closed the way
// everything else can. It is a pane in the workspace now, held in the store, so
// what the sidebar is responsible for is the decision rather than the window.
//
// It is also where the several ways of having nothing to show are kept apart:
// no projects, no worktrees, and a teammate on the roster nothing has ever been
// heard from are three different sentences.

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, TeammatePresence, TeammatePresenceRead, TeamworkStatus, Worktree } from '@shared/entities'

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
      ...overrides
    },
    true
  )
}

const mount = (): void => {
  render(<Sidebar newWorktreeHint="⌘N" searchHint="⌘K" settingsHint="⌘," helpHint="⌘/" sidebarHint="⌘B" />)
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

// The app's name used to sit in a strip of its own across the whole window,
// above the sidebar and the panes alike. The strip is gone: the sidebar's own
// header is where the name lives now, beside the one control that puts the
// sidebar away, and the window buttons sit on the same row.
describe('the sidebar’s own header', () => {
  it('carries the app name, in the sidebar rather than in a strip of its own', () => {
    mount()
    const header = document.querySelector('.sidebar__brand') as HTMLElement
    expect(header).toBeTruthy()
    expect(within(header).getByText('teamree')).toBeTruthy()
    expect(document.querySelector('.titlebar')).toBeNull()
  })

  it('puts the sidebar away from its own header, and names the chord that does the same', () => {
    mount()
    const hide = screen.getByRole('button', { name: 'Hide sidebar' })
    expect(hide.getAttribute('title')).toBe('Hide sidebar · ⌘B')
    fireEvent.click(hide)
    expect(toggleSidebar).toHaveBeenCalledOnce()
  })

  // The header is what the window is dragged by on macOS, so the button in it
  // has to opt back out of the drag region — a class the stylesheet keys on.
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

  it('offers to start one when a project has no worktrees', () => {
    mount()
    expect(screen.getByText(/No worktrees yet/)).toBeTruthy()
    screen.getByRole('button', { name: 'Start one' }).click()
    expect(openDialog).toHaveBeenCalledWith({ kind: 'new-task', projectId: 'p1' })
  })

  // On the roster and never heard from is not the same as away, and not the
  // same as having no worktrees — inventing a row for them would be inventing
  // work.
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
  it('counts your worktrees and theirs apart, because they are not the same thing', () => {
    seed({ worktrees: [worktree()], teammates: { p1: presence({ worktrees: [theirWorktree('priya', 'priya:t7')] }) } })
    mount()
    const toggle = screen.getByRole('button', { expanded: true })
    expect(within(toggle).getByText('1')).toBeTruthy()
    expect(within(toggle).getByText('+1')).toBeTruthy()
  })

  it('collapses, and says whether it is open', () => {
    seed({ worktrees: [worktree()], collapsedProjects: { p1: true } })
    mount()
    const toggle = screen.getByRole('button', { expanded: false })
    expect(screen.queryByText('Rewrite the pager')).toBeNull()
    toggle.click()
    expect(toggleProject).toHaveBeenCalledExactlyOnceWith('p1')
  })

  // Six causes, five of which are not each other. Collapsing them into
  // "offline" sends somebody to check their wifi because a colleague shut a
  // laptop.
  it('says which of the ways teamwork is not working applies here', () => {
    const status: TeamworkStatus = {
      state: 'read',
      projectId: 'p1',
      relay: null,
      disabledReason: 'no .teamree/relay in this project',
      origin: { ok: true, url: 'https://example.com/ada/pager.git' },
      enrolled: false,
      links: [],
      readAt: NOW
    }
    seed({ teamwork: { p1: status } })
    mount()
    const badge = screen.getByText('Teamwork off')
    expect(badge.getAttribute('title')).toBe('no .teamree/relay in this project')
  })

  it('says nothing about teamwork before anything has been read', () => {
    mount()
    expect(screen.queryByText(/Teamwork off|No teammates|refused/)).toBeNull()
  })

  // Named with the project, because the rail above the tree has an entry of
  // the same name: two buttons reading "Teamwork" are one button to anybody
  // listening rather than looking.
  it('opens the setup view for the project it belongs to', () => {
    mount()
    screen.getByRole('button', { name: 'Teamwork in pager' }).click()
    expect(openTeamwork).toHaveBeenCalledWith('p1')
  })

  it('starts a new task in the project the button belongs to', () => {
    mount()
    screen.getByRole('button', { name: 'New task in pager' }).click()
    expect(openDialog).toHaveBeenCalledWith({ kind: 'new-task', projectId: 'p1' })
  })
})

// Selected by hover text rather than by accessible name: a teammate's pane
// button is labelled by its own content ("claude"), so two teammates running
// the same agent are two identically named buttons. See the note in the report.
// The text says what the next press would do, so a row that is already open
// offers to stop — which is the half of the toggle this has to match too.
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

  // The floating card could only ever be one, because it was one card. A pane
  // in the workspace is a pane, and a second one is a second pane — which is
  // the whole reason somebody wanted two teammates side by side.
  it('opens a second pane beside the first rather than replacing it', () => {
    act(() => paneOf('priya').click())
    act(() => paneOf('ana').click())
    expect(open()).toEqual([
      { projectId: 'p1', paneId: 'priya:t7' },
      { projectId: 'p1', paneId: 'ana:t2' }
    ])
  })

  // Which is what keeps stopping reachable for somebody whose eye is on this
  // list rather than on the pane.
  it('stops watching when the same row is pressed again', () => {
    const row = (): HTMLElement => paneOf('priya')
    act(() => row().click())
    expect(row().getAttribute('aria-pressed')).toBe('true')
    act(() => row().click())
    expect(open()).toEqual([])
    expect(row().getAttribute('aria-pressed')).toBe('false')
  })

  it('goes on saying which rows are open once a pane is closed from the workspace', () => {
    act(() => paneOf('priya').click())
    act(() => paneOf('ana').click())
    act(() => useWorkspaceStore.getState().closeWatchedPane(useWorkspaceStore.getState().watches[0]!.id))
    expect(paneOf('priya').getAttribute('aria-pressed')).toBe('false')
    expect(paneOf('ana').getAttribute('aria-pressed')).toBe('true')
  })
})

describe('the CLI offer', () => {
  it('is absent while there is nothing to offer', () => {
    mount()
    expect(screen.queryByRole('button', { name: 'Put teamree on my PATH' })).toBeNull()
  })

  it('appears only while the CLI is not linked to this build, and opens the panel', () => {
    seed({
      cli: {
        installable: true,
        packaged: true,
        state: 'absent',
        destination: '/usr/local/bin/teamree',
        directory: '/usr/local/bin',
        source: '/Applications/teamree.app/cli',
        bundle: '/Applications/teamree.app/cli.js',
        // Spelled out rather than left off. These are the fields that say the
        // app is running from somewhere it will still be tomorrow, and an
        // absent one is not the same as a null one: the panel branches on
        // `!== null`, so a seed that omits them describes a state this app
        // never reports and tests a sentence nobody is ever shown.
        impermanent: null,
        onPath: 'environment'
      }
    })
    mount()
    const offer = screen.getByRole('button', { name: 'Put teamree on my PATH' })
    expect(offer.getAttribute('title')).toContain('/usr/local/bin/teamree')
    offer.click()
    expect(openDialog).toHaveBeenCalledWith({ kind: 'install-cli' })
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
    expect(screen.queryByRole('button', { name: 'Put teamree on my PATH' })).toBeNull()
  })
})

// Everything this window can show used to be reachable only from a chord or a
// button buried in a project header. These are app-level places, so they sit
// above the tree, and they have to say which one you are in without relying on
// a colour.
describe('the rail above the tree', () => {
  it('is a landmark of its own, separate from the tree', () => {
    mount()
    expect(screen.getByRole('navigation', { name: 'Go to' })).toBeTruthy()
  })

  // A field that filters this list would be a second, weaker search beside the
  // real one. This opens the real one.
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

  // Teamwork is set up per repository. With none added the entry says why
  // rather than doing nothing when pressed.
  it('says why teamwork cannot be reached before a repository has been added', () => {
    seed({ projects: [] })
    mount()
    const teamwork = screen.getByRole('button', { name: 'Teamwork' }) as HTMLButtonElement
    expect(teamwork.disabled).toBe(true)
    expect(teamwork.getAttribute('title')).toBe('Teamwork is set up per repository, and there is none here yet.')
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

// Settings and Help take the main area, and both were reachable only from the
// empty state until this. A surface with no entry in the rail and no row in the
// palette is a surface somebody has to already know about, which is the one
// thing a help page cannot afford to be.
describe('the rail reaches the window-level surfaces', () => {
  it('opens settings from the rail', () => {
    seed({ settingsOpen: false, toggleSettings })
    mount()
    const entry = screen.getByRole('button', { name: /Settings/ })
    expect(entry.getAttribute('aria-current')).toBeNull()
    act(() => entry.click())
    expect(toggleSettings).toHaveBeenCalled()
  })

  it('marks settings as the page you are on while it has the area', () => {
    seed({ settingsOpen: true, toggleSettings })
    mount()
    expect(screen.getByRole('button', { name: /Settings/ }).getAttribute('aria-current')).toBe('page')
  })

  // ⌘, belongs to the settings page and is shown on its row. The theme editor
  // one row up used to have it, and a Mac developer pressing the chord for an
  // app's settings landed on 42 colour swatches.
  it('shows the settings chord on settings, and none on the theme editor', () => {
    seed({ toggleHelp })
    mount()
    expect(within(screen.getByRole('button', { name: /Help/ })).getByText('⌘/')).toBeTruthy()
    expect(within(screen.getByRole('button', { name: /Settings/ })).getByText('⌘,')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Appearance/ }).querySelector('kbd')).toBeNull()
    act(() => screen.getByRole('button', { name: /Help/ }).click())
    expect(toggleHelp).toHaveBeenCalled()
  })
})

// The claim the worktree chords rest on, made where it can actually be checked:
// against the DOM the sidebar produces. `worktreeOrder.test.ts` proves the
// function groups by project; only a rendered sidebar can say that the function
// is what the sidebar renders. If these two ever part company, ⌘⌥↓ starts
// jumping around a list that is sitting still.
describe('the order the chords walk', () => {
  it('is the order the rows are drawn in', () => {
    const projects = [project, { id: 'p2', name: 'relay', path: '/repos/relay', baseRef: 'origin/main' }]
    // Interleaved, which is how a runtime answer arrives: two projects' rows in
    // whatever order the worktrees were made.
    const worktrees = [
      worktree({ id: 'w1', projectId: 'p1', name: 'one' }),
      worktree({ id: 'w2', projectId: 'p2', name: 'two' }),
      worktree({ id: 'w3', projectId: 'p1', name: 'three' }),
      worktree({ id: 'w4', projectId: 'p2', name: 'four' })
    ]
    seed({ projects, worktrees })
    const { container } = render(
      <Sidebar newWorktreeHint="⌘N" searchHint="⌘K" settingsHint="⌘," helpHint="⌘/" sidebarHint="⌘B" />
    )

    const drawn = [...container.querySelectorAll('.worktree__name')].map((node) => node.textContent)
    expect(drawn).toEqual(['one', 'three', 'two', 'four'])
    expect(drawn).toEqual(worktreeOrder(projects, worktrees).map((entry) => entry.name))
  })
})

// What the row menu is wired to. The menu itself is `WorktreeRow.test.tsx`'s;
// what is only true here is that choosing an item acts on the right worktree
// with the right project's editor — which is the half a component test of the
// row structurally cannot see.
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

    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy path' }))
    await act(async () => undefined)

    expect(writeText).toHaveBeenCalledWith('/repos/pager-wt/rewrite')
    expect(useWorkspaceStore.getState().notices.at(-1)?.text).toContain('Copied')
  })

  it('copies the branch rather than the path when that is what was chosen', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    seed({ worktrees: [worktree()] })
    openMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy branch' }))
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

  // Reported as doing nothing twice, through a driver that sends press and
  // release with no click count — which never makes a click event. A mouse
  // does, and the menu's own outside-press dismissal is not in its way: the
  // press lands inside the menu.
  it('asks the runtime to remove the worktree when Remove is clicked with a mouse', async () => {
    call.mockResolvedValue({ removed: true })
    seed({ worktrees: [worktree()] })
    mount()
    mouseClick(screen.getByRole('button', { name: 'More for Rewrite the pager' }))
    expect(screen.getByRole('menu', { name: 'Actions for Rewrite the pager' })).toBeTruthy()

    mouseClick(screen.getByRole('menuitem', { name: 'Remove' }))
    await act(async () => undefined)

    expect(call).toHaveBeenCalledWith('worktree.remove', { worktreeId: 'w1' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(useWorkspaceStore.getState().worktrees).toEqual([])
  })

  it('puts the runtime’s refusal in front of you as the question it is', async () => {
    call.mockRejectedValue(
      Object.assign(new Error('worktree "Rewrite the pager" has uncommitted changes'), { code: 'conflict' })
    )
    seed({ worktrees: [worktree()] })
    mount()
    mouseClick(screen.getByRole('button', { name: 'More for Rewrite the pager' }))

    mouseClick(screen.getByRole('menuitem', { name: 'Remove' }))
    await act(async () => undefined)

    expect(useWorkspaceStore.getState().dialog).toMatchObject({ kind: 'confirm-remove', worktreeId: 'w1' })
    expect(useWorkspaceStore.getState().worktrees).toHaveLength(1)
  })

  // The editor is the project's, and the path is the worktree's. Nothing else
  // in the window pairs those two, which is why this is asserted here.
  it('opens the checkout in the editor this project names', async () => {
    call.mockResolvedValue({ opened: true, editor: 'mate' })
    seed({ worktrees: [worktree()], editorCommands: { p1: 'mate' } })
    openMenu()

    expect(screen.getByRole('menuitem', { name: 'Open in mate' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in mate' }))
    await act(async () => undefined)

    expect(call).toHaveBeenCalledWith('editor.open', { path: '/repos/pager-wt/rewrite', command: 'mate' })
  })

  // A refusal is the ordinary answer on a machine with no editor set up, and it
  // has to reach the screen: a menu item that did nothing and said nothing is
  // the broken button this menu exists to stop being.
  it('says why nothing opened', async () => {
    call.mockResolvedValue({ opened: false, reason: 'teamree found no editor on PATH.' })
    seed({ worktrees: [worktree()] })
    openMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: /^Open in/ }))
    await act(async () => undefined)

    expect(useWorkspaceStore.getState().notices.at(-1)?.text).toContain('found no editor on PATH')
  })
})
