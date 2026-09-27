/** @vitest-environment jsdom */

// Go Back and Go Forward over the worktrees opened, however they were opened. The runtime is a call that never answers.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Layout } from '@shared/entities'

const call = vi.fn<(method: string, params: unknown) => Promise<unknown>>(() => new Promise(() => {}))

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (method: string, params: unknown) => call(method, params),
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('./workspaceStore')
const { EMPTY_VISITS, readStoredVisits } = await import('./visitHistory')

const INITIAL = useWorkspaceStore.getState()
const store = (): ReturnType<typeof useWorkspaceStore.getState> => useWorkspaceStore.getState()

const worktree = (id: string) => ({
  id,
  projectId: 'p1',
  name: id,
  branch: id,
  path: `/repos/p1-wt/${id}`,
  startedFrom: 'origin/main',
  state: 'ready' as const,
  createdAt: 0
})

const twoPanes = (worktreeId: string, focusedTerminalId: string): Layout => ({
  worktreeId,
  root: {
    kind: 'split',
    direction: 'row',
    sizes: [0.5, 0.5],
    children: [
      { kind: 'leaf', terminalId: `${worktreeId}-t1` },
      { kind: 'leaf', terminalId: `${worktreeId}-t2` }
    ]
  },
  focusedTerminalId
})

beforeEach(() => {
  call.mockClear()
  useWorkspaceStore.setState({ ...INITIAL, visits: EMPTY_VISITS }, true)
  useWorkspaceStore.setState({
    projects: [{ id: 'p1', name: 'p1', path: '/repos/p1', baseRef: 'origin/main' }],
    worktrees: ['a', 'b', 'c', 'd'].map(worktree)
  })
})

const go = (...ids: string[]): void => {
  for (const id of ids) void store().openWorktree(id)
}

describe('going back', () => {
  it('walks the worktrees opened, two back and one forward', () => {
    go('a', 'b', 'c', 'd')
    store().stepHistory(-1)
    expect(store().activeWorktreeId).toBe('c')
    store().stepHistory(-1)
    expect(store().activeWorktreeId).toBe('b')
    store().stepHistory(1)
    expect(store().activeWorktreeId).toBe('c')
  })

  it('counts a worktree reached any way, the sidebar walk included', () => {
    go('a')
    store().stepWorktree(1)
    expect(store().activeWorktreeId).toBe('b')
    store().stepHistory(-1)
    expect(store().activeWorktreeId).toBe('a')
  })

  it('skips a worktree that has been removed', () => {
    go('a', 'b', 'c')
    useWorkspaceStore.setState({ worktrees: ['a', 'c'].map(worktree) })
    store().stepHistory(-1)
    expect(store().activeWorktreeId).toBe('a')
  })

  it('puts the keyboard back in the pane it was in', async () => {
    useWorkspaceStore.setState({ layouts: { a: twoPanes('a', 'a-t1'), b: twoPanes('b', 'b-t1') } })
    go('a')
    store().focusPane('a-t2')
    go('b')
    useWorkspaceStore.setState({ layouts: { ...store().layouts, a: twoPanes('a', 'a-t1') } })
    store().stepHistory(-1)
    await vi.waitFor(() => expect(store().layouts.a?.focusedTerminalId).toBe('a-t2'))
  })

  it('is kept for the next launch', () => {
    go('a', 'b')
    const kept = readStoredVisits(window.localStorage)
    expect(kept.visits.map((entry) => entry.worktreeId)).toEqual(['a', 'b'])
  })
})
