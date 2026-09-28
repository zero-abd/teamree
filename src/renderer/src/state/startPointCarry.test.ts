/** @vitest-environment jsdom */

// Start points an older build kept in one window's localStorage move onto their projects once, then leave storage.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Project } from '@shared/entities'

const KEY = 'teamree.worktree.startPoints'

vi.mock('../runtimeClient/currentRuntimeClient', async () => {
  const { createSeededRuntimeClient } = await import('../runtimeClient/seededRuntimeClient')
  return { runtimeClient: createSeededRuntimeClient() }
})

const { runtimeClient } = await import('../runtimeClient/currentRuntimeClient')
const { useWorkspaceStore } = await import('./workspaceStore')

const INITIAL = useWorkspaceStore.getState()
const PROJECTS: Project[] = [
  { id: 'p1', name: 'shop', path: '/repos/shop', baseRef: 'origin/main' },
  { id: 'p2', name: 'api', path: '/repos/api', baseRef: 'origin/main', startPoint: 'release' },
  { id: 'p3', name: 'docs', path: '/repos/docs', baseRef: 'origin/main' }
]

let saved: Array<Record<string, unknown>>

beforeEach(() => {
  saved = []
  useWorkspaceStore.setState(INITIAL, true)
  const call = runtimeClient.call.bind(runtimeClient)
  vi.spyOn(runtimeClient, 'call').mockImplementation((async (method: string, params: Record<string, unknown>) => {
    if (method === 'project.list') return PROJECTS
    if (method === 'project.setPaths') {
      saved.push(params)
      if (params.startPoint === 'origin/mainmain~2') throw new Error('origin/mainmain~2 · no such ref')
      return { ...PROJECTS.find((entry) => entry.id === params.projectId), startPoint: params.startPoint }
    }
    return call(method as never, params as never)
  }) as never)
})

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

const settle = async (): Promise<void> => {
  await vi.waitFor(() => expect(window.localStorage.getItem(KEY)).toBeNull())
  await new Promise((resolve) => setTimeout(resolve, 0))
}

it('moves each onto its project once, leaving a project that has its own and one that is gone', async () => {
  window.localStorage.setItem(KEY, JSON.stringify({ p1: 'develop', p2: 'main', gone: 'main' }))
  await useWorkspaceStore.getState().bootstrap()
  await settle()

  expect(saved).toEqual([{ projectId: 'p1', startPoint: 'develop' }])
  const projects = useWorkspaceStore.getState().projects
  expect(projects.find((entry) => entry.id === 'p1')?.startPoint).toBe('develop')
  expect(projects.find((entry) => entry.id === 'p2')?.startPoint).toBe('release')

  // Once: a second launch finds nothing left to carry.
  await useWorkspaceStore.getState().bootstrap()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(saved).toHaveLength(1)
})

it('says so when the runtime refuses one, and still clears storage', async () => {
  window.localStorage.setItem(KEY, JSON.stringify({ p3: 'origin/mainmain~2' }))
  await useWorkspaceStore.getState().bootstrap()
  await settle()

  await vi.waitFor(() =>
    expect(useWorkspaceStore.getState().notices.map((notice) => notice.text)).toContain(
      'Could not keep the start point for docs: origin/mainmain~2 · no such ref'
    )
  )
  expect(useWorkspaceStore.getState().projects.find((entry) => entry.id === 'p3')?.startPoint).toBeUndefined()
})
