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
// The toolbar is here too, for the one claim on it that is a promise about
// somebody's repository rather than a label: that Push never forces.

import { fireEvent, render, screen, within } from '@testing-library/react'
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
vi.mock('./ChangesPanel', () => ({ ChangesPanel: () => null }))
vi.mock('../dashboard/Dashboard', () => ({ Dashboard: () => <div data-testid="dashboard" /> }))
vi.mock('./WorktreeTabs', () => ({ WorktreeTabs: () => null }))

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

function seed(overrides: Record<string, unknown> = {}): void {
  useWorkspaceStore.setState(
    { ...INITIAL, openDialog, pushActiveWorktree, createTerminal, startAgent, ...overrides },
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

  it('names the worktree and its path, and renders its panes', () => {
    expect(screen.getByRole('heading', { name: 'Rewrite the pager' })).toBeTruthy()
    expect(screen.getByText('/repos/pager-wt/rewrite')).toBeTruthy()
    expect(screen.getByTestId('panes')).toBeTruthy()
  })

  // The one claim on this bar that is a promise about somebody's repository.
  it('says how many commits Push will send, and that it never forces', () => {
    const push = screen.getByRole('button', { name: /^Push/ })
    expect(push.getAttribute('title')).toBe('Send 2 commits to the remote. Never forces.')
    fireEvent.click(push)
    expect(pushActiveWorktree).toHaveBeenCalledOnce()
  })

  it('counts what a commit would have to deal with, ahead and behind excluded', () => {
    expect(screen.getByRole('button', { name: /^Changes/ }).textContent).toBe('Changes3')
  })

  it('says whether the changes panel is showing', () => {
    expect(screen.getByRole('button', { name: /^Changes/ }).getAttribute('aria-pressed')).toBe('false')
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
    const push = screen.getByRole('button', { name: 'Pushing…' }) as HTMLButtonElement
    expect(push.disabled).toBe(true)
    fireEvent.click(push)
    expect(pushActiveWorktree).not.toHaveBeenCalled()
  })
})
