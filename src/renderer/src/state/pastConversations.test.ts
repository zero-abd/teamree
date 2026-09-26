// Each worktree's past conversations, kept so a menu can decide whether to offer resuming one:
// read when asked, once at a time, never for agents with no store to read, and again when an agent stops.

import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentConversation, InstalledAgent, Terminal } from '@shared/entities'
import type { WorkspaceEvent } from '@shared/methods'

const call = vi.hoisted(() => vi.fn((..._args: unknown[]): Promise<unknown> => new Promise(() => {})))
const events = vi.hoisted(() => ({ emit: (_event: unknown): void => {} }))

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call,
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: (onEvent: (event: unknown) => void) => {
      events.emit = onEvent
      return { close: () => {} }
    },
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('./workspaceStore')

const INITIAL = useWorkspaceStore.getState()
const claude: InstalledAgent = { kind: 'claude', command: 'claude', binary: '/bin/claude' }
const kiro: InstalledAgent = { kind: 'kiro', command: 'kiro-cli', binary: '/bin/kiro-cli' }
const past: AgentConversation = { agent: 'claude', sessionId: 's1', prompt: 'fix it', updatedAt: 1, messages: 2 }

const pane = (overrides: Partial<Terminal> & { id: string }): Terminal => ({
  worktreeId: 'w1',
  title: 'claude',
  cwd: '/wt/w1',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy: false,
  lastOutputAt: 0,
  ...overrides
})

const asked = (): unknown[] => call.mock.calls.filter(([method]) => method === 'agent.conversations').map(([, p]) => p)

beforeEach(() => {
  call.mockReset()
  call.mockImplementation((method: unknown) =>
    method === 'agent.conversations' ? Promise.resolve([past]) : new Promise(() => {})
  )
  useWorkspaceStore.setState({ ...INITIAL, agents: [claude] }, true)
})

it('keeps what agent.conversations answered, by worktree', async () => {
  await useWorkspaceStore.getState().loadConversations('w1')
  expect(asked()).toEqual([{ worktreeId: 'w1' }])
  expect(useWorkspaceStore.getState().conversations).toEqual({ w1: [past] })
})

it('asks once while a read for the same worktree is under way', async () => {
  const store = useWorkspaceStore.getState()
  await Promise.all([store.loadConversations('w1'), store.loadConversations('w1')])
  expect(asked()).toHaveLength(1)
})

it('asks nothing when no installed agent keeps conversations it can list', async () => {
  useWorkspaceStore.setState({ agents: [kiro] })
  await useWorkspaceStore.getState().loadConversations('w1')
  expect(asked()).toEqual([])
})

it('reads the worktree again when an agent in it exits, and not for a shell', async () => {
  useWorkspaceStore.setState({
    terminals: {
      t1: pane({ id: 't1', agent: 'claude' }),
      t2: pane({ id: 't2', worktreeId: 'w2', title: 'zsh' })
    }
  })
  const stop = useWorkspaceStore.getState().startWatching()
  const exit = (terminalId: string): void =>
    events.emit({ type: 'terminalExited', terminalId, exitCode: 0 } satisfies WorkspaceEvent)

  exit('t2')
  exit('t1')
  await vi.waitFor(() => expect(asked()).toEqual([{ worktreeId: 'w1' }]))
  stop()
})
