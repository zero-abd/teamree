// The two places in this window that acted before the runtime had agreed.
//
// One forced a removal git was entitled to refuse; the other took a pane off
// the screen and only then asked for the process behind it to be closed. Both
// are the same mistake in different clothes: the UI deciding an outcome the
// runtime owns.

import { expect, it, vi } from 'vitest'
import { collectTerminalIds } from '../panes/paneLayout'

vi.mock('../runtimeClient/currentRuntimeClient', async () => {
  const { createSeededRuntimeClient } = await import('../runtimeClient/seededRuntimeClient')
  return { runtimeClient: createSeededRuntimeClient() }
})

import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from './workspaceStore'

it('retries a failed worktree without forcing away whatever is behind it', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  // A failed row can have a complete checkout behind it — a create the last
  // restart interrupted is marked failed with its files still on disk.
  const failed = useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'failed')!

  const call = vi.spyOn(runtimeClient, 'call')
  store.retryWorktree(failed.id)
  await vi.waitFor(() => expect(call.mock.calls.some(([method]) => method === 'worktree.create')).toBe(true))

  const removals = call.mock.calls.filter(([method]) => method === 'worktree.remove')
  expect(removals).toHaveLength(1)
  expect(removals[0]?.[1]).toEqual({ worktreeId: failed.id, deleteBranch: false })
  call.mockRestore()
})

it('keeps a pane on screen when the runtime could not close the terminal behind it', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const worktreeId = useWorkspaceStore.getState().activeWorktreeId!
  await store.openWorktree(worktreeId)
  const layout = useWorkspaceStore.getState().layouts[worktreeId]!
  const terminalId = collectTerminalIds(layout.root)[0]!

  const original = runtimeClient.call.bind(runtimeClient)
  const call = vi.spyOn(runtimeClient, 'call').mockImplementation(async (method, params) => {
    if (method === 'terminal.close') throw new Error('the runtime could not close it')
    return original(method, params as never)
  })

  await store.closeTerminal(terminalId)

  // The PTY and its process tree are still running, so the pane is the only
  // way back to them: dropping it would strand the work with no way to reach
  // it short of quitting the app.
  const after = useWorkspaceStore.getState()
  expect(collectTerminalIds(after.layouts[worktreeId]!.root)).toContain(terminalId)
  expect(after.terminals[terminalId]).toBeDefined()
  expect(after.notices.some((notice) => notice.tone === 'error')).toBe(true)
  call.mockRestore()
})

it('closes the pane once the runtime has really closed the terminal', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const worktreeId = useWorkspaceStore.getState().activeWorktreeId!
  await store.openWorktree(worktreeId)
  const layout = useWorkspaceStore.getState().layouts[worktreeId]!
  const terminalId = collectTerminalIds(layout.root)[0]!

  await store.closeTerminal(terminalId)

  expect(collectTerminalIds(useWorkspaceStore.getState().layouts[worktreeId]!.root)).not.toContain(terminalId)
  expect(useWorkspaceStore.getState().terminals[terminalId]).toBeUndefined()
})
