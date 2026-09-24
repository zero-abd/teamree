/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@shared/entities'

const call = vi.fn(async (_method: string, _params: unknown): Promise<unknown> => ({ written: true }))

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

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { useReviewStore } = await import('./reviewStore')
const { commentMessage, pasted } = await import('./reviewComments')

const INITIAL = useWorkspaceStore.getState()
const REVIEW = useReviewStore.getState()

const pane = (id: string, fields: Partial<Terminal>): Terminal =>
  ({
    id,
    worktreeId: 'w1',
    title: 'zsh',
    shell: '/bin/zsh',
    running: true,
    busy: false,
    lastOutputAt: 0,
    ...fields
  }) as Terminal

const COMMENT = {
  path: 'src/math.ts',
  lines: [{ kind: 'added' as const, text: '  return a - b', oldNumber: null, newNumber: 10 }],
  note: 'Name it subtract.'
}

const writes = (): { terminalId: string; data: string }[] =>
  call.mock.calls
    .filter(([method]) => method === 'terminal.write')
    .map(([, params]) => params as { terminalId: string; data: string })

beforeEach(() => {
  vi.useFakeTimers()
  call.mockClear()
  useReviewStore.setState(REVIEW, true)
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      activeWorktreeId: 'w1',
      terminals: {
        shell: pane('shell', {}),
        claude: pane('claude', { agent: 'claude' }),
        busy: pane('busy', { agent: 'codex', busy: true })
      }
    },
    true
  )
})

afterEach(() => {
  vi.useRealTimers()
})

describe('sending review comments to an agent', () => {
  it('types the comment into a quiet agent pane as a paste, then Return', async () => {
    const sent = useReviewStore.getState().send('claude', [COMMENT])
    await vi.runAllTimersAsync()
    expect(await sent).toBe('sent')
    expect(writes()).toEqual([
      { terminalId: 'claude', data: pasted(commentMessage([COMMENT])) },
      { terminalId: 'claude', data: '\r' }
    ])
  })

  it('leaves it typed, without Return, in a pane that is working, and says it is queued', async () => {
    const sent = useReviewStore.getState().send('busy', [COMMENT])
    await vi.runAllTimersAsync()
    expect(await sent).toBe('queued')
    expect(writes()).toEqual([{ terminalId: 'busy', data: pasted(commentMessage([COMMENT])) }])
    expect(useReviewStore.getState().queued).toEqual({ busy: true })

    // Only a press of Send puts the Return in.
    await useReviewStore.getState().sendQueued('busy')
    expect(writes().at(-1)).toEqual({ terminalId: 'busy', data: '\r' })
    expect(useReviewStore.getState().queued).toEqual({})
  })

  it('forgets the queue once the pane is gone to, where the text now waits for its owner', async () => {
    const sent = useReviewStore.getState().send('busy', [COMMENT])
    await vi.runAllTimersAsync()
    await sent
    useWorkspaceStore.setState({
      layouts: { w1: { worktreeId: 'w1', root: { kind: 'leaf', terminalId: 'busy' }, focusedTerminalId: 'busy' } }
    })
    expect(useReviewStore.getState().queued).toEqual({})
  })

  it('writes nothing to a shell pane', async () => {
    const sent = useReviewStore.getState().send('shell', [COMMENT])
    await vi.runAllTimersAsync()
    expect(await sent).toBe('refused')
    expect(writes()).toEqual([])
  })

  it('sends the batch as one message and empties it', async () => {
    const other = { ...COMMENT, path: 'docs/NOTES.md', note: 'Say why.' }
    useReviewStore.getState().addToBatch('w1', COMMENT)
    useReviewStore.getState().addToBatch('w1', other)
    const sent = useReviewStore.getState().sendBatch('w1', 'claude')
    await vi.runAllTimersAsync()
    expect(await sent).toBe('sent')
    expect(writes()[0]).toEqual({ terminalId: 'claude', data: pasted(commentMessage([COMMENT, other])) })
    expect(useReviewStore.getState().batch.w1).toBeUndefined()
  })
})
