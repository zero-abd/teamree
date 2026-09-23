// The window says how big the pane is, because only the window knows.
//
// `terminal.create` used to carry no size, so every pane's pty was born 80x24
// and learned the truth a frame later, after the agent inside it had already
// drawn a frame to the wrong width. The measurement happens here, before the
// call, and this file holds the store to sending it — and to leaving it out
// when there is nothing on screen to measure, which is a real answer and not a
// reason to invent one.

import { expect, it, vi } from 'vitest'

const measurement = vi.hoisted(() => ({
  size: undefined as { cols: number; rows: number } | undefined,
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
    newPaneSize: (fontSize: number, root: unknown) => {
      measurement.asked.push({ fontSize, root })
      return measurement.size
    }
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
  measurement.size = { cols: 173, rows: 47 }
  measurement.asked.length = 0

  // Read before the call, because creating a pane rewrites the tree and the
  // question is what the grid held when the measurement was taken.
  const joining = useWorkspaceStore.getState().layouts[worktreeId]!.root
  const fontSize = useWorkspaceStore.getState().terminalFontSize

  const call = vi.spyOn(runtimeClient, 'call')
  await useWorkspaceStore.getState().createTerminal(worktreeId)

  expect(createCalls(call as unknown as Calls)).toEqual([{ worktreeId, cols: 173, rows: 47 }])
  // Measured against the layout the pane is joining, because what share of the
  // grid it gets is decided by what is already in it.
  expect(measurement.asked).toEqual([{ fontSize, root: joining }])
  call.mockRestore()
})

it('sends no size at all when there is nothing on screen to measure', async () => {
  const worktreeId = await openedWorktree()
  measurement.size = undefined

  const call = vi.spyOn(runtimeClient, 'call')
  await useWorkspaceStore.getState().createTerminal(worktreeId)

  // Not a guess, and not a zero: the runtime's own default stands, exactly as
  // it does for a pane the CLI opened, and the view resizes it on mount.
  expect(createCalls(call as unknown as Calls)).toEqual([{ worktreeId }])
  call.mockRestore()
})

it('opens an agent pane at the measured size too', async () => {
  const worktreeId = await openedWorktree()
  measurement.size = { cols: 120, rows: 31 }

  const call = vi.spyOn(runtimeClient, 'call')
  await useWorkspaceStore.getState().startAgent('claude')

  // The pane this matters most for: a full-screen agent reads its size once.
  expect(createCalls(call as unknown as Calls)).toEqual([{ worktreeId, command: 'claude', cols: 120, rows: 31 }])
  call.mockRestore()
})
