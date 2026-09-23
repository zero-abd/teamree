// What one file changing in one worktree is allowed to cost: a coarse `worktrees` event must not
// put every ready worktree in every project up for `git status` and `git merge-tree`, and narrowing
// to what is rendered is only safe if a row coming into view is read the moment it does.

import { expect, it, vi } from 'vitest'
import type { WorkspaceEvent } from '@shared/methods'

vi.mock('../runtimeClient/currentRuntimeClient', async () => {
  const { createSeededRuntimeClient } = await import('../runtimeClient/seededRuntimeClient')
  return { runtimeClient: createSeededRuntimeClient() }
})

import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from './workspaceStore'

it('spends a git read only on the worktrees that are on screen', async () => {
  // The store's own stream callback, so a coarse invalidation is delivered the way the watcher delivers one.
  let invalidate: ((event: WorkspaceEvent) => void) | undefined
  const watch = vi.spyOn(runtimeClient, 'watchWorkspace').mockImplementation((onEvent) => {
    invalidate = onEvent
    return { close: () => undefined }
  })

  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const stop = store.startWatching()
  try {
    const open = useWorkspaceStore.getState().activeWorktreeId!
    const openProjectId = useWorkspaceStore.getState().worktrees.find((entry) => entry.id === open)!.projectId
    const elsewhere = useWorkspaceStore.getState().projects.find((project) => project.id !== openProjectId)!

    const ready = (projectId: string): string[] =>
      useWorkspaceStore
        .getState()
        .worktrees.filter((entry) => entry.projectId === projectId && entry.state === 'ready')
        .map((entry) => entry.id)

    const collapsed = ready(elsewhere.id)
    const sameProject = ready(openProjectId).filter((id) => id !== open)
    expect(collapsed.length).toBeGreaterThan(0)
    expect(sameProject.length).toBeGreaterThan(0)

    useWorkspaceStore.getState().toggleProject(elsewhere.id)
    expect(useWorkspaceStore.getState().collapsedProjects[elsewhere.id]).toBe(true)

    const call = vi.spyOn(runtimeClient, 'call')
    const asked = (method: string): string[] =>
      call.mock.calls
        .filter(([name]) => name === method)
        .map(([, params]) => (params as { worktreeId: string }).worktreeId)

    invalidate!({ type: 'worktrees' })

    // Every status of one batch is issued together, so the open tab appearing means the whole batch has.
    await vi.waitFor(() => expect(asked('worktree.status')).toContain(open))
    await vi.waitFor(() => expect(asked('worktree.mergePreview')).toContain(open))

    // A row in an expanded project is on screen even with no tab open.
    for (const worktreeId of sameProject) {
      expect(asked('worktree.status')).toContain(worktreeId)
    }
    // A row inside a collapsed project is not.
    for (const worktreeId of collapsed) {
      expect(asked('worktree.status')).not.toContain(worktreeId)
      expect(asked('worktree.mergePreview')).not.toContain(worktreeId)
    }

    // And the moment it comes back into view it is read.
    call.mockClear()
    useWorkspaceStore.getState().toggleProject(elsewhere.id)
    await vi.waitFor(() => expect(asked('worktree.status')).toContain(collapsed[0]!))
    await vi.waitFor(() => expect(asked('worktree.mergePreview')).toContain(collapsed[0]!))
    call.mockRestore()
  } finally {
    stop()
    watch.mockRestore()
  }
})
