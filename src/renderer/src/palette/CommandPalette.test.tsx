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
