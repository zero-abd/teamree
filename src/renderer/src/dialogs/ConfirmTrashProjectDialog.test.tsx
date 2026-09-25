/** @vitest-environment jsdom */

// The two new questions: Remove from teamree names what it forgets, Move to Trash… what it would lose.

import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Terminal, Worktree } from '@shared/entities'

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
const { ConfirmTrashProjectDialog } = await import('./ConfirmTrashProjectDialog')
const { ConfirmForgetDialog } = await import('./ConfirmForgetDialog')

const INITIAL = useWorkspaceStore.getState()

const project: Project = { id: 'p1', name: 'pager', path: '/repos/pager', baseRef: 'main' }
const worktree: Worktree = {
  id: 'w1',
  projectId: 'p1',
  name: 'Rewrite the pager',
  branch: 'rewrite-the-pager',
  path: '/repos/pager-wt/rewrite-the-pager',
  startedFrom: 'main',
  state: 'ready',
  createdAt: 0
}
const busy: Terminal = {
  id: 't1',
  worktreeId: 'w1',
  title: 'npm test',
  cwd: worktree.path,
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy: true,
  lastOutputAt: 0
}

const confirmTrashProject = vi.fn()
const confirmForget = vi.fn()
const closeDialog = vi.fn()

beforeEach(() => {
  call.mockReset()
  call.mockImplementation((method: unknown) =>
    method === 'project.trashPreview'
      ? Promise.resolve({ uncommitted: 3, unpushed: 1, worktrees: 2 })
      : new Promise(() => {})
  )
  confirmTrashProject.mockReset()
  confirmForget.mockReset()
  closeDialog.mockReset()
  useWorkspaceStore.setState(
    { ...INITIAL, projects: [project], worktrees: [worktree], confirmTrashProject, confirmForget, closeDialog },
    true
  )
})

const listed = (): string[] =>
  [...document.querySelectorAll('.confirm__files li')].map((item) => item.textContent ?? '')
const buttons = (): Element[] => [...document.querySelectorAll('.modal__actions .button')]

describe('Move to Trash… for a project', () => {
  it('names the project and counts what would be lost', async () => {
    render(<ConfirmTrashProjectDialog projectId="p1" />)
    await act(async () => undefined)

    expect(screen.getByRole('dialog', { name: 'Move "pager" to Trash?' })).toBeTruthy()
    expect(call).toHaveBeenCalledWith('project.trashPreview', { projectId: 'p1' })
    expect(listed()).toEqual(['3 uncommitted files', '1 unpushed commit', '2 teamree worktrees'])
  })

  it('focuses Cancel, draws Move to Trash red, and moves nothing on Cancel', async () => {
    render(<ConfirmTrashProjectDialog projectId="p1" />)
    await act(async () => undefined)

    expect(buttons().map((button) => button.textContent)).toEqual(['Cancel', 'Move to Trash'])
    expect(document.activeElement?.textContent).toBe('Cancel')
    expect(buttons()[1]?.classList.contains('button--danger')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(confirmTrashProject).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }))
    expect(confirmTrashProject).toHaveBeenCalledExactlyOnceWith('p1')
  })
})

describe('Remove from teamree', () => {
  it('asks by name and removes on Remove', () => {
    render(<ConfirmForgetDialog target={{ projectId: 'p1' }} />)

    expect(screen.getByRole('dialog', { name: 'Remove "pager" from teamree?' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(confirmForget).toHaveBeenCalledExactlyOnceWith({ projectId: 'p1' })
  })

  it('names the panes it would stop, in red', () => {
    useWorkspaceStore.setState({ terminals: { t1: busy } })
    render(<ConfirmForgetDialog target={{ worktreeId: 'w1' }} />)

    expect(screen.getByRole('dialog', { name: 'Remove "Rewrite the pager" from teamree?' })).toBeTruthy()
    expect(listed()).toHaveLength(1)
    expect(document.activeElement?.textContent).toBe('Cancel')
    expect(screen.getByRole('button', { name: 'Stop and Remove' }).classList.contains('button--danger')).toBe(true)
  })
})
