/** @vitest-environment jsdom */

// The sidebar, assembled: projects, your worktrees, your teammates' worktrees
// under the same project, and the one window this app opens onto somebody
// else's machine.
//
// The rows have their own files. What is only true here is the wiring between
// them — that pressing a teammate's pane opens a viewer for *that* pane, that
// pressing it again stops watching rather than opening a second one, and that
// one window watches one pane at a time, which is what keeps "bytes flow on
// demand" from becoming the N² traffic it exists to prevent.
//
// It is also where the several ways of having nothing to show are kept apart:
// no projects, no worktrees, and a teammate on the roster nothing has ever been
// heard from are three different sentences.

import { act, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, TeammatePresence, TeamworkStatus, Worktree } from '@shared/entities'

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

// The viewer is exercised in its own file; here it only has to prove which
// pane the sidebar decided to open, and that it went away again.
vi.mock('../terminal/WatchedPaneView', () => ({
  WatchedPaneView: ({ paneId, handle, onClose }: { paneId: string; handle: string; onClose: () => void }) => (
    <section aria-label={`watching ${handle} ${paneId}`}>
      <button type="button" onClick={onClose}>
        Stop watching
      </button>
    </section>
  )
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { Sidebar } = await import('./Sidebar')

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

const presence = (overrides: Partial<TeammatePresence> = {}): TeammatePresence => ({
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

function seed(overrides: Record<string, unknown> = {}): void {
  useWorkspaceStore.setState({ ...INITIAL, projects: [project], openDialog, toggleProject, ...overrides }, true)
}

const mount = (): void => {
  render(<Sidebar newWorktreeHint="⌘N" />)
}

beforeEach(() => {
  call.mockReset()
  call.mockRejectedValue(new Error('not asked for in this test'))
  watchPane.mockReset()
  watchPane.mockReturnValue(new Promise(() => {}))
  openDialog.mockReset()
  toggleProject.mockReset()
  seed()
})

describe('having nothing to show', () => {
  it('asks for a repository when there are no projects at all', () => {
    seed({ projects: [] })
    mount()
    expect(screen.getByText('No projects yet. Add a repository to get started.')).toBeTruthy()
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
      projectId: 'p1',
      relay: null,
      disabledReason: 'no .teamree/relay in this project',
      origin: { ok: true },
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

  it('opens the setup panel from the header', () => {
    mount()
    screen.getByRole('button', { name: 'Teamwork' }).click()
    expect(openDialog).toHaveBeenCalledWith({ kind: 'start-teamwork', projectId: 'p1' })
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
const paneOf = (handle: string): HTMLElement => screen.getByTitle(new RegExp(`^Watch ${handle}`))

describe('watching a teammate’s pane', () => {
  beforeEach(() => {
    seed({
      teammates: {
        p1: presence({ worktrees: [theirWorktree('priya', 'priya:t7'), theirWorktree('ana', 'ana:t2')] })
      }
    })
    mount()
  })

  it('opens nothing until somebody asks for it', () => {
    expect(screen.queryByRole('region', { name: /watching/ })).toBeNull()
  })

  it('opens the pane that was pressed, on its own project', () => {
    act(() => paneOf('priya').click())
    expect(screen.getByRole('region', { name: 'watching priya priya:t7' })).toBeTruthy()
  })

  // Bytes cost a relay budget and a reader has one pair of eyes. "Open" meaning
  // "was opened once and never shut" is how that becomes N² traffic.
  it('watches one pane at a time, replacing rather than stacking', () => {
    act(() => paneOf('priya').click())
    act(() => paneOf('ana').click())
    expect(screen.getAllByRole('region', { name: /watching/ })).toHaveLength(1)
    expect(screen.getByRole('region', { name: 'watching ana ana:t2' })).toBeTruthy()
  })

  // Which is also what makes stopping reachable without reaching for the viewer.
  it('stops watching when the same row is pressed again', () => {
    const row = (): HTMLElement => paneOf('priya')
    act(() => row().click())
    expect(row().getAttribute('aria-pressed')).toBe('true')
    act(() => row().click())
    expect(screen.queryByRole('region', { name: /watching/ })).toBeNull()
    expect(row().getAttribute('aria-pressed')).toBe('false')
  })

  it('stops watching from the viewer itself', () => {
    act(() => paneOf('priya').click())
    act(() => screen.getByRole('button', { name: 'Stop watching' }).click())
    expect(screen.queryByRole('region', { name: /watching/ })).toBeNull()
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
        state: 'absent',
        destination: '/usr/local/bin/teamree',
        source: '/Applications/teamree.app/cli',
        onPath: true
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
