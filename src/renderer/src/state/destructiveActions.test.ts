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

// The guard is on the store action and not on the buttons, which is the whole
// point of it: there are three ways to close a pane — the pane bar's ×, the
// close-pane chord, and the × on each tab above the panes — and a check written
// into each of them is a check the fourth one is written without. These two
// tests are about `closeTerminal` itself, because that is the seam every one of
// those paths goes through.
//
// Each opens a pane of its own rather than borrowing one from the layout. The
// tests above close panes out of the same seeded workspace, so by the time
// these run an id taken from the tree can be one whose record has already gone
// — and a terminal the window has no record of is, correctly, one this guard
// says nothing about. That made an earlier version of these tests pass for a
// reason that had nothing to do with what they were asking.
async function workingPane(agent: 'claude' | undefined): Promise<{ worktreeId: string; terminalId: string }> {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const worktreeId = useWorkspaceStore.getState().activeWorktreeId!
  await store.openWorktree(worktreeId)

  const before = new Set(Object.keys(useWorkspaceStore.getState().terminals))
  await store.createTerminal(worktreeId)
  const terminalId = Object.keys(useWorkspaceStore.getState().terminals).find((id) => !before.has(id))!
  expect(useWorkspaceStore.getState().terminals[terminalId]).toBeDefined()

  useWorkspaceStore.setState((state) => ({
    terminals: {
      ...state.terminals,
      [terminalId]: { ...state.terminals[terminalId]!, agent, busy: true, running: true }
    },
    // These tests share one store, and one of them deliberately leaves a
    // question on the screen. Starting from no dialog is what lets the next one
    // assert that nothing asked.
    dialog: null
  }))
  return { worktreeId, terminalId }
}

it('asks before killing a pane that is still doing work, and kills nothing until answered', async () => {
  // An agent pane mid-sentence: the most expensive click in the application.
  const { worktreeId, terminalId } = await workingPane('claude')

  const call = vi.spyOn(runtimeClient, 'call')
  await useWorkspaceStore.getState().closeTerminal(terminalId)

  expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'confirm-close-pane', terminalId })
  expect(call.mock.calls.filter(([method]) => method === 'terminal.close')).toHaveLength(0)
  // Still on screen and still reachable, which is the thing being protected.
  expect(collectTerminalIds(useWorkspaceStore.getState().layouts[worktreeId]!.root)).toContain(terminalId)
  call.mockRestore()
})

it('closes a working pane once somebody has actually said so', async () => {
  const { worktreeId, terminalId } = await workingPane('claude')

  await useWorkspaceStore.getState().forceCloseTerminal(terminalId)

  expect(collectTerminalIds(useWorkspaceStore.getState().layouts[worktreeId]!.root)).not.toContain(terminalId)
  expect(useWorkspaceStore.getState().terminals[terminalId]).toBeUndefined()
})

// The other half of the decision, and the one that keeps the guard worth
// obeying: a shell at a prompt is the ordinary pane and it still closes on one
// click. A question asked on every close is one people learn to press through.
it('closes a quiet shell without asking anybody anything', async () => {
  const { worktreeId, terminalId } = await workingPane(undefined)
  useWorkspaceStore.setState((state) => ({
    terminals: { ...state.terminals, [terminalId]: { ...state.terminals[terminalId]!, busy: false } }
  }))

  await useWorkspaceStore.getState().closeTerminal(terminalId)

  expect(useWorkspaceStore.getState().dialog).toBeNull()
  expect(collectTerminalIds(useWorkspaceStore.getState().layouts[worktreeId]!.root)).not.toContain(terminalId)
})
