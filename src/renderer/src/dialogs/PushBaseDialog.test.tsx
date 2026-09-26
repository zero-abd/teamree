/** @vitest-environment jsdom */

// Pushing main: a refused push is one line with git's words behind Details, and Pull and Retry when origin moved.

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ProjectBase } from '@shared/entities'

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
const { PushBaseDialog } = await import('./PushBaseDialog')

const INITIAL = useWorkspaceStore.getState()
const base: ProjectBase = { projectId: 'p1', branch: 'main', upstream: 'origin/main', ahead: 2, behind: 0 }
const pushed: ProjectBase = { ...base, ahead: 0 }

const refusal = (message: string, kind?: string): Error =>
  Object.assign(new Error(message), {
    data: { detail: `! [rejected] main -> main\n${message}`, ...(kind ? { kind } : {}) }
  })

beforeEach(() => {
  call.mockReset()
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      projects: [{ id: 'p1', name: 'pager', path: '/repos/pager', baseRef: 'origin/main' }],
      bases: { p1: base },
      dialog: { kind: 'push-base', projectId: 'p1' }
    },
    true
  )
})

it('says how far main is ahead, and pushes it', async () => {
  call.mockResolvedValue(pushed)
  render(<PushBaseDialog projectId="p1" />)

  expect(screen.getByText('2 ahead of origin/main')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Push' }))

  await waitFor(() => expect(useWorkspaceStore.getState().dialog).toBeNull())
  expect(call).toHaveBeenCalledWith('project.pushBase', { projectId: 'p1' })
  expect(useWorkspaceStore.getState().bases.p1?.ahead).toBe(0)
})

it('offers Pull and Retry when origin moved, and pulls before pushing', async () => {
  render(
    <PushBaseDialog
      projectId="p1"
      failure={{ message: 'origin/main moved', detail: '! [rejected] main -> main (fetch first)', kind: 'rejected' }}
    />
  )

  expect(screen.getByRole('alert').textContent).toBe('Push failed: origin/main moved')
  expect(screen.getByText('Details')).toBeTruthy()
  call.mockImplementation((method: unknown) => Promise.resolve(method === 'project.pullBase' ? base : pushed))
  fireEvent.click(screen.getByRole('button', { name: 'Pull and Retry' }))

  await waitFor(() => expect(useWorkspaceStore.getState().dialog).toBeNull())
  expect(call.mock.calls.map(([method]) => method)).toEqual(['project.pullBase', 'project.pushBase'])
})

it('gives an auth refusal its own line and a plain Retry', async () => {
  call.mockRejectedValue(refusal('sign-in failed', 'auth'))
  render(<PushBaseDialog projectId="p1" />)
  fireEvent.click(screen.getByRole('button', { name: 'Push' }))

  expect((await screen.findByRole('alert')).textContent).toBe('Push failed: sign-in failed')
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Pull and Retry' })).toBeNull()
  expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'push-base', projectId: 'p1' })
})

it('says a project with no remote has none to push to', async () => {
  call.mockRejectedValue(Object.assign(new Error('no remote'), { data: { detail: 'this repository has no remotes' } }))
  render(<PushBaseDialog projectId="p1" />)
  fireEvent.click(screen.getByRole('button', { name: 'Push' }))

  expect((await screen.findByRole('alert')).textContent).toBe('Push failed: no remote')
})
