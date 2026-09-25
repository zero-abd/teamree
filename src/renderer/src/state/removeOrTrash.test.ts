// Remove from teamree forgets and leaves the disk alone; Move to Trash… is the one that deletes.
// Both ask after any unsaved files, and neither touches the window before the runtime agrees.

import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('../runtimeClient/currentRuntimeClient', async () => {
  const { createSeededRuntimeClient } = await import('../runtimeClient/seededRuntimeClient')
  return { runtimeClient: createSeededRuntimeClient() }
})

import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from './workspaceStore'

const INITIAL = useWorkspaceStore.getState()

beforeEach(async () => {
  vi.restoreAllMocks()
  useWorkspaceStore.setState(INITIAL, true)
  await useWorkspaceStore.getState().bootstrap()
})

const firstReady = () => useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!

it('asks before removing a worktree from teamree, then forgets it without deleting', async () => {
  const worktree = firstReady()
  const call = vi.spyOn(runtimeClient, 'call')

  await useWorkspaceStore.getState().removeFromTeamree({ worktreeId: worktree.id })
  expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'confirm-forget', target: { worktreeId: worktree.id } })
  expect(call).not.toHaveBeenCalledWith('worktree.forget', expect.anything())

  await useWorkspaceStore.getState().confirmForget({ worktreeId: worktree.id })

  expect(call).toHaveBeenCalledWith('worktree.forget', { worktreeId: worktree.id })
  expect(call).not.toHaveBeenCalledWith('worktree.remove', expect.anything())
  expect(useWorkspaceStore.getState().worktrees.some((entry) => entry.id === worktree.id)).toBe(false)
  expect(useWorkspaceStore.getState().dialog).toBeNull()
})

it('asks about unsaved files first, then the removal', async () => {
  const worktree = firstReady()
  useWorkspaceStore.setState({ editedFiles: { 'file:a': { worktreeId: worktree.id, path: 'a.ts' } } })

  await useWorkspaceStore.getState().removeFromTeamree({ projectId: worktree.projectId })
  expect(useWorkspaceStore.getState().dialog).toMatchObject({ kind: 'confirm-unsaved', paneIds: ['file:a'] })

  await useWorkspaceStore.getState().answerUnsaved('discard')
  expect(useWorkspaceStore.getState().dialog).toEqual({
    kind: 'confirm-forget',
    target: { projectId: worktree.projectId }
  })
})

it('removes a project from teamree with every worktree of it, and nothing else', async () => {
  const { projectId } = firstReady()
  const call = vi.spyOn(runtimeClient, 'call')

  await useWorkspaceStore.getState().confirmForget({ projectId })

  expect(call).toHaveBeenCalledWith('project.remove', { projectId })
  const after = useWorkspaceStore.getState()
  expect(after.projects.some((project) => project.id === projectId)).toBe(false)
  expect(after.worktrees.some((entry) => entry.projectId === projectId)).toBe(false)
})

it('moves a project to the Trash only after its own question', async () => {
  const { projectId } = firstReady()
  const name = useWorkspaceStore.getState().projects.find((project) => project.id === projectId)!.name
  const original = runtimeClient.call.bind(runtimeClient)
  const call = vi.spyOn(runtimeClient, 'call').mockImplementation(async (method, params) => {
    if (method === 'project.trash') return { trashed: true } as never
    return original(method, params as never)
  })

  await useWorkspaceStore.getState().trashProject(projectId)
  expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'confirm-trash-project', projectId })
  expect(call).not.toHaveBeenCalledWith('project.trash', expect.anything())

  await useWorkspaceStore.getState().confirmTrashProject(projectId)

  expect(call).toHaveBeenCalledWith('project.trash', { projectId })
  const after = useWorkspaceStore.getState()
  expect(after.projects.some((project) => project.id === projectId)).toBe(false)
  expect(after.worktrees.some((entry) => entry.projectId === projectId)).toBe(false)
  expect(after.notices.at(-1)).toMatchObject({ text: `Moved "${name}" to Trash`, tone: 'info' })
})

it('keeps the project on screen when the Trash refuses', async () => {
  const { projectId } = firstReady()

  await useWorkspaceStore.getState().confirmTrashProject(projectId)

  const after = useWorkspaceStore.getState()
  expect(after.projects.some((project) => project.id === projectId)).toBe(true)
  expect(after.notices.at(-1)?.tone).toBe('error')
})
