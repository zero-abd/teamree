/** @vitest-environment jsdom */

// A zoomed pane is a way of looking: going to another pane, splitting or starting one ends it. A split
// with a diff open narrows the file column, then folds it to its tab in the strip, before it is refused.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Layout, PaneNode } from '@shared/entities'
import { fileColumn, fileLeaf } from '@shared/filePane'

const call = vi.fn<(method: string, params: unknown) => Promise<unknown>>(() => new Promise(() => {}))
const measurement = vi.hoisted(() => ({
  grid: undefined as { area: unknown; minPane: unknown; cell: unknown } | undefined
}))

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

vi.mock('../terminal/paneMetrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../terminal/paneMetrics')>()
  return { ...actual, newPaneRoom: () => undefined, paneGrid: () => measurement.grid }
})

const { useWorkspaceStore } = await import('./workspaceStore')
const { splitPane } = await import('../panes/paneLayout')

const INITIAL = useWorkspaceStore.getState()
const store = (): ReturnType<typeof useWorkspaceStore.getState> => useWorkspaceStore.getState()

const leaf = (terminalId: string): PaneNode => ({ kind: 'leaf', terminalId })
const diff = fileColumn(fileLeaf('file:d', 'src/math.ts'))
/** Agent over a shell, the diff from Changes beside them at half the centre. */
const REVIEWING: PaneNode = {
  kind: 'split',
  direction: 'row',
  sizes: [0.5, 0.5],
  children: [{ kind: 'split', direction: 'column', sizes: [0.5, 0.5], children: [leaf('claude'), leaf('zsh')] }, diff]
}

function open(root: PaneNode, focusedTerminalId: string): void {
  const layout: Layout = { worktreeId: 'w1', root, focusedTerminalId }
  useWorkspaceStore.setState({ activeWorktreeId: 'w1', layouts: { w1: layout } })
}

/** The runtime splits the tree it holds, as `terminal.split` does, and says what it made. */
function answerSplits(): void {
  let held: PaneNode | null = store().layouts.w1?.root ?? null
  call.mockImplementation(async (method, params) => {
    if (method === 'layout.set') {
      held = (params as { root: PaneNode }).root
      return undefined
    }
    if (method !== 'terminal.split') return new Promise(() => {})
    const { terminalId, direction } = params as { terminalId: string; direction: 'row' | 'column' }
    const root = splitPane(held, terminalId, direction, 'new')
    return {
      terminal: { id: 'new', worktreeId: 'w1', title: 'zsh', cwd: '/', shell: 'zsh', cols: 80, rows: 24 },
      layout: { worktreeId: 'w1', root, focusedTerminalId: 'new' }
    }
  })
}

beforeEach(() => {
  call.mockReset()
  call.mockImplementation(() => new Promise(() => {}))
  measurement.grid = undefined
  useWorkspaceStore.setState({ ...INITIAL }, true)
})

describe('a zoomed pane', () => {
  beforeEach(() => open(REVIEWING, 'file:d'))

  it('gives the layout back when another pane is picked, then focuses that pane', () => {
    useWorkspaceStore.setState({ expandedTerminalId: 'file:d' })
    store().focusPane('claude')
    expect(store().expandedTerminalId).toBeNull()
    expect(store().layouts.w1?.focusedTerminalId).toBe('claude')
  })

  it('stays zoomed for a click inside it', () => {
    useWorkspaceStore.setState({ expandedTerminalId: 'file:d' })
    store().focusPane('file:d')
    expect(store().expandedTerminalId).toBe('file:d')
  })

  it('gives the layout back before a split, and the split goes where it was asked', async () => {
    answerSplits()
    useWorkspaceStore.setState({ expandedTerminalId: 'file:d' })
    open(REVIEWING, 'claude')
    await store().splitFocusedPane('column')
    expect(store().expandedTerminalId).toBeNull()
    expect(call.mock.calls.find(([method]) => method === 'terminal.split')?.[1]).toMatchObject({
      terminalId: 'claude',
      direction: 'column'
    })
  })

  it('gives the layout back before a new pane', async () => {
    useWorkspaceStore.setState({ expandedTerminalId: 'file:d' })
    void store().createTerminal('w1')
    expect(store().expandedTerminalId).toBeNull()
  })
})

describe('a split with the diff open', () => {
  const min = { width: 329, height: 167 }
  const cell = { width: 7.8, height: 16.25 }

  it('at 1400x900 folds the diff to its tab: four panes, the diff still open and one click away', async () => {
    measurement.grid = { area: { width: 768, height: 818 }, minPane: min, cell }
    open(REVIEWING, 'claude')
    answerSplits()
    await store().splitFocusedPane('row')

    expect(store().notices).toEqual([])
    const root = store().layouts.w1?.root ?? null
    expect(JSON.stringify(root)).toContain('file:d')
    expect(store().foldedColumns.w1).toBe(true)

    // The tab zooms it; picking the agent again folds it back and the agent has the keyboard.
    store().focusPane('file:d')
    expect(store().expandedTerminalId).toBe('file:d')
    store().toggleExpandedPane()
    expect(store().expandedTerminalId).toBeNull()
    expect(store().layouts.w1?.focusedTerminalId).toBe('new')
  })

  it('narrows the column first when that is room enough, and the runtime is told before it splits', async () => {
    measurement.grid = { area: { width: 1100, height: 818 }, minPane: min, cell }
    open(REVIEWING, 'claude')
    answerSplits()
    await store().splitFocusedPane('row')

    const methods = call.mock.calls.map(([method]) => method)
    expect(methods.indexOf('layout.set')).toBeGreaterThanOrEqual(0)
    expect(methods.indexOf('layout.set')).toBeLessThan(methods.indexOf('terminal.split'))
    expect(store().foldedColumns.w1).toBeUndefined()
    expect(store().notices).toEqual([])
  })

  it('brings the column back narrowed once the panes fit beside it, and tells the runtime', () => {
    measurement.grid = { area: { width: 768, height: 818 }, minPane: min, cell }
    const agentAndDiff: PaneNode = {
      kind: 'split',
      direction: 'row',
      sizes: [1 / 3, 2 / 3],
      children: [leaf('claude'), diff]
    }
    open(agentAndDiff, 'claude')
    useWorkspaceStore.setState({ foldedColumns: { w1: true } })
    call.mockImplementation(async () => undefined)
    store().unfoldColumn('w1')

    expect(store().foldedColumns).toEqual({})
    const root = store().layouts.w1?.root
    expect(root?.kind === 'split' && root.sizes[1]).toBeLessThan(0.5)
    expect(call.mock.calls.some(([method]) => method === 'layout.set')).toBe(true)
  })
})
