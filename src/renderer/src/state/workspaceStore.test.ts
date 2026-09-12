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
