/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceEvent } from '@shared/methods'
import type { WorktreeOverlaps } from '@shared/tasks'

let answer: WorktreeOverlaps = { projectId: 'p1', overlaps: [], readAt: 0 }
const call = vi.fn((method: string, _params?: unknown): Promise<unknown> => {
  if (method === 'worktree.overlaps') return Promise.resolve(answer)
  return Promise.reject(new Error(`${method} is not answered here`))
})
let stream: ((event: WorkspaceEvent) => void) | null = null

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (method: string, params: unknown) => call(method, params),
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: (onEvent: (event: WorkspaceEvent) => void) => {
      stream = onEvent
      return { close: () => {} }
    },
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('./workspaceStore')
const { useOverlaps } = await import('./overlapStore')
const INITIAL = useWorkspaceStore.getState()

const OVERLAP = {
  worktreeId: 'a',
  with: { worktreeId: 'b' },
  paths: ['src/api/auth.ts'],
  conflicts: []
}

let stop: () => void = () => {}

beforeEach(() => {
  stop()
  call.mockClear()
  answer = { projectId: 'p1', overlaps: [], readAt: 0 }
  useOverlaps.setState({ byProject: {} })
  useWorkspaceStore.setState(
    { ...INITIAL, projects: [{ id: 'p1', name: 'p1', path: '/repos/p1', baseRef: 'origin/main' }] },
    true
  )
  stop = useWorkspaceStore.getState().startWatching()
})

describe('overlaps in the window', () => {
  it('are read again when the ledger says it changed', async () => {
    answer = { projectId: 'p1', overlaps: [OVERLAP], readAt: 1 }
    stream?.({ type: 'memory' })
    await vi.waitFor(() => expect(useOverlaps.getState().byProject.p1).toEqual([OVERLAP]))
    expect(call).toHaveBeenCalledWith('worktree.overlaps', { projectId: 'p1' })
  })

  it('are not read for an event that cannot move them', async () => {
    stream?.({ type: 'layout', worktreeId: 'a' })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(call).not.toHaveBeenCalledWith('worktree.overlaps', expect.anything())
  })

  it('keep what they had when a read fails', async () => {
    useOverlaps.setState({ byProject: { p1: [OVERLAP] } })
    call.mockImplementationOnce(() => Promise.reject(new Error('gone')))
    await useOverlaps.getState().refresh(['p1'])
    expect(useOverlaps.getState().byProject.p1).toEqual([OVERLAP])
  })
})
