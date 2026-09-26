import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CheckFailure, Terminal, WorktreeLanding } from '@shared/entities'

const call = vi.fn()

vi.mock('../../runtimeClient/currentRuntimeClient', () => ({
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

const { useWorkspaceStore } = await import('../../state/workspaceStore')
const { failureMessage, idleAgentPane, sendCheckFailure, MAX_FAILURES_SENT } = await import('./checkFailure')

const INITIAL = useWorkspaceStore.getState()

const pane = (id: string, overrides: Partial<Terminal> = {}): Terminal => ({
  id,
  worktreeId: 'w1',
  title: 'claude',
  cwd: '/wt',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy: false,
  agent: 'claude',
  lastOutputAt: 0,
  ...overrides
})

const working = { agentEvent: { event: 'UserPromptSubmit', at: 1 } } as Partial<Terminal>
const asking = { titleSays: 'waiting' } as Partial<Terminal>

const pull: NonNullable<WorktreeLanding['pullRequest']> = {
  number: 42,
  url: 'https://github.com/acme/api/pull/42',
  state: 'open',
  checks: {
    passing: 1,
    failing: 2,
    pending: 0,
    list: [
      { name: 'test', state: 'fail', url: 'https://github.com/acme/api/actions/runs/1/job/2' },
      { name: 'e2e', state: 'fail' },
      { name: 'lint', state: 'pass' }
    ]
  }
}

const byId = (...panes: Terminal[]): Record<string, Terminal> =>
  Object.fromEntries(panes.map((each) => [each.id, each]))

describe('idleAgentPane', () => {
  it('never picks a shell, a working agent, an asking one, an exited one or another worktree’s', () => {
    const terminals = byId(
      pane('shell', { agent: undefined }),
      pane('busy', working),
      pane('asking', asking),
      pane('gone', { running: false, exitCode: 0 }),
      pane('elsewhere', { worktreeId: 'w2' })
    )
    expect(idleAgentPane(terminals, 'w1')).toBeUndefined()
  })

  it('prefers the focused idle agent, else the first', () => {
    const terminals = byId(pane('one'), pane('two'))
    expect(idleAgentPane(terminals, 'w1')?.id).toBe('one')
    expect(idleAgentPane(terminals, 'w1', 'two')?.id).toBe('two')
  })
})

describe('failureMessage', () => {
  it('names each check, links it and fences its excerpt', () => {
    const failures: CheckFailure[] = [
      { worktreeId: 'w1', name: 'test', url: 'https://ci/1', excerpt: 'FAIL src/sum.test.ts' },
      { worktreeId: 'w1', name: 'e2e', excerpt: '' }
    ]
    expect(failureMessage(pull, failures)).toBe(
      [
        'PR #42 checks failed: test, e2e',
        '',
        'test https://ci/1',
        '```',
        'FAIL src/sum.test.ts',
        '```',
        '',
        'e2e',
        '',
        'Fix them and push.'
      ].join('\n')
    )
  })

  it('fences past backticks in the log', () => {
    const message = failureMessage(pull, [{ worktreeId: 'w1', name: 'test', excerpt: 'a ``` b' }])
    expect(message).toContain('````\na ``` b\n````')
  })
})

describe('sendCheckFailure', () => {
  beforeEach(() => {
    vi.useRealTimers()
    call.mockReset()
    useWorkspaceStore.setState(
      {
        ...INITIAL,
        landings: {
          w1: {
            worktreeId: 'w1',
            branch: 'b',
            base: 'main',
            host: 'github',
            published: true,
            unmerged: 1,
            merged: false,
            readAt: 0,
            pullRequest: pull
          }
        }
      },
      true
    )
  })

  it('pastes the failures into the idle agent and presses Return', async () => {
    useWorkspaceStore.setState({ terminals: byId(pane('t1')) })
    call.mockImplementation((method: string, params: { name?: string }) =>
      method === 'worktree.checkFailure'
        ? Promise.resolve({ worktreeId: 'w1', name: params.name, excerpt: `${params.name} broke` })
        : Promise.resolve(undefined)
    )

    expect(await sendCheckFailure('w1')).toBe('sent')

    expect(call).toHaveBeenCalledWith('worktree.checkFailure', { worktreeId: 'w1', name: 'test' })
    expect(call).toHaveBeenCalledWith('worktree.checkFailure', { worktreeId: 'w1', name: 'e2e' })
    const writes = call.mock.calls.filter(([method]) => method === 'terminal.write').map(([, params]) => params)
    expect(writes).toHaveLength(2)
    expect(writes[0]).toMatchObject({ terminalId: 't1' })
    expect(writes[0].data.startsWith('\x1b[200~PR #42 checks failed: test, e2e')).toBe(true)
    expect(writes[0].data).toContain('test broke')
    expect(writes[0].data.endsWith('\x1b[201~')).toBe(true)
    expect(writes[1]).toEqual({ terminalId: 't1', data: '\r' })
  })

  it('refuses with no idle agent, and types nothing', async () => {
    useWorkspaceStore.setState({ terminals: byId(pane('t1', working), pane('sh', { agent: undefined })) })

    expect(await sendCheckFailure('w1')).toBe('refused')
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses when the agent starts working while the logs are read', async () => {
    useWorkspaceStore.setState({ terminals: byId(pane('t1')) })
    call.mockImplementation((method: string, params: { name?: string }) => {
      if (method !== 'worktree.checkFailure') return Promise.resolve(undefined)
      useWorkspaceStore.setState({ terminals: byId(pane('t1', working)) })
      return Promise.resolve({ worktreeId: 'w1', name: params.name, excerpt: '' })
    })

    expect(await sendCheckFailure('w1')).toBe('refused')
    expect(call.mock.calls.some(([method]) => method === 'terminal.write')).toBe(false)
  })

  it('sends a check whose log could not be read by its name alone', async () => {
    useWorkspaceStore.setState({ terminals: byId(pane('t1')) })
    call.mockImplementation((method: string) =>
      method === 'worktree.checkFailure' ? Promise.reject(new Error('gh failed')) : Promise.resolve(undefined)
    )

    expect(await sendCheckFailure('w1')).toBe('sent')
    const [first] = call.mock.calls.filter(([method]) => method === 'terminal.write').map(([, params]) => params)
    expect(first.data).toContain('\ntest https://github.com/acme/api/actions/runs/1/job/2\n')
  })

  it('reads at most a few logs', () => {
    expect(MAX_FAILURES_SENT).toBeLessThanOrEqual(3)
  })
})
