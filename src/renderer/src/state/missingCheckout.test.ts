// A checkout gone from disk: Restore asks the runtime to check it out again, Locate… asks for the folder it
// was moved to. Either way the record the runtime answers replaces the missing one.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Worktree } from '@shared/entities'

vi.mock('../runtimeClient/currentRuntimeClient', async () => {
  const { createSeededRuntimeClient } = await import('../runtimeClient/seededRuntimeClient')
  return { runtimeClient: createSeededRuntimeClient() }
})

import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from './workspaceStore'

const INITIAL = useWorkspaceStore.getState()
const chooseFolder = vi.fn<(from: string) => Promise<string | null>>()

beforeEach(async () => {
  vi.restoreAllMocks()
  chooseFolder.mockReset()
  vi.stubGlobal('window', { ...globalThis.window, teamree: { chooseFolder } })
  useWorkspaceStore.setState(INITIAL, true)
  await useWorkspaceStore.getState().bootstrap()
  const worktree = firstReady()
  useWorkspaceStore.setState({
    worktrees: useWorkspaceStore
      .getState()
      .worktrees.map((entry) =>
        entry.id === worktree.id ? { ...entry, path: '/wt/pager/ghost', missing: true } : entry
      )
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const firstReady = (): Worktree => useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!
const current = (id: string): Worktree | undefined =>
  useWorkspaceStore.getState().worktrees.find((entry) => entry.id === id)

/** The runtime's answer: the record with the checkout back, at `path`. */
function answering(path: string) {
  return vi.spyOn(runtimeClient, 'call').mockImplementation((async (method: string, params: { worktreeId: string }) => {
    const { missing: _gone, ...back } = current(params.worktreeId)!
    if (method === 'worktree.recreate' || method === 'worktree.locate') return { ...back, path }
    return new Promise(() => {})
  }) as never)
}

it('restores the checkout where it was, and takes the record back', async () => {
  const { id } = firstReady()
  const call = answering('/wt/pager/ghost')

  await useWorkspaceStore.getState().recreateCheckout(id)

  expect(call).toHaveBeenCalledWith('worktree.recreate', { worktreeId: id })
  expect(current(id)?.missing).toBeUndefined()
})

it('locates a moved checkout from the folder picked, starting beside where it was', async () => {
  const { id } = firstReady()
  const call = answering('/elsewhere/ghost')
  chooseFolder.mockResolvedValue('/elsewhere/ghost')

  await useWorkspaceStore.getState().locateCheckout(id)

  expect(chooseFolder).toHaveBeenCalledWith('/wt/pager')
  expect(call).toHaveBeenCalledWith('worktree.locate', { worktreeId: id, path: '/elsewhere/ghost' })
  expect([current(id)?.path, current(id)?.missing]).toEqual(['/elsewhere/ghost', undefined])
})

it('asks the runtime nothing when the picker is cancelled', async () => {
  const { id } = firstReady()
  const call = answering('/elsewhere/ghost')
  chooseFolder.mockResolvedValue(null)

  await useWorkspaceStore.getState().locateCheckout(id)

  expect(call).not.toHaveBeenCalledWith('worktree.locate', expect.anything())
  expect(current(id)?.missing).toBe(true)
})
