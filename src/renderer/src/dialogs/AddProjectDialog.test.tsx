/** @vitest-environment jsdom */

// Adding a repository: pick a folder and it is added, or clone one. The picker
// opens only from its button; an OS sheet nobody asked for also makes the
// dialog undriveable from a hidden window.

import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ProjectAddRefusal } from '@shared/methods'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const call = vi.fn<(method: string, params: unknown) => Promise<unknown>>(() => new Promise(() => {}))

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (method: string, params: unknown) => call(method, params),
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { AddProjectDialog } = await import('./AddProjectDialog')
const { useWorkspaceStore } = await import('../state/workspaceStore')

const selectProjectFolder = vi.fn<() => Promise<string | null>>()
const addProject = vi.fn<(path: string, name?: string, init?: boolean) => Promise<ProjectAddRefusal | null>>()
const cloneProject = vi.fn<(url: string, path: string) => Promise<string | null>>()

beforeEach(() => {
  call.mockReset()
  call.mockImplementation(() => new Promise(() => {}))
  selectProjectFolder.mockReset()
  selectProjectFolder.mockResolvedValue('/Users/ada/code/atlas')
  addProject.mockReset()
  addProject.mockResolvedValue(null)
  cloneProject.mockReset()
  ;(window as unknown as { teamree: unknown }).teamree = { selectProjectFolder }
  useWorkspaceStore.setState({ addProject, cloneProject })
})

afterEach(() => {
  delete (window as unknown as { teamree?: unknown }).teamree
})

describe('choosing a folder', () => {
  it('waits to be asked for', () => {
    render(<AddProjectDialog />)
    expect(selectProjectFolder).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Clone…' })).toBeTruthy()
  })

  it('adds the pick at once, under the folder name', async () => {
    render(<AddProjectDialog />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose Folder…' }))
    expect(selectProjectFolder).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(addProject).toHaveBeenCalledWith('/Users/ada/code/atlas', undefined, false))
  })

  it('adds nothing when the picker is dismissed', async () => {
    selectProjectFolder.mockResolvedValueOnce(null)
    render(<AddProjectDialog />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Choose Folder…' }))
    })
    expect(addProject).not.toHaveBeenCalled()
  })
})

describe('a folder that cannot be a project', () => {
  it('offers to initialize a folder that is not a git repository, then adds it', async () => {
    addProject.mockResolvedValueOnce('not-a-repository').mockResolvedValueOnce(null)
    render(<AddProjectDialog />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose Folder…' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Not a git repository')
    fireEvent.click(screen.getByRole('button', { name: 'Initialize git' }))
    expect(addProject).toHaveBeenLastCalledWith('/Users/ada/code/atlas', undefined, true)
  })

  it('says a repository with no commits is not added, and offers no way round it', async () => {
    addProject.mockResolvedValueOnce('no-commits')
    render(<AddProjectDialog />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose Folder…' }))

    expect((await screen.findByRole('alert')).textContent).toContain('No commits yet')
    expect(screen.queryByRole('button', { name: 'Initialize git' })).toBeNull()
  })

  it('shows the refusal a dropped folder came with', () => {
    render(<AddProjectDialog folder="/Users/ada/notes" refusal="not-a-repository" />)
    expect(screen.getByRole('alert').textContent).toBe('notes: Not a git repository')
    fireEvent.click(screen.getByRole('button', { name: 'Initialize git' }))
    expect(addProject).toHaveBeenCalledWith('/Users/ada/notes', undefined, true)
  })
})

describe('cloning', () => {
  const openClone = (): void => {
    render(<AddProjectDialog />)
    fireEvent.click(screen.getByRole('button', { name: 'Clone…' }))
  }
  const url = (): HTMLInputElement => screen.getByRole('textbox', { name: 'Repository URL' }) as HTMLInputElement
  const destination = (): HTMLInputElement => screen.getByRole('textbox', { name: 'Destination' }) as HTMLInputElement

  it('puts the checkout in ~/code/<repo> until the destination is edited', () => {
    openClone()
    fireEvent.change(url(), { target: { value: 'git@github.com:acme/api.git' } })
    expect(destination().value).toBe('~/code/api')

    fireEvent.change(destination(), { target: { value: '~/src/api' } })
    fireEvent.change(url(), { target: { value: 'git@github.com:acme/web.git' } })
    expect(destination().value).toBe('~/src/api')
  })

  it('clones what was typed, and says in one line why it did not', async () => {
    cloneProject.mockResolvedValueOnce('Authentication failed')
    openClone()
    fireEvent.change(url(), { target: { value: 'https://github.com/acme/api' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    })

    expect(cloneProject).toHaveBeenCalledWith('https://github.com/acme/api', '~/code/api')
    expect(screen.getByRole('alert').textContent).toBe('Authentication failed')
  })

  it('shows what git is doing, and Cancel stops it', async () => {
    cloneProject.mockImplementationOnce(() => new Promise(() => {}))
    call.mockImplementation(async (method) =>
      method === 'project.cloneProgress'
        ? { url: 'u', path: '/p', line: 'Receiving objects: 40% (4/10)', startedAt: 0, cancelling: false }
        : { cancelled: true }
    )
    openClone()
    fireEvent.change(url(), { target: { value: '/srv/git/api.git' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))

    expect(await screen.findByText('Receiving objects: 40% (4/10)')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(call).toHaveBeenCalledWith('project.cancelClone', { url: '/srv/git/api.git' })
  })
})
