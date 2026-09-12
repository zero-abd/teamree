import { expect, it, vi } from 'vitest'
import { collectTerminalIds } from '../panes/paneLayout'

vi.mock('../runtimeClient/currentRuntimeClient', async () => {
  const { createSeededRuntimeClient } = await import('../runtimeClient/seededRuntimeClient')
  return { runtimeClient: createSeededRuntimeClient() }
})

import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from './workspaceStore'

it('adds exactly one pane per New terminal action, including with workspace events', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const stop = store.startWatching()
  try {
    const worktreeId = useWorkspaceStore.getState().activeWorktreeId!
    const before = await runtimeClient.call('terminal.list', { worktreeId })
    const call = vi.spyOn(runtimeClient, 'call')
    await store.createTerminal(worktreeId)
    await store.openWorktree(worktreeId)
    const terminals = await runtimeClient.call('terminal.list', { worktreeId })
    const layout = useWorkspaceStore.getState().layouts[worktreeId]!
    const ids = collectTerminalIds(layout.root)
    expect(terminals).toHaveLength(before.length + 1)
    expect(ids).toHaveLength(terminals.length)
    expect(new Set(ids).size).toBe(ids.length)
    expect(layout).toEqual(await runtimeClient.call('layout.get', { worktreeId }))
    expect(call.mock.calls.filter(([method]) => method === 'terminal.create')).toHaveLength(1)
    expect(call.mock.calls.filter(([method]) => method === 'layout.set')).toHaveLength(0)
    call.mockRestore()
  } finally {
    stop()
  }
})

it('reads the changed paths only once the panel is open, and the patch only once a path is picked', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const worktreeId = useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!.id
  await store.openWorktree(worktreeId)

  const call = vi.spyOn(runtimeClient, 'call')
  const changesCalls = (): number => call.mock.calls.filter(([method]) => method === 'worktree.changes').length
  const diffCalls = (): number => call.mock.calls.filter(([method]) => method === 'worktree.diff').length

  // Closed, it costs nothing: a `git status` per refresh for a panel nobody is
  // looking at is exactly the kind of thing that makes an app feel heavy.
  expect(useWorkspaceStore.getState().changesOpen).toBe(false)
  expect(changesCalls()).toBe(0)

  useWorkspaceStore.getState().toggleChanges()
  await vi.waitFor(() => expect(useWorkspaceStore.getState().changes[worktreeId]).toBeDefined())
  expect(changesCalls()).toBe(1)
  const listed = useWorkspaceStore.getState().changes[worktreeId]
  expect(listed?.changes.length).toBeGreaterThan(0)
  expect(diffCalls()).toBe(0)

  const path = listed!.changes[0]!.path
  useWorkspaceStore.getState().selectChange(path)
  await vi.waitFor(() => expect(useWorkspaceStore.getState().diffPending).toBe(false))
  expect(diffCalls()).toBe(1)
  expect(useWorkspaceStore.getState().diff?.patch).toContain('diff --git')

  // Picking the same row again clears it, and clearing costs no call.
  useWorkspaceStore.getState().selectChange(null)
  expect(useWorkspaceStore.getState().diff).toBeNull()
  expect(diffCalls()).toBe(1)
  call.mockRestore()
})

it('does not carry one worktree’s patch across to another worktree', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const ready = useWorkspaceStore.getState().worktrees.filter((entry) => entry.state === 'ready')
  const [first, second] = [ready[0]!, ready[1]!]

  await store.openWorktree(first.id)
  if (!useWorkspaceStore.getState().changesOpen) useWorkspaceStore.getState().toggleChanges()
  await vi.waitFor(() => expect(useWorkspaceStore.getState().changes[first.id]).toBeDefined())

  const path = useWorkspaceStore.getState().changes[first.id]!.changes[0]?.path
  if (path !== undefined) {
    useWorkspaceStore.getState().selectChange(path)
    await vi.waitFor(() => expect(useWorkspaceStore.getState().diff).not.toBeNull())
  }

  await store.openWorktree(second.id)

  expect(useWorkspaceStore.getState().selectedChangePath).toBeNull()
  expect(useWorkspaceStore.getState().diff).toBeNull()
})

it('reads mergeability for ready worktrees, a few at a time', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()

  let inFlight = 0
  let peak = 0
  const original = runtimeClient.call.bind(runtimeClient)
  const call = vi.spyOn(runtimeClient, 'call').mockImplementation(async (method, params) => {
    if (method !== 'worktree.mergePreview') return original(method, params as never)
    inFlight += 1
    peak = Math.max(peak, inFlight)
    try {
      return await original(method, params as never)
    } finally {
      inFlight -= 1
    }
  })

  // A worktree list refresh is what drives the read, the same as it drives the
  // status chips the badge sits beside.
  const worktreeId = useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!.id
  await store.openWorktree(worktreeId)
  await vi.waitFor(() => expect(useWorkspaceStore.getState().mergePreviews[worktreeId]).toBeDefined())

  expect(useWorkspaceStore.getState().mergePreviews[worktreeId]?.baseRef).toBeTruthy()
  // Each preview is a git process; the sidebar is not worth an unbounded fan-out.
  expect(peak).toBeLessThanOrEqual(4)
  call.mockRestore()
})
