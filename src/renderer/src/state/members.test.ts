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
    // The demo seeds one project the local key is in and one it is not.
    const [joined, outsider] = useWorkspaceStore.getState().projects
    await store.loadMembers(joined!.id)
    await store.loadMembers(outsider!.id)
    expect(useWorkspaceStore.getState().members[outsider!.id]?.enrolled).toBe(false)

    const call = vi.spyOn(runtimeClient, 'call')
    await store.joinProject(outsider!.id)

    const after = useWorkspaceStore.getState().members[outsider!.id]!
    expect(after.enrolled).toBe(true)
    expect(after.members.filter((member) => member.isSelf)).toHaveLength(1)

    // The write announces itself, and the announcement re-reads every roster this window holds.
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

it('writes the relay into the project and leaves committing it to the user', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const [, outsider] = useWorkspaceStore.getState().projects
  await store.loadRelay(outsider!.id)
  expect(useWorkspaceStore.getState().relays[outsider!.id]?.url).toBeNull()

  await store.setRelay(outsider!.id, 'wss://relay.example/v1/relay')

  const setting = useWorkspaceStore.getState().relays[outsider!.id]!
  expect(setting.url).toBe('wss://relay.example/v1/relay')
  expect(setting.source).toBe('repository')
  // Said where somebody will read it, because the file is only half the step.
  expect(useWorkspaceStore.getState().notices.at(-1)?.text).toContain('.teamree/relay')
})

it('says whether the override was seen, not only whether it won', async () => {
  // "I set TEAMREE_RELAY_URL and nothing happened" has no answer unless the app reports having looked.
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const [joined] = useWorkspaceStore.getState().projects

  await store.loadRelay(joined!.id)

  expect(useWorkspaceStore.getState().relays[joined!.id]?.override).toEqual({
    name: 'TEAMREE_RELAY_URL',
    value: null
  })
})

it('re-reads the relay on the same change that re-reads the roster', async () => {
  // One directory, one watch, one event: a pull bringing a key and a relay must not need two of anything.
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const stop = store.startWatching()
  try {
    const [joined, outsider] = useWorkspaceStore.getState().projects
    await store.loadRelay(joined!.id)
    await store.loadRelay(outsider!.id)

    const call = vi.spyOn(runtimeClient, 'call')
    await store.setRelay(outsider!.id, 'ws://127.0.0.1:8787/v1/relay')

    await vi.waitFor(() => {
      const read = call.mock.calls
        .filter(([method]) => method === 'teamwork.relay')
        .map(([, params]) => (params as { projectId: string }).projectId)
      expect(read).toContain(joined!.id)
    })
    call.mockRestore()
  } finally {
    stop()
  }
})

it('keeps a refused join in the panel rather than in a notice', async () => {
  // Every refusal here ends in "choose another handle", an instruction about a field; a notice
  // under the modal's own scrim was never seen.
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const [, outsider] = useWorkspaceStore.getState().projects
  await store.loadMembers(outsider!.id)

  const taken = '.teamree/members/ana.pub is already somebody else’s key; choose another handle'
  const call = vi.spyOn(runtimeClient, 'call').mockRejectedValueOnce(new Error(taken))
  await store.joinProject(outsider!.id, 'ana')
  expect(call).toHaveBeenCalledWith('members.join', { projectId: outsider!.id, handle: 'ana' })
  call.mockRestore()

  const after = useWorkspaceStore.getState()
  expect(after.membersError).toBe(taken)
  expect(after.membersPending).toBe(false)
  // One sentence, in one place: under the box it is about.
  expect(after.notices.map((notice) => notice.text)).not.toContain(taken)
})

it('drops the refusal on the keystroke that answers it', () => {
  useWorkspaceStore.setState({ membersError: 'choose another handle' })
  useWorkspaceStore.getState().clearMembersError()
  expect(useWorkspaceStore.getState().membersError).toBeNull()
})

it('does not carry one project’s refusal into another’s panel', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const [joined] = useWorkspaceStore.getState().projects

  useWorkspaceStore.setState({ membersError: 'choose another handle' })
  await store.loadMembers(joined!.id)

  expect(useWorkspaceStore.getState().membersError).toBeNull()
})
