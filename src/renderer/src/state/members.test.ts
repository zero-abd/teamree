import { expect, it, vi } from 'vitest'
import { refreshTargets, targetsForEvent } from './workspaceRefresh'

vi.mock('../runtimeClient/currentRuntimeClient', async () => {
  const { createSeededRuntimeClient } = await import('../runtimeClient/seededRuntimeClient')
  return { runtimeClient: createSeededRuntimeClient() }
})

import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from './workspaceStore'

it('reads a roster only once somebody opens one', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const [joined] = useWorkspaceStore.getState().projects

  const call = vi.spyOn(runtimeClient, 'call')
  expect(call.mock.calls.filter(([method]) => method === 'members.list')).toHaveLength(0)

  await store.loadMembers(joined!.id)

  const list = useWorkspaceStore.getState().members[joined!.id]!
  expect(list.members.length).toBeGreaterThan(0)
  expect(list.enrolled).toBe(true)
  expect(list.members.filter((member) => member.isSelf)).toHaveLength(1)
  call.mockRestore()
})

it('adds you to a roster you are not in, and re-reads every roster on screen', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const stop = store.startWatching()
  try {
    // The demo seeds one project the local key is in and one it is not, because
    // the difference between those two is the whole of what the dialog shows.
    const [joined, outsider] = useWorkspaceStore.getState().projects
    await store.loadMembers(joined!.id)
    await store.loadMembers(outsider!.id)
    expect(useWorkspaceStore.getState().members[outsider!.id]?.enrolled).toBe(false)

    const call = vi.spyOn(runtimeClient, 'call')
    await store.joinProject(outsider!.id)

    const after = useWorkspaceStore.getState().members[outsider!.id]!
    expect(after.enrolled).toBe(true)
    expect(after.members.filter((member) => member.isSelf)).toHaveLength(1)

    // The write announces itself, and the announcement re-reads the rosters
    // this window is holding rather than only the one that changed.
    await vi.waitFor(() => {
      const read = call.mock.calls
        .filter(([method]) => method === 'members.list')
        .map(([, params]) => (params as { projectId: string }).projectId)
      expect(new Set(read)).toEqual(new Set([joined!.id, outsider!.id]))
    })
    call.mockRestore()
  } finally {
    stop()
  }
})

it('turns a roster change into a roster refetch and nothing else', () => {
  expect(targetsForEvent({ type: 'members' })).toEqual(refreshTargets({ members: true }))
})
