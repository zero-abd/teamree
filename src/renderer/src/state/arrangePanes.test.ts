// A pane dragged somewhere else, or moved from its menu: the new tree is shown and saved, focused on
// the pane that moved, unless some pane would end under its floor, which is refused and said.

import { expect, it, vi } from 'vitest'
import type { PaneNode } from '@shared/entities'

const measurement = vi.hoisted(() => ({ grid: undefined as { area: unknown; minPane: unknown } | undefined }))

vi.mock('../runtimeClient/currentRuntimeClient', async () => {
  const { createSeededRuntimeClient } = await import('../runtimeClient/seededRuntimeClient')
  return { runtimeClient: createSeededRuntimeClient() }
})

vi.mock('../terminal/paneMetrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../terminal/paneMetrics')>()
  return { ...actual, paneGrid: () => measurement.grid }
})

import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { collectTerminalIds, leaf, movePane, reorderPanes } from '../panes/paneLayout'
import { useWorkspaceStore } from './workspaceStore'

/** The open worktree with its panes as three in a row, the first focused. */
async function threeInARow(): Promise<{ worktreeId: string; ids: string[] }> {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const worktreeId = useWorkspaceStore.getState().activeWorktreeId!
  await store.openWorktree(worktreeId)
  for (let made = 0; made < 3; made++) await useWorkspaceStore.getState().createTerminal(worktreeId)
  const ids = collectTerminalIds(useWorkspaceStore.getState().layouts[worktreeId]!.root).slice(-3)
  const root: PaneNode = { kind: 'split', direction: 'row', sizes: [1 / 3, 1 / 3, 1 / 3], children: ids.map(leaf) }
  useWorkspaceStore.setState((state) => ({
    layouts: { ...state.layouts, [worktreeId]: { worktreeId, root, focusedTerminalId: ids[0]! } }
  }))
  return { worktreeId, ids }
}

it('shows and saves the new order, focused on the pane that moved, and the runtime keeps it', async () => {
  const { worktreeId, ids } = await threeInARow()
  const [a, b, c] = ids as [string, string, string]

  useWorkspaceStore.getState().arrangePanes((root) => reorderPanes(root, c, 0), c)

  const layout = useWorkspaceStore.getState().layouts[worktreeId]!
  expect(collectTerminalIds(layout.root)).toEqual([c, a, b])
  expect(layout.focusedTerminalId).toBe(c)
  await vi.waitFor(async () => {
    const stored = await runtimeClient.call('layout.get', { worktreeId })
    expect(collectTerminalIds(stored.root)).toEqual([c, a, b])
  })
})

it('refuses a move that would leave a pane under its floor, and says so', async () => {
  const { worktreeId, ids } = await threeInARow()
  const [a, , c] = ids as [string, string, string]
  measurement.grid = { area: { width: 1400, height: 300 }, minPane: { width: 337, height: 181 } }
  const before = useWorkspaceStore.getState().layouts[worktreeId]!.root
  const call = vi.spyOn(runtimeClient, 'call')

  // Stacking two panes in a 300px-high area leaves each 150px, under the 181px floor.
  useWorkspaceStore.getState().arrangePanes((root) => movePane(root, a, c, 'bottom'), a)

  expect(useWorkspaceStore.getState().layouts[worktreeId]!.root).toBe(before)
  expect(call.mock.calls.filter(([method]) => method === 'layout.set')).toEqual([])
  expect(useWorkspaceStore.getState().notices.at(-1)?.text).toBe('No room for another pane')

  // Beside it still fits: the pane dropped on gives up half its 695px, and 347 is over 337.
  useWorkspaceStore.getState().arrangePanes((root) => movePane(root, a, c, 'right'), a)
  expect(collectTerminalIds(useWorkspaceStore.getState().layouts[worktreeId]!.root)).toEqual([ids[1], c, a])
  call.mockRestore()
  measurement.grid = undefined
})
