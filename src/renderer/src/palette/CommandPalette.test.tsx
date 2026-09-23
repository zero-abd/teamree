/** @vitest-environment jsdom */

// The palette as assembled: what its rows do when they are chosen.
//
// The ranking and the wording are covered in `paletteModel.test.ts`, which is
// where they live. What is only true of the wired-up palette is here, and the
// reason this file exists is the agents: the toolbar over a worktree used to
// carry one button each, and this is now the only way to start one in a
// worktree that already has panes. A row that looks right and runs nothing is
// the failure this guards against.

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstalledAgent, Project, Worktree } from '@shared/entities'
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
const { CommandPalette } = await import('./CommandPalette')

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

const agents: InstalledAgent[] = [
  { kind: 'claude', command: 'claude', binary: '/usr/local/bin/claude' },
  { kind: 'codex', command: 'codex', binary: '/usr/local/bin/codex' }
]

const startAgent = vi.fn()
const openDialog = vi.fn()
const closeDialog = vi.fn()

function seed(overrides: Record<string, unknown> = {}): void {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      projects: [project],
      worktrees: [worktree()],
      activeWorktreeId: 'w1',
      agents,
      startAgent,
      openDialog,
      closeDialog,
      ...overrides
    },
    true
  )
}

const mount = (): void => {
  render(<CommandPalette modifier={MAC} />)
}

const rows = (): HTMLElement[] => screen.getAllByRole('option')

beforeEach(() => {
  startAgent.mockReset()
  openDialog.mockReset()
  closeDialog.mockReset()
  seed()
})

describe('starting an agent from the palette', () => {
  it('offers one row per agent found on this machine', () => {
    mount()
    const labels = rows()
      .map((row) => row.querySelector('.palette__label')?.textContent ?? '')
      .filter((label) => label.startsWith('Start '))
    expect(labels).toEqual(['Start claude in this worktree', 'Start codex in this worktree'])
  })

  it('offers none when nothing is installed', () => {
    seed({ agents: [] })
    mount()
    expect(rows().some((row) => row.textContent?.includes('Start '))).toBe(false)
  })

  it('starts that agent in the worktree on screen, and closes', () => {
    mount()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'codex' } })
    fireEvent.click(rows()[0] as HTMLElement)
    expect(startAgent).toHaveBeenCalledExactlyOnceWith('codex')
    expect(closeDialog).toHaveBeenCalledOnce()
  })

  // The one confusion worth guarding: both rows start an agent, and only this
  // one does it here. "New task" makes another worktree first.
  it('does not open the new-task dialog on the way', () => {
    mount()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'start claude' } })
    fireEvent.click(rows()[0] as HTMLElement)
    expect(startAgent).toHaveBeenCalledExactlyOnceWith('claude')
    expect(openDialog).not.toHaveBeenCalled()
  })

  it('still opens the new-task dialog when that is the row chosen', () => {
    mount()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new task' } })
    fireEvent.click(rows()[0] as HTMLElement)
    expect(openDialog).toHaveBeenCalledExactlyOnceWith({ kind: 'new-task', projectId: 'p1' })
    expect(startAgent).not.toHaveBeenCalled()
  })
})

describe('the rows that are also commands', () => {
  const labels = (): string[] => rows().map((row) => row.querySelector('.palette__label')?.textContent ?? '')

  // The window has no pane in it, so the pane commands are not on offer — the
  // same answer the menu bar gives, from the same predicate. A row in black
  // letters that runs nothing is what this used to do.
  it('offers no command the window would refuse', () => {
    mount()
    expect(labels()).not.toContain('Split pane right')
    expect(labels()).not.toContain('Split pane down')
    expect(labels()).toContain('New terminal')
    expect(labels()).toContain('New task')
  })

  it('offers the pane commands once there is a pane', () => {
    seed({
      layouts: { w1: { worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' } }
    })
    mount()
    expect(labels()).toContain('Split pane right')
  })

  // Through the one dispatcher, which is the only way a row and a chord stay
  // the same command.
  it('runs the row through the dispatcher the chord goes through', () => {
    const splitFocusedPane = vi.fn(() => Promise.resolve())
    seed({
      layouts: { w1: { worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' } },
      splitFocusedPane
    })
    mount()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'split right' } })
    fireEvent.click(rows()[0] as HTMLElement)
    expect(splitFocusedPane).toHaveBeenCalledExactlyOnceWith('row')
    expect(closeDialog).toHaveBeenCalledOnce()
  })
})

// The rows the palette gained from the command table, and the predicate that
// decides whether each is on offer. Same answer as the menu bar's, because it
// is the same function: a row for a command the window would refuse is left out
// rather than drawn and ignored.
describe('the git rows are offered exactly when they could do something', () => {
  const labels = (): string[] => rows().map((row) => row.querySelector('.palette__label')?.textContent ?? '')

  const status = (overrides: Record<string, number> = {}): Record<string, unknown> => ({
    w1: {
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
    }
  })

  it('offers neither on a worktree with nothing to send and nothing changed', () => {
    seed({ statuses: status() })
    mount()
    expect(labels()).not.toContain('Push')
    expect(labels()).not.toContain('Commit…')
  })

  it('offers Push once there is a commit the remote has not', () => {
    seed({ statuses: status({ ahead: 1 }) })
    mount()
    expect(labels()).toContain('Push')
    expect(labels()).not.toContain('Commit…')
  })

  it('offers Commit… once a file has changed', () => {
    seed({ statuses: status({ unstaged: 2 }) })
    mount()
    expect(labels()).toContain('Commit…')
    expect(labels()).not.toContain('Push')
  })
})
