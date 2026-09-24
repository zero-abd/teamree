// The window says how big the pane is, because only the window knows: a pty
// born 80x24 draws its first frame to the wrong width. Left out when there is
// nothing on screen to measure.

import { expect, it, vi } from 'vitest'

const AREA = { width: 1000, height: 800 }
const MIN_PANE = { width: 337, height: 181 }

const measurement = vi.hoisted(() => ({
  size: undefined as { cols: number; rows: number; area: unknown; minPane: unknown } | 'full' | undefined,
  grid: undefined as { area: unknown; minPane: unknown; cell: unknown } | undefined,
  asked: [] as unknown[]
}))

vi.mock('../runtimeClient/currentRuntimeClient', async () => {
  const { createSeededRuntimeClient } = await import('../runtimeClient/seededRuntimeClient')
  return { runtimeClient: createSeededRuntimeClient() }
})

vi.mock('../terminal/paneMetrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../terminal/paneMetrics')>()
  return {
    ...actual,
    newPaneRoom: (fontSize: number, _fontFamily: string, root: unknown) => {
      measurement.asked.push({ fontSize, root })
      return measurement.size
    },
    paneGrid: () => measurement.grid
  }
})

import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from './workspaceStore'

async function openedWorktree(): Promise<string> {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const worktreeId = useWorkspaceStore.getState().activeWorktreeId!
  await store.openWorktree(worktreeId)
  return worktreeId
}

type Calls = { mock: { calls: [string, unknown][] } }

function createCalls(spy: Calls): unknown[] {
  return spy.mock.calls.filter(([method]) => method === 'terminal.create').map(([, params]) => params)
}

it('opens a pane at the size this window measured', async () => {
  const worktreeId = await openedWorktree()
  measurement.size = { cols: 173, rows: 47, area: AREA, minPane: MIN_PANE }
  measurement.asked.length = 0

  // Read before the call, because creating a pane rewrites the tree.
  const joining = useWorkspaceStore.getState().layouts[worktreeId]!.root
  const fontSize = useWorkspaceStore.getState().terminalFontSize

  const call = vi.spyOn(runtimeClient, 'call')
  await useWorkspaceStore.getState().createTerminal(worktreeId)

  expect(createCalls(call as unknown as Calls)).toEqual([
    { worktreeId, cols: 173, rows: 47, area: AREA, minPane: MIN_PANE }
  ])
  // Measured against the layout the pane is joining, which decides where it lands.
  expect(measurement.asked).toEqual([{ fontSize, root: joining }])
  call.mockRestore()
})

it('sends no size at all when there is nothing on screen to measure', async () => {
  const worktreeId = await openedWorktree()
  measurement.size = undefined

  const call = vi.spyOn(runtimeClient, 'call')
  await useWorkspaceStore.getState().createTerminal(worktreeId)

  // Not a guess and not a zero: the runtime's default stands and the view resizes it on mount.
  expect(createCalls(call as unknown as Calls)).toEqual([{ worktreeId }])
  call.mockRestore()
})

it('opens an agent pane at the measured size too', async () => {
  const worktreeId = await openedWorktree()
  measurement.size = { cols: 120, rows: 31, area: AREA, minPane: MIN_PANE }

  const call = vi.spyOn(runtimeClient, 'call')
  await useWorkspaceStore.getState().startAgent('claude')

  // The pane this matters most for: a full-screen agent reads its size once.
  expect(createCalls(call as unknown as Calls)).toEqual([
    { worktreeId, command: 'claude', cols: 120, rows: 31, area: AREA, minPane: MIN_PANE }
  ])
  call.mockRestore()
})

it('opens nothing, and says so, when no pane would have room', async () => {
  const worktreeId = await openedWorktree()
  measurement.size = 'full'

  const call = vi.spyOn(runtimeClient, 'call')
  await useWorkspaceStore.getState().createTerminal(worktreeId)
  await useWorkspaceStore.getState().startAgent('claude')

  expect(createCalls(call as unknown as Calls)).toEqual([])
  expect(useWorkspaceStore.getState().notices.at(-1)?.text).toBe('No room for another pane')
  call.mockRestore()
})

it('refuses a split that would leave a pane under the minimum, in the direction asked for only', async () => {
  const worktreeId = await openedWorktree()
  measurement.grid = { area: { width: 600, height: 800 }, minPane: MIN_PANE, cell: { width: 8, height: 17 } }
  const focused = useWorkspaceStore.getState().layouts[worktreeId]!.focusedTerminalId!
  useWorkspaceStore.setState((state) => ({
    layouts: {
      ...state.layouts,
      [worktreeId]: { worktreeId, root: { kind: 'leaf', terminalId: focused }, focusedTerminalId: focused }
    }
  }))

  const call = vi.spyOn(runtimeClient, 'call')
  await useWorkspaceStore.getState().splitFocusedPane('row')
  expect(call.mock.calls.filter(([method]) => method === 'terminal.split')).toEqual([])
  expect(useWorkspaceStore.getState().notices.at(-1)?.text).toBe('No room for another pane')

  await useWorkspaceStore.getState().splitFocusedPane('column')
  expect(call.mock.calls.filter(([method]) => method === 'terminal.split')).toHaveLength(1)
  call.mockRestore()
  measurement.grid = undefined
})

it('splits a pane at the size its half will be drawn at, on the grid it was measured on', async () => {
  const worktreeId = await openedWorktree()
  const area = { width: 1000, height: 800 }
  const cell = { width: 8, height: 17 }
  measurement.grid = { area, minPane: MIN_PANE, cell }
  const focused = useWorkspaceStore.getState().layouts[worktreeId]!.focusedTerminalId!
  useWorkspaceStore.setState((state) => ({
    layouts: {
      ...state.layouts,
      [worktreeId]: { worktreeId, root: { kind: 'leaf', terminalId: focused }, focusedTerminalId: focused }
    }
  }))

  const call = vi.spyOn(runtimeClient, 'call')
  await useWorkspaceStore.getState().splitFocusedPane('row')

  // Half of 1000px less the gutter and a pane's chrome, in 8px cells; 800px less chrome in 17px rows.
  expect(call.mock.calls.filter(([method]) => method === 'terminal.split').map(([, params]) => params)).toEqual([
    { terminalId: focused, direction: 'row', cols: 60, rows: 44, area, cell }
  ])
  call.mockRestore()
  measurement.grid = undefined
})
