/** @vitest-environment jsdom */

// A window too narrow for its panes folds the right panel, then the sidebar, and brings them back;
// a pane it cannot make room for opens zoomed, a tab of the strip, and is never refused.

import { beforeEach, expect, it, vi } from 'vitest'

const measurement = vi.hoisted(() => ({
  grid: undefined as { area: unknown; minPane: unknown; cell: unknown } | undefined
}))

vi.mock('../runtimeClient/currentRuntimeClient', async () => {
  const { createSeededRuntimeClient } = await import('../runtimeClient/seededRuntimeClient')
  return { runtimeClient: createSeededRuntimeClient() }
})

vi.mock('../terminal/paneMetrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../terminal/paneMetrics')>()
  return {
    ...actual,
    newPaneRoom: () => 'full' as const,
    paneGrid: () => measurement.grid
  }
})

import { fileLeavesIn } from '@shared/filePane'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { zoomedPaneSize } from '../terminal/paneMetrics'
import { useWorkspaceStore } from './workspaceStore'

beforeEach(() => {
  measurement.grid = undefined
  useWorkspaceStore.setState({
    notices: [],
    expandedTerminalId: null,
    foldedColumns: {},
    rightPanelOpen: true,
    rightPanelWidth: 340,
    sidebarVisible: true,
    roomHid: { panel: false, sidebar: false }
  })
  localStorage.clear()
  windowWidth(1440)
})

async function openedWorktree(): Promise<string> {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const worktreeId = useWorkspaceStore.getState().activeWorktreeId!
  await store.openWorktree(worktreeId)
  const focused = useWorkspaceStore.getState().layouts[worktreeId]!.focusedTerminalId!
  useWorkspaceStore.setState((state) => ({
    layouts: {
      ...state.layouts,
      [worktreeId]: { worktreeId, root: { kind: 'leaf', terminalId: focused }, focusedTerminalId: focused }
    }
  }))
  return worktreeId
}

const GRID = { area: { width: 400, height: 300 }, minPane: { width: 337, height: 181 }, cell: { width: 8, height: 17 } }

/** The terminal the runtime made last. */
function newest(): string | undefined {
  return Object.keys(useWorkspaceStore.getState().terminals).sort().at(-1)
}

function created(call: { mock: { calls: unknown[][] } }): unknown[] {
  return call.mock.calls.filter(([method]) => method === 'terminal.create').map(([, params]) => params)
}

function windowWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
}

it('opens a pane with no room zoomed, at the whole grid, and says nothing', async () => {
  const worktreeId = await openedWorktree()
  measurement.grid = GRID
  const call = vi.spyOn(runtimeClient, 'call')
  await useWorkspaceStore.getState().createTerminal(worktreeId)
  await useWorkspaceStore.getState().startAgent('claude')

  const [shell, agent] = created(call) as [object, object]
  const size = { ...zoomedPaneSize(GRID.area, GRID.cell), area: GRID.area, minPane: GRID.minPane, cell: GRID.cell }
  expect(shell).toEqual({ worktreeId, ...size })
  expect(agent).toEqual({ worktreeId, command: 'claude', ...size })
  const state = useWorkspaceStore.getState()
  expect(state.expandedTerminalId).toBe(newest())
  expect(state.notices).toEqual([])
  call.mockRestore()
})

it('opens a split with no room as a new pane, zoomed', async () => {
  await openedWorktree()
  measurement.grid = GRID
  const call = vi.spyOn(runtimeClient, 'call')
  await useWorkspaceStore.getState().splitFocusedPane('row')
  expect(call.mock.calls.filter(([method]) => method === 'terminal.split')).toEqual([])
  expect(created(call)).toHaveLength(1)
  const state = useWorkspaceStore.getState()
  expect(state.expandedTerminalId).toBe(newest())
  expect(state.notices).toEqual([])
  call.mockRestore()
})

it('opens Review All with no room as a tab of the strip, zoomed, and says nothing', async () => {
  const worktreeId = await openedWorktree()
  measurement.grid = GRID
  useWorkspaceStore.getState().openReview(worktreeId)

  const state = useWorkspaceStore.getState()
  const review = fileLeavesIn(state.layouts[worktreeId]!.root).find((leaf) => leaf.review === true)
  expect(review).toBeDefined()
  expect(state.expandedTerminalId).toBe(review!.terminalId)
  expect(state.foldedColumns[worktreeId]).toBe(true)
  expect(state.notices).toEqual([])
})

it('opens a file with no room as a tab, zoomed, and a second as another tab', async () => {
  const worktreeId = await openedWorktree()
  measurement.grid = GRID
  useWorkspaceStore.getState().openFilePane(worktreeId, 'README.md')
  useWorkspaceStore.getState().openFilePane(worktreeId, 'src/index.ts', 'split')

  const state = useWorkspaceStore.getState()
  const files = fileLeavesIn(state.layouts[worktreeId]!.root)
  expect(files.map((leaf) => leaf.path)).toEqual(['README.md', 'src/index.ts'])
  expect(state.expandedTerminalId).toBe(files[1]!.terminalId)
  expect(state.notices).toEqual([])
})

it('folds a panel laid over the panes before opening Review, a file, a diff or a terminal, for this window only', async () => {
  const worktreeId = await openedWorktree()
  windowWidth(1000)
  useWorkspaceStore.getState().openReview(worktreeId)
  expect(useWorkspaceStore.getState()).toMatchObject({ rightPanelOpen: false, roomHid: { panel: false } })
  // The habit on disk is still an open panel.
  expect(localStorage.getItem('teamree.shell.rightPanel')).toBeNull()

  useWorkspaceStore.setState({ rightPanelOpen: true })
  useWorkspaceStore.getState().selectChange('README.md')
  expect(useWorkspaceStore.getState().rightPanelOpen).toBe(false)

  // Folded for room, it would come back over the new pane once the room did.
  useWorkspaceStore.setState({ rightPanelOpen: false, roomHid: { panel: true, sidebar: false } })
  await useWorkspaceStore.getState().createTerminal(worktreeId)
  expect(useWorkspaceStore.getState()).toMatchObject({ rightPanelOpen: false, roomHid: { panel: false } })
})

it('leaves a panel beside the panes open when a pane opens', async () => {
  const worktreeId = await openedWorktree()
  windowWidth(1440)
  useWorkspaceStore.getState().openReview(worktreeId)
  useWorkspaceStore.getState().openFilePane(worktreeId, 'README.md')
  expect(useWorkspaceStore.getState().rightPanelOpen).toBe(true)
})

it('folds the panel for room without forgetting it was open, and brings it back', () => {
  useWorkspaceStore.getState().makeRoom({ panel: true, sidebar: false })
  expect(useWorkspaceStore.getState()).toMatchObject({
    rightPanelOpen: false,
    roomHid: { panel: true, sidebar: false }
  })
  // The habit on disk is still an open panel: the next launch in a wide window shows it.
  expect(localStorage.getItem('teamree.shell.rightPanel')).toBeNull()

  useWorkspaceStore.getState().makeRoom({ panel: false, sidebar: false })
  expect(useWorkspaceStore.getState()).toMatchObject({
    rightPanelOpen: true,
    roomHid: { panel: false, sidebar: false }
  })
})

it('hides the sidebar for room but remembers it as shown', () => {
  useWorkspaceStore.getState().makeRoom({ panel: true, sidebar: true })
  expect(useWorkspaceStore.getState()).toMatchObject({ sidebarVisible: false, rightPanelOpen: false })
  expect(JSON.parse(localStorage.getItem('teamree.workspace.session') ?? '{}').sidebarVisible).toBe(true)

  useWorkspaceStore.getState().makeRoom({ panel: false, sidebar: false })
  expect(useWorkspaceStore.getState()).toMatchObject({ sidebarVisible: true, rightPanelOpen: true })
})

it('keeps the panel folded when the sidebar is hidden by hand for room', () => {
  useWorkspaceStore.getState().makeRoom({ panel: true, sidebar: false })
  useWorkspaceStore.getState().hideRegion('sidebar')
  useWorkspaceStore.getState().makeRoom({ panel: false, sidebar: false })
  expect(useWorkspaceStore.getState()).toMatchObject({ rightPanelOpen: false, sidebarVisible: false })
})

it('leaves a panel somebody reopened by hand alone', () => {
  useWorkspaceStore.getState().makeRoom({ panel: true, sidebar: false })
  useWorkspaceStore.getState().toggleRightPanel()
  expect(useWorkspaceStore.getState()).toMatchObject({ rightPanelOpen: true, roomHid: { panel: false } })
  // Room coming back has nothing of its own to restore.
  useWorkspaceStore.getState().toggleRightPanel()
  useWorkspaceStore.getState().makeRoom({ panel: false, sidebar: false })
  expect(useWorkspaceStore.getState().rightPanelOpen).toBe(false)
})
