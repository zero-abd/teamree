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
// The header is here too. It used to be two lines: a name, sixty characters of
// filesystem path, and six buttons of which four were a second copy of the rail,
// the strip and the chords. What is left has to stay one line of facts about
// this worktree, so these tests name what may be in it and what may not — and
// the one claim on it that is a promise about somebody's repository rather than
// a label, that Push never forces.
//
// And the slot a teammate's pane takes beside all of it. That pane used to
// float over the window; the thing to prove now is that it is laid out as an
// ordinary sibling of the workspace — a cell with a gutter, which is what makes
// it draggable — and that it stays put through the navigations that replace
// everything else in this area, because unmounting it would close and reopen a
// stream nobody stopped watching.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Layout, Project, TeamworkRead, TeamworkStatus, Worktree, WorktreeStatus } from '@shared/entities'
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
vi.mock('./ChangesPanel', () => ({ ChangesPanel: () => null }))
vi.mock('../dashboard/Dashboard', () => ({ Dashboard: () => <div data-testid="dashboard" /> }))
// Both have their own files. What this one decides is that they take the area
// at all, which is the part that lives here.
vi.mock('../settings/SettingsView', () => ({ SettingsView: () => <div data-testid="settings" /> }))
vi.mock('../help/HelpView', () => ({ HelpView: () => <div data-testid="help" /> }))
// The strip above the panes is `TerminalTabs` now — one tab per pane in the
// worktree on screen, where it used to be one per open worktree.
vi.mock('./TerminalTabs', () => ({ TerminalTabs: () => null }))

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

/** Teamwork running in `p1`: a relay is set, the origin matches, the key is in. */
const teamworkUp = (overrides: Partial<TeamworkRead> = {}): Record<string, TeamworkStatus> => ({
  p1: {
    state: 'read',
    projectId: 'p1',
    relay: { url: 'wss://relay.example/v1/relay', source: 'repository' },
    disabledReason: null,
    origin: { ok: true, url: 'https://example.com/ada/pager.git' },
    enrolled: true,
    links: [{ publicKey: 'k', handle: 'bo', phase: 'connected', since: 0, attempts: 1 }],
    readAt: 0,
    ...overrides
  }
})

const openDialog = vi.fn()
const pushActiveWorktree = vi.fn()
const createTerminal = vi.fn()
const startAgent = vi.fn()
const openWorktree = vi.fn()
const openTeamwork = vi.fn()
const revealInFinder = vi.fn()
const toggleHelp = vi.fn()
const toggleSettings = vi.fn()

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
      toggleHelp,
      toggleSettings,
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
  toggleHelp.mockReset()
  toggleSettings.mockReset()
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

  // A dead runtime outranks a first run: with nothing answering, "add a
  // repository" is a button that cannot work.
  it('prefers the dead runtime to the first-run offer when both are true', () => {
    seed({ projects: [], connection: { phase: 'offline' } })
    mount()
    expect(screen.queryByRole('heading', { name: 'Add a repository to start' })).toBeNull()
  })

  // The genuine first run. The chord that makes a worktree needs a project to
  // make it in, so naming one here would be telling somebody to press a key
  // that does nothing.
  it('offers the only action that can work when no repository has been added', () => {
    seed({ projects: [] })
    mount()
    expect(screen.getByRole('heading', { name: 'Add a repository to start' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add a repository' }))
    expect(openDialog).toHaveBeenCalledExactlyOnceWith({ kind: 'add-project' })
  })

  // Caught by reading this state in the running app: with a project added and
  // no worktree in it, the sidebar beside this said "No worktrees yet" while
  // this line told somebody to pick one from it. The button under it already
  // knew better.
  it('does not send somebody to the sidebar when there is no worktree in it', () => {
    seed({ projects: [project] })
    mount()
    expect(screen.queryByText('Pick a worktree on the left, or start here.')).toBeNull()
    expect(screen.getByText('Nothing to open yet. Start here.')).toBeTruthy()
  })

  it('sends somebody to the sidebar once there is a worktree to pick', () => {
    seed({ projects: [project], worktrees: [worktree()] })
    mount()
    expect(screen.getByText('Pick a worktree on the left, or start here.')).toBeTruthy()
  })

  it('names the chords once there is a project for them to act on', () => {
    seed({ projects: [project] })
    mount()
    expect(screen.getByRole('heading', { name: 'Nothing open' })).toBeTruthy()
    const keys = [...document.querySelectorAll('kbd, .legend dt')].map((node) => node.textContent)
    // The chord that makes a worktree, and the one that reaches anything else.
    expect(keys).toContain('⌘N')
    expect(keys).toContain('⌘K')
    expect(keys).toContain('⌘⇧D')
  })

  // What was here before: a heading, a sentence naming a chord, and a legend of
  // six more. A reference card handed to somebody who has not yet done the
  // thing it is a reference for. These are the two things the app is for.
  it('offers a terminal and teamwork as buttons, not as chords to memorise', async () => {
    seed({ projects: [project], worktrees: [worktree()] })
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Open a terminal' }))
    await waitFor(() => expect(createTerminal).toHaveBeenCalledWith('w1'))
    // The tab first, then the pane in it: a pane nobody can see is not the
    // thing that was asked for.
    expect(openWorktree).toHaveBeenCalledWith('w1')
    fireEvent.click(screen.getByRole('button', { name: 'Start teamwork' }))
    expect(openTeamwork).toHaveBeenCalledExactlyOnceWith('p1')
  })

  // Seen on a packaged build talking to a deployed relay: the project header in
  // the same window said "1 connected", and this card told the connected member
  // to put their key in and pick a relay. Both were already done — which is
  // what `disabledReason === null` and `enrolled` mean.
  it('does not tell somebody to set teamwork up in a project where it is already running', () => {
    seed({ projects: [project], worktrees: [worktree()], teamwork: teamworkUp() })
    mount()
    const button = screen.getByRole('button', { name: 'Teamwork' })
    const described = document.getElementById(button.getAttribute('aria-describedby') ?? '')
    expect(described?.textContent).toBe(
      'Teamwork is already on in pager. Open it to see who is connected, and who may read and type into these panes.'
    )
    fireEvent.click(button)
    expect(openTeamwork).toHaveBeenCalledExactlyOnceWith('p1')
  })

  // The two halves of the old sentence are two separate facts, and either one
  // being untrue still leaves something to do. A checkout whose relay is set
  // but whose key was never pushed is the case the runbook warns about, and it
  // must keep the offer rather than claim teamwork is on.
  it('keeps the offer when this machine’s own key is not in the checkout', () => {
    seed({ projects: [project], worktrees: [worktree()], teamwork: teamworkUp({ enrolled: false }) })
    mount()
    const button = screen.getByRole('button', { name: 'Start teamwork' })
    const described = document.getElementById(button.getAttribute('aria-describedby') ?? '')
    expect(described?.textContent).toBe(
      'Put your key in pager and pick a relay, so a teammate can see these panes and type into them.'
    )
  })

  // An answer nobody has yet is not an answer. Until teamwork has been read for
  // this project, the card says the thing that is true of a project nobody has
  // set up, because that is overwhelmingly the case it is there for.
  it('keeps the offer while teamwork has not been read for the project', () => {
    seed({ projects: [project], worktrees: [worktree()] })
    mount()
    expect(screen.getByRole('button', { name: 'Start teamwork' })).toBeTruthy()
  })

  it('says which worktree the terminal would open in, rather than making somebody guess', () => {
    seed({ projects: [project], worktrees: [worktree()] })
    mount()
    const button = screen.getByRole('button', { name: 'Open a terminal' })
    const described = document.getElementById(button.getAttribute('aria-describedby') ?? '')
    expect(described?.textContent).toBe('A shell in Rewrite the pager, on rewrite-the-pager.')
  })

  // There is no terminal outside a worktree — that is the shape of the app —
  // so with none to run one in, the button says what it will really do rather
  // than opening a task composer somebody did not ask for.
  it('says it will make a worktree first when there is none to run a terminal in', () => {
    seed({ projects: [project] })
    mount()
    expect(screen.queryByRole('button', { name: 'Open a terminal' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open a terminal in a new worktree' }))
    expect(openDialog).toHaveBeenCalledExactlyOnceWith({ kind: 'new-task', projectId: 'p1' })
    expect(createTerminal).not.toHaveBeenCalled()
  })

  // A worktree still being checked out has no directory to start a shell in.
  it('does not offer a worktree that is not ready as somewhere to open one', () => {
    seed({ projects: [project], worktrees: [worktree({ state: 'creating' })] })
    mount()
    expect(screen.getByRole('button', { name: 'Open a terminal in a new worktree' })).toBeTruthy()
  })

  it('shows the teamwork setup instead of any of that when it has the area', () => {
    seed({ projects: [project], teamworkProjectId: 'p1' })
    mount()
    expect(screen.getByRole('main', { name: 'Set up teamwork in pager' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Nothing open' })).toBeNull()
  })

  it('shows the dashboard instead of any of that when it is open', () => {
    seed({ projects: [], dashboardOpen: true })
    mount()
    expect(screen.getByTestId('dashboard')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Add a repository to start' })).toBeNull()
  })
})

describe('a worktree with no panes in it', () => {
  it('says the checkout is still being prepared, and offers nothing to press', () => {
    seed({
      projects: [project],
      worktrees: [worktree({ state: 'creating' })],
      activeWorktreeId: 'w1'
    })
    mount()
    const placeholder = document.querySelector('.placeholder--inset') as HTMLElement
    expect(within(placeholder).getByRole('heading', { name: 'Preparing the worktree' })).toBeTruthy()
    expect(within(placeholder).queryByRole('button')).toBeNull()
    expect(within(placeholder).getByText('Panes appear as soon as the checkout is ready.')).toBeTruthy()
  })

  it('offers each agent it found, and a plain terminal, once the checkout is ready', () => {
    seed({
      projects: [project],
      worktrees: [worktree()],
      activeWorktreeId: 'w1',
      agents: [{ kind: 'claude', command: 'claude', binary: '/usr/local/bin/claude' }]
    })
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Start claude' }))
    expect(startAgent).toHaveBeenCalledExactlyOnceWith('claude')
    fireEvent.click(screen.getAllByRole('button', { name: 'New terminal' })[0] as HTMLElement)
    expect(createTerminal).toHaveBeenCalledWith('w1')
  })
})

describe('the toolbar over an open worktree', () => {
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

  it('names the worktree and renders its panes, and prints no path at all', () => {
    expect(screen.getByRole('heading', { name: 'Rewrite the pager' })).toBeTruthy()
    expect(screen.getByTestId('panes')).toBeTruthy()
    expect(screen.queryByText('/repos/pager-wt/rewrite')).toBeNull()
  })

  // The one claim on this bar that is a promise about somebody's repository.
  it('says how many commits Push will send, and that it never forces', () => {
    const push = screen.getByRole('button', { name: 'Push, 2 to push' })
    expect(push.getAttribute('title')).toBe('Send 2 commits to the remote. Never forces.')
    fireEvent.click(push)
    expect(pushActiveWorktree).toHaveBeenCalledOnce()
  })

  // A count, not a sentence: the header has one line and the number is the
  // whole of what it has to say about the branch — and the words on the button
  // are in its name, so somebody driving this by voice can say what they see.
  it('says how many commits are waiting, in the button rather than beside it', () => {
    expect(screen.getByRole('button', { name: 'Push, 2 to push' }).textContent).toBe('2 to push')
  })

  it('counts what a commit would have to deal with, ahead and behind excluded', () => {
    expect(screen.getByRole('button', { name: 'Changes, 3 changed' }).textContent).toBe('3 changed')
  })

  it('says whether the changes panel is showing', () => {
    expect(screen.getByRole('button', { name: 'Changes, 3 changed' }).getAttribute('aria-pressed')).toBe('false')
  })

  // Nothing to report is reported as nothing. A button that said "0 changed"
  // would be spending the header's one line on the absence of news.
  it('says nothing at all when there is nothing to say', () => {
    seed({
      projects: [project],
      worktrees: [worktree()],
      activeWorktreeId: 'w1',
      layouts: { w1: layout() },
      statuses: { w1: status() }
    })
    mount()
    const heads = document.querySelectorAll('.workspace__head')
    const head = heads[heads.length - 1] as HTMLElement
    expect(within(head).getByRole('button', { name: 'Changes' }).textContent).toBe('')
    expect(within(head).getByRole('button', { name: 'Push' }).textContent).toBe('')
  })
})

// The complaint this answers: a strip above the panes carrying a pane board,
// two splits and a new terminal, each of which is a chord the status bar prints,
// a row in the palette, and — for the last three — a button on the panes' own
// strip. What is left is what only this worktree can say.
describe('what the header may not carry', () => {
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

  it('is one row of two repository buttons and nothing else', () => {
    const tools = document.querySelector('.workspace__tools') as HTMLElement
    const labels = within(tools)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'))
    expect(labels).toEqual(['Changes, 3 changed', 'Push, 2 to push'])
  })

  it('offers no command that has a place of its own', () => {
    const head = document.querySelector('.workspace__head') as HTMLElement
    for (const name of ['All panes', 'Split right', 'Split down', 'New terminal']) {
      expect(within(head).queryByRole('button', { name })).toBeNull()
    }
  })

  // Buttons carry the meaning here. A paragraph explaining why they are
  // arranged the way they are belongs in the source, where this one is — and a
  // worktree still being made is where the last paragraph of it hid, as a
  // `<p>` holding the path of a checkout that is not there yet.
  it('explains nothing in prose, in any state the checkout can be in', () => {
    for (const state of ['ready', 'creating', 'failed'] as const) {
      seed({
        projects: [project],
        worktrees: [worktree({ state })],
        activeWorktreeId: 'w1',
        layouts: { w1: layout() },
        statuses: { w1: status({ ahead: 2, unstaged: 3 }) }
      })
      mount()
      const heads = document.querySelectorAll('.workspace__head')
      const head = heads[heads.length - 1] as HTMLElement
      expect(head.querySelector('p')).toBeNull()
      // A full stop followed by anything is a sentence, and there are none.
      expect(head.textContent ?? '').not.toMatch(/\.\s/)
      // The name is whatever somebody called the task. Everything else this row
      // says is a count — "3 changed", "2 to push" — and a count is three words
      // at the very most.
      const tools = head.querySelector('.workspace__tools') as HTMLElement
      for (const button of within(tools).getAllByRole('button')) {
        expect((button.textContent ?? '').trim().split(/\s+/).filter(Boolean).length).toBeLessThan(4)
      }
    }
  })
})

// Sixty characters of filesystem path sat under the worktree's name, read on
// every screen by nobody. The only thing it could do that the sidebar and the
// heading cannot is get you to the directory, so that is the only thing left.
describe('reaching the checkout', () => {
  const open = (state: Worktree['state']): void => {
    seed({
      projects: [project],
      worktrees: [worktree({ state })],
      activeWorktreeId: 'w1',
      layouts: { w1: layout() }
    })
    mount()
  }

  const reveal = /Show the Rewrite the pager checkout/

  it('opens the checkout in the file manager from an icon, not a path', () => {
    open('ready')
    expect(screen.queryByText('/repos/pager-wt/rewrite')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: reveal }))
    expect(revealInFinder).toHaveBeenCalledWith('/repos/pager-wt/rewrite', 'the Rewrite the pager checkout')
  })

  // The hover is where the path belongs: asked for, rather than printed at
  // somebody all day.
  it('says which directory it will open, on hover', () => {
    open('ready')
    expect(screen.getByRole('button', { name: reveal }).getAttribute('title')).toBe(
      'Show /repos/pager-wt/rewrite in the file manager'
    )
  })

  // A checkout still being made has a path recorded and nothing at it yet, so
  // the only possible outcome of pressing this would be the refusal the main
  // process writes for a directory that is not there.
  it('is not offered while the checkout is not there to open', () => {
    open('creating')
    expect(screen.queryByRole('button', { name: reveal })).toBeNull()
  })

  it('is not offered for a checkout that was never made', () => {
    open('failed')
    expect(screen.queryByRole('button', { name: reveal })).toBeNull()
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
    expect(screen.queryByRole('heading', { name: 'Nothing open' })).toBeNull()
  })

  it('gives the area to help on the same terms', () => {
    seed({ projects: [project], helpOpen: true })
    mount()
    expect(screen.getByTestId('help')).toBeTruthy()
  })

  it('offers both from the empty state, not only as chords', () => {
    seed({ projects: [project] })
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'How this works' }))
    expect(toggleHelp).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(toggleSettings).toHaveBeenCalledOnce()
  })
})

// The row used to carry one button per agent found on PATH, so its width grew
// with somebody's tool collection and the two buttons that act on their
// repository sat beside a list that differs from laptop to laptop. It is a
// fixed pair of facts about this worktree now, and this says so, so a helpful
// addition cannot quietly put the launcher back.
describe('the header and the agents on this machine', () => {
  const seedWithAgents = (): void => {
    seed({
      projects: [project],
      worktrees: [worktree()],
      activeWorktreeId: 'w1',
      layouts: { w1: layout() },
      agents: [
        { kind: 'claude', command: 'claude', binary: '/usr/local/bin/claude' },
        { kind: 'codex', command: 'codex', binary: '/usr/local/bin/codex' }
      ]
    })
    mount()
  }

  it('offers the same buttons whatever agents are installed', () => {
    seedWithAgents()
    const tools = document.querySelector('.workspace__tools') as HTMLElement
    const labels = within(tools)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'))
    expect(labels).toEqual(['Changes', 'Push'])
  })

  it('does not offer a per-agent button, and cannot start one from here', () => {
    seedWithAgents()
    const tools = document.querySelector('.workspace__tools') as HTMLElement
    expect(within(tools).queryByRole('button', { name: 'claude' })).toBeNull()
    expect(within(tools).queryByRole('button', { name: 'codex' })).toBeNull()
    for (const button of within(tools).getAllByRole('button')) fireEvent.click(button)
    expect(startAgent).not.toHaveBeenCalled()
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
    expect(screen.getByRole('heading', { name: 'Nothing open' })).toBeTruthy()
    expect(screen.getByTestId('watched-priya-priya:t7')).toBeTruthy()
  })
})

describe('pushing', () => {
  it('says nothing is to be sent when the remote already has the branch', () => {
    seed({ projects: [project], worktrees: [worktree()], activeWorktreeId: 'w1', statuses: { w1: status() } })
    mount()
    expect(screen.getByRole('button', { name: 'Push' }).getAttribute('title')).toBe(
      'Nothing to send; the remote already has this branch.'
    )
  })

  it('says it is pushing, and refuses a second press while it is', () => {
    seed({ projects: [project], worktrees: [worktree()], activeWorktreeId: 'w1', pushing: true })
    mount()
    const push = screen.getByRole('button', { name: 'Pushing' }) as HTMLButtonElement
    expect(push.disabled).toBe(true)
    expect(push.textContent).toBe('pushing…')
    fireEvent.click(push)
    expect(pushActiveWorktree).not.toHaveBeenCalled()
  })
})
