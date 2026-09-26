/** @vitest-environment jsdom */

// Move Under… and the rebase question: the keyboard's way to nest, and the question a drop can raise.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '@shared/entities'

const call = vi.hoisted(() => vi.fn((..._args: unknown[]): Promise<unknown> => new Promise(() => {})))

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call,
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { MoveUnderDialog } = await import('./MoveUnderDialog')
const { ConfirmRebaseDialog } = await import('./ConfirmRebaseDialog')

const INITIAL = useWorkspaceStore.getState()

const worktree = (id: string, name: string, parentId?: string): Worktree => ({
  id,
  projectId: 'p1',
  name,
  branch: id,
  path: `/wt/${id}`,
  startedFrom: 'main',
  state: 'ready',
  createdAt: 0,
  ...(parentId === undefined ? {} : { parentId })
})

const WORKTREES = [
  worktree('auth', 'Rework auth'),
  worktree('mig', 'Write the migration', 'auth'),
  worktree('docs', 'Docs')
]

const openDialog = vi.fn()
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn += 1) await act(async () => undefined)
}
const nestCalls = (): unknown[] =>
  call.mock.calls.filter(([method]) => method === 'worktree.nest').map(([, params]) => params)

beforeEach(() => {
  call.mockReset()
  call.mockImplementation(async (_method: unknown, params: unknown) => {
    const { worktreeId, parentId, dryRun } = params as { worktreeId: string; parentId: string; dryRun?: boolean }
    const moved = WORKTREES.find((entry) => entry.id === worktreeId) as Worktree
    return { worktree: { ...moved, parentId }, change: 'nest', dryRun: dryRun === true }
  })
  openDialog.mockReset()
  useWorkspaceStore.setState({ ...INITIAL, worktrees: WORKTREES, openDialog }, true)
})

afterEach(cleanup)

describe('Move Under…', () => {
  it('lists the project in tree order, a refused row disabled with its reason', () => {
    render(<MoveUnderDialog worktreeId="mig" />)
    expect(screen.getByRole('dialog', { name: 'Move Write the migration under' })).toBeTruthy()
    const options = screen.getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual(['Rework authAlready under Rework auth', 'Docs'])
    expect(options[0]?.getAttribute('aria-disabled')).toBe('true')
    // The first row it can go under is the one chosen.
    expect(options[1]?.getAttribute('aria-selected')).toBe('true')
  })

  it('moves under the row chosen, from the keyboard', async () => {
    render(<MoveUnderDialog worktreeId="docs" />)
    const filter = screen.getByRole('textbox', { name: 'Filter' })
    fireEvent.keyDown(filter, { key: 'ArrowDown' })
    fireEvent.submit(filter.closest('form') as HTMLFormElement)
    await settle()
    expect(nestCalls()).toEqual([
      { worktreeId: 'docs', parentId: 'mig', dryRun: true },
      { worktreeId: 'docs', parentId: 'mig' }
    ])
    expect(useWorkspaceStore.getState().dialog).toBeNull()
    expect(useWorkspaceStore.getState().notices.at(-1)?.text).toBe('Moved Docs under Write the migration')
  })

  it('narrows the list as it is typed into', () => {
    render(<MoveUnderDialog worktreeId="docs" />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter' }), { target: { value: 'migr' } })
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Write the migration'])
  })
})

describe('the rebase question', () => {
  it('asks in the owner’s words, and rebases only on Rebase', async () => {
    render(<ConfirmRebaseDialog worktreeId="docs" parentId="mig" />)
    expect(screen.getByRole('dialog', { name: 'Rebase Docs onto Write the migration?' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Rebase' }))
    await settle()
    expect(nestCalls()).toEqual([{ worktreeId: 'docs', parentId: 'mig', rebase: true }])
  })

  it('changes nothing on Cancel', () => {
    render(<ConfirmRebaseDialog worktreeId="docs" parentId="mig" />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(nestCalls()).toEqual([])
    expect(useWorkspaceStore.getState().dialog).toBeNull()
  })
})
