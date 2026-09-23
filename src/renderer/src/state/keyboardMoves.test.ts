/** @vitest-environment jsdom */

// Getting around without the mouse: the two chords that walk the sidebar, the
// two that walk the panes, and the one that fills the window with the pane you
// are looking at.
//
// What the store owes each of them is different, so they are tested apart. The
// worktree walk owes agreement with the sidebar — proved against
// `worktreeOrder`, which is the function the sidebar itself renders from. The
// pane walk owes reversibility: forwards and backwards written twice would be
// two orders, and a pair of chords that do not undo each other. Maximising owes
// the thing that is easiest to get wrong and hardest to notice — that it
// touches nothing the runtime will save, so a window maximised at midnight does
// not come back tomorrow with one pane in it.
//
// The runtime is a call that never answers, so nothing here depends on one:
// every claim below is about what the store does before it asks anybody.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Layout, PaneNode } from '@shared/entities'

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
const { shownRoot } = await import('../panes/paneLayout')

const INITIAL = useWorkspaceStore.getState()
const store = (): ReturnType<typeof useWorkspaceStore.getState> => useWorkspaceStore.getState()

const project = (id: string) => ({ id, name: id, path: `/repos/${id}`, baseRef: 'origin/main' })

const worktree = (id: string, projectId: string) => ({
  id,
  projectId,
  name: id,
  branch: id,
  path: `/repos/${projectId}-wt/${id}`,
  startedFrom: 'origin/main',
  state: 'ready' as const,
  createdAt: 0
})

/** Two panes side by side, which is the smallest tree worth maximising out of. */
const SPLIT: PaneNode = {
  kind: 'split',
  direction: 'row',
  sizes: [0.5, 0.5],
  children: [
    { kind: 'leaf', terminalId: 't1' },
    { kind: 'leaf', terminalId: 't2' }
  ]
}

const layout = (focusedTerminalId: string): Layout => ({ worktreeId: 'w1', root: SPLIT, focusedTerminalId })

beforeEach(() => {
  call.mockClear()
  useWorkspaceStore.setState({ ...INITIAL }, true)
})

describe('walking the worktrees', () => {
  // Interleaved, the way a runtime answer arrives, so stepping the store's own
  // array and stepping the sidebar's order are visibly different answers.
  beforeEach(() => {
    useWorkspaceStore.setState({
      projects: [project('p1'), project('p2')],
      worktrees: [worktree('w1', 'p1'), worktree('w2', 'p2'), worktree('w3', 'p1'), worktree('w4', 'p2')],
      activeWorktreeId: 'w1'
    })
  })

  it('goes down the sidebar rather than down the store’s list', () => {
    // The store's array says w2 is next. The sidebar draws w3 there, because
    // w3 is the second row under the first project.
    store().stepWorktree(1)
    expect(store().activeWorktreeId).toBe('w3')
    store().stepWorktree(1)
    expect(store().activeWorktreeId).toBe('w2')
  })

  it('wraps at both ends', () => {
    useWorkspaceStore.setState({ activeWorktreeId: 'w4' })
    store().stepWorktree(1)
    expect(store().activeWorktreeId).toBe('w1')
    store().stepWorktree(-1)
    expect(store().activeWorktreeId).toBe('w4')
  })

  it('comes back where it started', () => {
    store().stepWorktree(1)
    store().stepWorktree(-1)
    expect(store().activeWorktreeId).toBe('w1')
  })

  // A worktree the sidebar has no row for is not somewhere a chord can arrive.
  it('never lands on a worktree whose project is not on screen', () => {
    useWorkspaceStore.setState({ projects: [project('p1')], activeWorktreeId: 'w3' })
    store().stepWorktree(1)
    expect(store().activeWorktreeId).toBe('w1')
  })

  it('opens the worktree it lands on, rather than only naming it', () => {
    store().stepWorktree(1)
    expect(store().openWorktreeIds).toContain('w3')
  })
})

describe('walking the panes', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ activeWorktreeId: 'w1', layouts: { w1: layout('t1') } })
  })

  it('goes the other way round the same cycle', () => {
    store().focusPreviousPane()
    expect(store().layouts.w1?.focusedTerminalId).toBe('t2')
    store().focusNextPane()
    expect(store().layouts.w1?.focusedTerminalId).toBe('t1')
  })

  // A teammate's pane is in the cycle in both directions, for the reason it is
  // in it at all: a pane you can type into that a chord refuses to reach is a
  // pane that is only half in the window.
  it('walks backwards out of your own panes and into a teammate’s', () => {
    useWorkspaceStore.setState({
      watches: [{ id: 'watch:p1:priya:t7', projectId: 'p1', paneId: 't7', label: 'priya', handle: 'priya' }]
    })
    store().focusPreviousPane()
    expect(store().focusedWatchId).toBe('watch:p1:priya:t7')
  })
})

describe('maximising a pane', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ activeWorktreeId: 'w1', layouts: { w1: layout('t2') } })
  })

  it('draws the focused pane alone, and the tree again when pressed twice', () => {
    store().toggleExpandedPane()
    expect(store().expandedTerminalId).toBe('t2')
    expect(shownRoot(store().layouts.w1?.root ?? null, store().expandedTerminalId)).toEqual({
      kind: 'leaf',
      terminalId: 't2'
    })

    store().toggleExpandedPane()
    expect(store().expandedTerminalId).toBeNull()
    expect(shownRoot(store().layouts.w1?.root ?? null, store().expandedTerminalId)).toBe(SPLIT)
  })

  // The whole reason it is not in the `Layout`: what the runtime saves is an
  // arrangement, and this is a way of looking at one. A window left maximised
  // must not come back tomorrow with one pane in it.
  it('leaves the saved layout exactly as it was, and tells the runtime nothing', () => {
    const before = store().layouts.w1
    store().toggleExpandedPane()
    expect(store().layouts.w1).toBe(before)
    expect(call.mock.calls.filter(([method]) => method === 'layout.set')).toHaveLength(0)
  })

  it('does not maximise a teammate’s pane, which is not in this tree', () => {
    useWorkspaceStore.setState({ focusedWatchId: 'watch:p1:priya:t7' })
    store().toggleExpandedPane()
    expect(store().expandedTerminalId).toBeNull()
  })

  // Maximising is about the tree in front of you, so it does not travel: the
  // tab you come back to is the tab as you left it.
  it('gives the tree back when another worktree is opened', () => {
    store().toggleExpandedPane()
    void store().openWorktree('w2')
    expect(store().expandedTerminalId).toBeNull()
  })
})
