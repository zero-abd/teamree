// A file pane is made by writing the tree, found again by its path, comes back
// with the layout, and closes without asking the runtime to end anything.

import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_MARKDOWN_PATH, fileLeavesIn } from '@shared/filePane'
import { collectTerminalIds } from '../panes/paneLayout'

vi.mock('../runtimeClient/currentRuntimeClient', async () => {
  const { createSeededRuntimeClient } = await import('../runtimeClient/seededRuntimeClient')
  return { runtimeClient: createSeededRuntimeClient() }
})

import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from './workspaceStore'

async function openReady(): Promise<string> {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const worktreeId = useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!.id
  await store.openWorktree(worktreeId)
  return worktreeId
}

const calls = (spy: { mock: { calls: unknown[][] } }, method: string): unknown[][] =>
  spy.mock.calls.filter(([name]) => name === method)

describe('file panes in the store', () => {
  it('creates NOTES.md beside the focused pane, and comes back with the layout', async () => {
    const worktreeId = await openReady()
    const before = collectTerminalIds(useWorkspaceStore.getState().layouts[worktreeId]!.root)
    const call = vi.spyOn(runtimeClient, 'call')

    useWorkspaceStore.getState().newMarkdown(worktreeId)
    const layout = useWorkspaceStore.getState().layouts[worktreeId]!
    const [leaf] = fileLeavesIn(layout.root)
    expect(leaf?.path).toBe(DEFAULT_MARKDOWN_PATH)
    expect(layout.focusedTerminalId).toBe(leaf?.terminalId)
    expect(collectTerminalIds(layout.root)).toHaveLength(before.length + 1)
    expect(calls(call, 'layout.set')).toHaveLength(1)
    expect(calls(call, 'terminal.create')).toHaveLength(0)

    // Leaving and coming back reads the tree from the runtime, leaf included.
    await vi.waitFor(async () => {
      expect(fileLeavesIn((await runtimeClient.call('layout.get', { worktreeId })).root)).toHaveLength(1)
    })
    const other = useWorkspaceStore.getState().worktrees.find((entry) => entry.id !== worktreeId)!
    await useWorkspaceStore.getState().openWorktree(other.id)
    await useWorkspaceStore.getState().openWorktree(worktreeId)
    expect(fileLeavesIn(useWorkspaceStore.getState().layouts[worktreeId]!.root)).toEqual([leaf])
    call.mockRestore()
  })

  it('focuses the pane already on a path rather than opening a second, and asks for a name for the next', async () => {
    const worktreeId = await openReady()
    useWorkspaceStore.getState().openFilePane(worktreeId, 'docs/plan.md')
    const first = fileLeavesIn(useWorkspaceStore.getState().layouts[worktreeId]!.root).find(
      (leaf) => leaf.path === 'docs/plan.md'
    )!
    useWorkspaceStore
      .getState()
      .focusPane(collectTerminalIds(useWorkspaceStore.getState().layouts[worktreeId]!.root)[0]!)
    useWorkspaceStore.getState().openFilePane(worktreeId, 'docs/plan.md')
    const layout = useWorkspaceStore.getState().layouts[worktreeId]!
    expect(fileLeavesIn(layout.root).filter((leaf) => leaf.path === 'docs/plan.md')).toHaveLength(1)
    expect(layout.focusedTerminalId).toBe(first.terminalId)

    useWorkspaceStore.getState().newMarkdown(worktreeId)
    useWorkspaceStore.getState().newMarkdown(worktreeId)
    expect(useWorkspaceStore.getState().namingMarkdown).toBe(worktreeId)
    useWorkspaceStore.getState().nameMarkdown('ideas')
    expect(useWorkspaceStore.getState().namingMarkdown).toBeNull()
    expect(fileLeavesIn(useWorkspaceStore.getState().layouts[worktreeId]!.root).map((leaf) => leaf.path)).toContain(
      'ideas.md'
    )
    useWorkspaceStore.getState().newMarkdown(worktreeId)
    useWorkspaceStore.getState().nameMarkdown(null)
    expect(useWorkspaceStore.getState().namingMarkdown).toBeNull()
  })

  it('closes a file pane by rewriting the tree, never by ending a terminal', async () => {
    const worktreeId = await openReady()
    useWorkspaceStore.getState().openFilePane(worktreeId, 'closing.md')
    const leaf = fileLeavesIn(useWorkspaceStore.getState().layouts[worktreeId]!.root).find(
      (entry) => entry.path === 'closing.md'
    )!
    useWorkspaceStore.getState().setFileUnsaved(leaf.terminalId, true)
    expect(useWorkspaceStore.getState().unsavedFiles[leaf.terminalId]).toBe(true)

    const call = vi.spyOn(runtimeClient, 'call')
    await useWorkspaceStore.getState().closeTerminal(leaf.terminalId)
    expect(calls(call, 'terminal.close')).toHaveLength(0)
    expect(calls(call, 'layout.set')).toHaveLength(1)
    const layout = useWorkspaceStore.getState().layouts[worktreeId]!
    expect(collectTerminalIds(layout.root)).not.toContain(leaf.terminalId)
    expect(layout.focusedTerminalId).not.toBe(leaf.terminalId)
    expect(useWorkspaceStore.getState().unsavedFiles[leaf.terminalId]).toBeUndefined()
    expect(useWorkspaceStore.getState().dialog).toBeNull()
    call.mockRestore()
  })

  it('refuses the find bar on a file pane, which has no scrollback to search', async () => {
    const worktreeId = await openReady()
    useWorkspaceStore.getState().openFilePane(worktreeId, 'find.md')
    useWorkspaceStore.getState().openPaneSearch()
    expect(useWorkspaceStore.getState().paneSearch).toBeNull()
  })
})
