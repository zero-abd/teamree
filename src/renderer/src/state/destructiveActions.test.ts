// The two places in this window that acted before the runtime had agreed: a forced removal
// git could refuse, and a pane taken off screen before the process behind it was closed.

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
  // A failed row can have a complete checkout behind it: a create interrupted by a restart.
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

  // The PTY is still running, so the pane is the only way back to it.
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

// `closeTerminal` is the seam every close path goes through, so the guard is tested there.
// Each test opens a pane of its own: an id taken from the seeded tree may already have been
// closed by the tests above, and a terminal with no record is one the guard says nothing about.
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
    // One shared store, and one test deliberately leaves a question on screen.
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

// A shell at a prompt still closes on one click: a question on every close is one people learn to press through.
it('closes a quiet shell without asking anybody anything', async () => {
  const { worktreeId, terminalId } = await workingPane(undefined)
  useWorkspaceStore.setState((state) => ({
    terminals: { ...state.terminals, [terminalId]: { ...state.terminals[terminalId]!, busy: false } }
  }))

  await useWorkspaceStore.getState().closeTerminal(terminalId)

  expect(useWorkspaceStore.getState().dialog).toBeNull()
  expect(collectTerminalIds(useWorkspaceStore.getState().layouts[worktreeId]!.root)).not.toContain(terminalId)
})
