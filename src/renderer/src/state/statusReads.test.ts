// What one write in one of 150 worktrees costs the window: a status read for that worktree if its row
// can be seen, nothing if it cannot, and a read the moment it scrolls into view.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Worktree } from '@shared/entities'
import type { WorkspaceEvent } from '@shared/methods'

vi.mock('../runtimeClient/currentRuntimeClient', async () => {
  const { createSeededRuntimeClient } = await import('../runtimeClient/seededRuntimeClient')
  return { runtimeClient: createSeededRuntimeClient() }
})

/** Stands in for the browser's observer: the test says which rows intersect. */
class FakeObserver {
  static current: FakeObserver | undefined
  readonly #callback: IntersectionObserverCallback
  constructor(callback: IntersectionObserverCallback) {
    this.#callback = callback
    FakeObserver.current = this
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  show(elements: Element[], isIntersecting = true): void {
    this.#callback(
      elements.map((target) => ({ target, isIntersecting }) as IntersectionObserverEntry),
      this as unknown as IntersectionObserver
    )
  }
}
vi.stubGlobal('IntersectionObserver', FakeObserver)

type Modules = {
  runtimeClient: typeof import('../runtimeClient/currentRuntimeClient').runtimeClient
  rowVisibility: typeof import('./rowVisibility').rowVisibility
  useWorkspaceStore: typeof import('./workspaceStore').useWorkspaceStore
  UNREAD_READ_MS: number
}

const ROWS = 150
const IN_VIEW = 20

let modules: Modules
let invalidate: (event: WorkspaceEvent) => void
let stop: () => void
let rows: { id: string; element: Element }[]
let asked: (method: string) => string[]
let askedProjects: (method: string) => string[]
const unobserve: (() => void)[] = []

beforeEach(async () => {
  // A fresh store, client and observer per test: what one test read must not count for the next.
  vi.resetModules()
  modules = {
    runtimeClient: (await import('../runtimeClient/currentRuntimeClient')).runtimeClient,
    rowVisibility: (await import('./rowVisibility')).rowVisibility,
    ...(await import('./workspaceStore'))
  }
  const { runtimeClient, rowVisibility, useWorkspaceStore } = modules
  vi.spyOn(runtimeClient, 'watchWorkspace').mockImplementation((onEvent) => {
    invalidate = onEvent
    return { close: async () => undefined }
  })
  const seeded = runtimeClient.call.bind(runtimeClient)
  const projectId = (await seeded('project.list', {}))[0]!.id
  const extra: Worktree[] = Array.from({ length: ROWS }, (_, index) => ({
    id: `wt_row_${index}`,
    projectId,
    name: `row ${index}`,
    branch: `row-${index}`,
    path: `/checkouts/row-${index}`,
    startedFrom: 'main',
    state: 'ready',
    createdAt: index
  }))
  const isExtra = (params: unknown): boolean =>
    String((params as { worktreeId?: string }).worktreeId ?? '').startsWith('wt_row_')
  const call = vi.spyOn(runtimeClient, 'call').mockImplementation((async (method: string, params: unknown) => {
    if (method === 'worktree.list') return [...(await seeded('worktree.list', {})), ...extra]
    if (method === 'worktree.status' && isExtra(params)) {
      const worktreeId = (params as { worktreeId: string }).worktreeId
      return {
        worktreeId,
        branch: 'row',
        ahead: 0,
        behind: 0,
        staged: 0,
        unstaged: 1,
        untracked: 0,
        conflicted: 0,
        readAt: 1
      }
    }
    if ((method === 'worktree.mergePreview' || method === 'worktree.landing') && isExtra(params)) {
      throw new Error('not in the seed')
    }
    return seeded(method as never, params as never)
  }) as typeof runtimeClient.call)
  askedProjects = (method) =>
    call.mock.calls.filter(([name]) => name === method).map(([, params]) => (params as { projectId: string }).projectId)
  asked = (method) =>
    call.mock.calls
      .filter(([name]) => name === method)
      .map(([, params]) => (params as { worktreeId: string }).worktreeId)

  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  stop = store.startWatching()
  rows = extra.map((worktree) => ({ id: worktree.id, element: { id: worktree.id } as unknown as Element }))
  for (const row of rows) unobserve.push(rowVisibility.observe(row.element, row.id))
  FakeObserver.current!.show(rows.slice(0, IN_VIEW).map((row) => row.element))
  await vi.waitFor(() => expect(asked('worktree.status')).toContain(rows[IN_VIEW - 1]!.id))
  call.mockClear()
})

afterEach(() => {
  stop()
  for (const done of unobserve.splice(0)) done()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100))

it('reads rows as they come into view and never the ones out of it', () => {
  const { useWorkspaceStore } = modules
  // The first twenty were read by `beforeEach` as they were shown; nothing else was.
  expect(useWorkspaceStore.getState().statuses[rows[0]!.id]).toBeDefined()
  expect(useWorkspaceStore.getState().statuses[rows[IN_VIEW]!.id]).toBeUndefined()
})

it('reads one worktree for a write in one worktree in view, and only its status', async () => {
  invalidate({ type: 'worktrees', worktreeIds: [rows[3]!.id], paths: ['src/cart.ts'] })
  await vi.waitFor(() => expect(asked('worktree.status')).toEqual([rows[3]!.id]))
  await settle()
  expect(asked('worktree.status')).toEqual([rows[3]!.id])
  expect(asked('worktree.mergePreview')).toEqual([])
  expect(asked('worktree.landing')).toEqual([])
  expect(asked('worktree.list')).toEqual([])
  expect(askedProjects('project.base')).toEqual([])
})

it("reads a project's base only for a change that can have moved it, and only that project's", async () => {
  const { useWorkspaceStore } = modules
  const [first, ...others] = useWorkspaceStore.getState().projects
  invalidate({ type: 'worktrees', worktreeIds: [rows[3]!.id] })
  await vi.waitFor(() => expect(askedProjects('project.base')).toEqual([first!.id]))

  invalidate({ type: 'worktrees' })
  await vi.waitFor(() => expect(askedProjects('project.base')).toHaveLength(2 + others.length))
})

it('reads nothing for a write out of view, then reads that row as it scrolls in', async () => {
  const hidden = rows[100]!
  invalidate({ type: 'worktrees', worktreeIds: [hidden.id], paths: ['src/cart.ts'] })
  await settle()
  expect(asked('worktree.status')).toEqual([])

  FakeObserver.current!.show([hidden.element])
  await vi.waitFor(() => expect(asked('worktree.status')).toEqual([hidden.id]))
  // A row read while it was in view, and untouched since, costs nothing to show again.
  FakeObserver.current!.show([rows[5]!.element], false)
  FakeObserver.current!.show([rows[5]!.element])
  await settle()
  expect(asked('worktree.status')).toEqual([hidden.id])
})

it('reads the tab in front first, then what is in view, for an event that names nobody', async () => {
  const { useWorkspaceStore } = modules
  const { activeWorktreeId, openWorktreeIds } = useWorkspaceStore.getState()
  invalidate({ type: 'worktrees' })
  await vi.waitFor(() => expect(asked('worktree.status')).toContain(rows[IN_VIEW - 1]!.id))
  await settle()
  const order = asked('worktree.status')
  expect(order[0]).toBe(activeWorktreeId)
  expect(order.slice(0, openWorktreeIds.length).sort()).toEqual([...openWorktreeIds].sort())
  expect(new Set(order)).toEqual(new Set([...openWorktreeIds, ...rows.slice(0, IN_VIEW).map((row) => row.id)]))
})

it('fills in rows out of view on the slow beat, a few at a time, then goes quiet', async () => {
  const { useWorkspaceStore, UNREAD_READ_MS } = modules
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  stop()
  stop = useWorkspaceStore.getState().startWatching()
  const beat = async (): Promise<string[]> => {
    const before = asked('worktree.status').length
    vi.advanceTimersByTime(UNREAD_READ_MS)
    await settle()
    return asked('worktree.status').slice(before)
  }

  const first = await beat()
  expect(first.length).toBe(10)
  for (let left = ROWS; left > 0; left -= 10) await beat()
  const read = asked('worktree.status')
  expect(new Set(read).size).toBe(read.length)
  expect(rows.every((row) => useWorkspaceStore.getState().statuses[row.id] !== undefined)).toBe(true)
  expect(await beat()).toEqual([])

  const hidden = rows[120]!
  invalidate({ type: 'worktrees', worktreeIds: [hidden.id], paths: ['src/cart.ts'] })
  await settle()
  expect(await beat()).toEqual([hidden.id])
  expect(await beat()).toEqual([])
})
