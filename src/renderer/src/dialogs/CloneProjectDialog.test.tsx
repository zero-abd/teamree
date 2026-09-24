/** @vitest-environment jsdom */

// Cloning a repository: the dialog is the form, and Cancel closes it.

import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

const { CloneProjectDialog } = await import('./CloneProjectDialog')
const { useWorkspaceStore } = await import('../state/workspaceStore')

const closeDialog = vi.fn()
const cloneProject = vi.fn<(url: string, path: string) => Promise<string | null>>()

beforeEach(() => {
  call.mockReset()
  call.mockImplementation(() => new Promise(() => {}))
  closeDialog.mockReset()
  cloneProject.mockReset()
  useWorkspaceStore.setState({ cloneProject, closeDialog })
})

describe('cloning', () => {
  it('is only the clone form, and Cancel closes it', () => {
    openClone()
    expect(screen.getByRole('dialog', { name: 'Clone repository' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Folder/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(closeDialog).toHaveBeenCalledOnce()
  })

  const openClone = (): void => {
    render(<CloneProjectDialog />)
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

  it.each([
    ['URL', url],
    ['destination', destination]
  ])('drops the last failure once the %s is edited', async (_, field) => {
    cloneProject.mockResolvedValueOnce('Repository not found')
    openClone()
    fireEvent.change(url(), { target: { value: 'https://github.com/acme/ap' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    })
    expect(screen.getByRole('alert').textContent).toBe('Repository not found')

    fireEvent.change(field(), { target: { value: `${field().value}i` } })
    expect(screen.queryByRole('alert')).toBeNull()
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
