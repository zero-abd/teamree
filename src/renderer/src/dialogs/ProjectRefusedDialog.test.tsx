/** @vitest-environment jsdom */

// A picked or dropped folder the runtime would not add: why, in one line, and the one way round it.

import { fireEvent, render, screen } from '@testing-library/react'
import type { ProjectAddRefusal } from '@shared/methods'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

const { ProjectRefusedDialog } = await import('./ProjectRefusedDialog')
const { useWorkspaceStore } = await import('../state/workspaceStore')

const addProject = vi.fn<(path: string, name?: string, init?: boolean) => Promise<ProjectAddRefusal | null>>()
const closeDialog = vi.fn()

beforeEach(() => {
  addProject.mockReset()
  addProject.mockResolvedValue(null)
  closeDialog.mockReset()
  useWorkspaceStore.setState({ addProject, closeDialog })
})

describe('a folder that cannot be a project', () => {
  it('offers to initialize a folder that is not a git repository, then adds it', () => {
    render(<ProjectRefusedDialog folder="/Users/ada/notes" refusal="not-a-repository" />)
    expect(screen.getByRole('alert').textContent).toBe('notes: Not a git repository')
    fireEvent.click(screen.getByRole('button', { name: 'Initialize Git' }))
    expect(addProject).toHaveBeenCalledWith('/Users/ada/notes', undefined, true)
  })

  it('says a repository with no commits is not added, and offers no way round it', () => {
    render(<ProjectRefusedDialog folder="/Users/ada/empty" refusal="no-commits" />)
    expect(screen.getByRole('alert').textContent).toBe('empty: No commits yet')
    expect(screen.queryByRole('button', { name: 'Initialize Git' })).toBeNull()
  })

  it('offers no picker or clone of its own, and Cancel closes it', () => {
    render(<ProjectRefusedDialog folder="/Users/ada/notes" refusal="not-a-repository" />)
    expect(screen.queryByRole('button', { name: /Folder|Clone/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(closeDialog).toHaveBeenCalledOnce()
  })

  it('stays open with the new refusal when initializing is refused too', async () => {
    addProject.mockResolvedValueOnce('no-commits')
    render(<ProjectRefusedDialog folder="/Users/ada/notes" refusal="not-a-repository" />)
    fireEvent.click(screen.getByRole('button', { name: 'Initialize Git' }))
    expect((await screen.findByText('notes: No commits yet')).getAttribute('role')).toBe('alert')
  })
})
