/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceEvent } from '@shared/methods'
import type { ProjectMemory } from '@shared/ledgerMethods'

const EMPTY: ProjectMemory = { projectId: 'p1', revision: 0, worktrees: [], notes: [] }
let answer: ProjectMemory = EMPTY
const call = vi.fn((method: string, _params?: unknown): Promise<unknown> => {
  if (method === 'memory.list') return Promise.resolve(answer)
  if (method === 'worktree.overlaps') return Promise.resolve({ projectId: 'p1', overlaps: [], readAt: 0 })
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
const { useLedger } = await import('./ledgerStore')
const INITIAL = useWorkspaceStore.getState()

const CLAIMED: ProjectMemory = {
  projectId: 'p1',
  revision: 2,
  worktrees: [{ worktreeId: 'a', claims: ['src/api/**'], touched: [] }],
  notes: []
}

let stop: () => void = () => {}

beforeEach(() => {
  stop()
  call.mockClear()
  answer = EMPTY
  useLedger.setState({ byProject: {} })
  useWorkspaceStore.setState(
    { ...INITIAL, projects: [{ id: 'p1', name: 'p1', path: '/repos/p1', baseRef: 'origin/main' }] },
    true
  )
  stop = useWorkspaceStore.getState().startWatching()
})

describe('the ledger in the window', () => {
  it('is read again when the runtime says memory changed', async () => {
    answer = CLAIMED
    stream?.({ type: 'memory' })
    await vi.waitFor(() => expect(useLedger.getState().byProject.p1).toEqual(CLAIMED))
    expect(call).toHaveBeenCalledWith('memory.list', { projectId: 'p1' })
  })

  it('is not read for an event that cannot move it', async () => {
    stream?.({ type: 'teammates' })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(call).not.toHaveBeenCalledWith('memory.list', expect.anything())
  })

  it('keeps what it had when a read fails', async () => {
    useLedger.setState({ byProject: { p1: CLAIMED } })
    call.mockImplementationOnce(() => Promise.reject(new Error('gone')))
    await useLedger.getState().refresh(['p1'])
    expect(useLedger.getState().byProject.p1).toEqual(CLAIMED)
  })
})
