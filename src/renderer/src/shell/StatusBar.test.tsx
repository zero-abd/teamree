/** @vitest-environment jsdom */

// The bottom rail, for the one thing on it that is now an action.
//
// The worktree used to have a header row of its own above the panes carrying a
// `3 changed` button, and the rail below already printed the same fact as
// `git 3 uncommitted`. The row is gone. The rail's git segment is where the
// fact was always going to be read, so it is where the changes panel opens
// from — which makes it the one segment here that is a button.

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Worktree, WorktreeStatus } from '@shared/entities'
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

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { StatusBar } = await import('./StatusBar')

const INITIAL = useWorkspaceStore.getState()
const MAC = resolvePlatformModifier('darwin')

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
  render(<StatusBar modifier={MAC} />)
}

beforeEach(() => {
  toggleChanges.mockReset()
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
    seed({ statuses: { w1: status({ unstaged: 1 }) }, changesOpen: true })
    mount()
    expect(screen.getByRole('button', { name: 'Changes, 1 uncommitted' }).getAttribute('aria-pressed')).toBe('true')
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
