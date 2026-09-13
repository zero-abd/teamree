// Reopening the window somebody quit, rather than a window nobody had.
//
// Each case runs in its own module graph, because what the window remembers is
// read as the store is built — the same moment the sidebar's width is read.

import { expect, it, vi } from 'vitest'
import type { useWorkspaceStore as Store } from './workspaceStore'

vi.mock('../runtimeClient/currentRuntimeClient', async () => {
  const { createSeededRuntimeClient } = await import('../runtimeClient/seededRuntimeClient')
  return { runtimeClient: createSeededRuntimeClient() }
})

/** localStorage as a browser gives it, seeded with one previous window. */
function storageWith(seed: Record<string, string>): Storage {
  const entries = new Map(Object.entries(seed))
  return {
    get length() {
      return entries.size
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => entries.delete(key),
    setItem: (key: string, value: string) => {
      entries.set(key, value)
    }
  } as Storage
}

/** A window opened with `seed` already in storage. */
async function windowWith(seed: Record<string, string>): Promise<typeof Store> {
  vi.resetModules()
  vi.stubGlobal('window', { localStorage: storageWith(seed) })
  const { useWorkspaceStore } = await import('./workspaceStore')
  return useWorkspaceStore
}

const SESSION_KEY = 'teamree.workspace.session'

/** The worktrees this workspace has, learned from a window that remembers none. */
async function readyWorktreeIds(): Promise<string[]> {
  const store = await windowWith({})
  await store.getState().bootstrap()
  return store
    .getState()
    .worktrees.filter((worktree) => worktree.state === 'ready')
    .map((worktree) => worktree.id)
}

it('opens the tabs the last window had, with the same one in front', async () => {
  const ready = await readyWorktreeIds()
  expect(ready.length).toBeGreaterThan(2)

  const store = await windowWith({
    [SESSION_KEY]: JSON.stringify({ openWorktreeIds: ready, activeWorktreeId: ready[1] })
  })
  await store.getState().bootstrap()

  expect(store.getState().openWorktreeIds).toEqual(ready)
  expect(store.getState().activeWorktreeId).toBe(ready[1])
})

it('drops a remembered worktree that is no longer there', async () => {
  const ready = await readyWorktreeIds()
  const kept = ready[ready.length - 1]!

  const store = await windowWith({
    [SESSION_KEY]: JSON.stringify({ openWorktreeIds: ['wt_removed_by_somebody', kept], activeWorktreeId: kept })
  })
  await store.getState().bootstrap()

  expect(store.getState().openWorktreeIds).toEqual([kept])
  expect(store.getState().activeWorktreeId).toBe(kept)
})

it('falls back to a ready worktree when nothing remembered is left, or nothing was written', async () => {
  const ready = await readyWorktreeIds()

  const gone = await windowWith({ [SESSION_KEY]: JSON.stringify({ openWorktreeIds: ['wt_gone'] }) })
  await gone.getState().bootstrap()
  expect(gone.getState().openWorktreeIds).toEqual([ready[0]])

  const rubbish = await windowWith({ [SESSION_KEY]: 'not json at all' })
  await rubbish.getState().bootstrap()
  expect(rubbish.getState().openWorktreeIds).toEqual([ready[0]])

  const blank = await windowWith({})
  await blank.getState().bootstrap()
  expect(blank.getState().openWorktreeIds).toEqual([ready[0]])
})

it('remembers the sidebar the way it remembers its width', async () => {
  const store = await windowWith({
    [SESSION_KEY]: JSON.stringify({ collapsedProjects: { p_atlas: true }, sidebarVisible: false })
  })

  expect(store.getState().sidebarVisible).toBe(false)
  expect(store.getState().collapsedProjects).toEqual({ p_atlas: true })
})

it('writes down what the window is showing as it changes', async () => {
  const entries: Record<string, string> = {}
  vi.resetModules()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => entries[key] ?? null,
      setItem: (key: string, value: string) => {
        entries[key] = value
      }
    }
  })
  const { useWorkspaceStore } = await import('./workspaceStore')
  await useWorkspaceStore.getState().bootstrap()

  const ready = useWorkspaceStore.getState().worktrees.filter((worktree) => worktree.state === 'ready')
  await useWorkspaceStore.getState().openWorktree(ready[ready.length - 1]!.id)
  useWorkspaceStore.getState().toggleSidebar()

  const written = JSON.parse(entries[SESSION_KEY] ?? '{}') as {
    openWorktreeIds: string[]
    activeWorktreeId: string
    sidebarVisible: boolean
  }
  expect(written.openWorktreeIds).toContain(ready[ready.length - 1]!.id)
  expect(written.activeWorktreeId).toBe(ready[ready.length - 1]!.id)
  expect(written.sidebarVisible).toBe(false)
})
