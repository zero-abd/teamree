import { describe, expect, it } from 'vitest'
import type { TerminalEvent } from '../shared/methods.js'
import type { RuntimeClient } from './transport.js'
import { waitForState, waitForTerminal, WaitTimeout, type Delay, type WaitTiming } from './waiting.js'

type Timeline = {
  timing: WaitTiming
  /** Runs at the end of each idle, so a test can produce output or sleep mid-wait. */
  onIdle: (hook: (tick: number) => void) => void
  suspend: (ms: number, monotonic: 'counted' | 'uncounted') => void
  ticks: () => number
}

/**
 * A timeline a test drives instead of spending real seconds: every idle advances
 * both clocks by what it was asked to wait, and `suspend` moves them apart the
 * way a closing lid does. `counted` is a monotonic source that keeps running
 * while the machine is suspended (macOS); `uncounted` is one that stops.
 */
function timeline(): Timeline {
  let wall = 1_700_000_000_000
  let monotonic = 0
  let tick = 0
  let hook: ((tick: number) => void) | undefined

  const delay: Delay = (ms) => {
    tick += 1
    wall += ms
    monotonic += ms
    hook?.(tick)
    return { done: Promise.resolve(), cancel: () => {} }
  }

  return {
    timing: { clock: { now: () => wall, monotonicNow: () => monotonic }, delay },
    onIdle: (next) => {
      hook = next
    },
    suspend: (ms, mode) => {
      wall += ms
      if (mode === 'counted') monotonic += ms
    },
    ticks: () => tick
  }
}

/** Just enough runtime for the waits: one terminal, and events the test pushes. */
function fakeClient(options: { running?: boolean; exitCode?: number } = {}): RuntimeClient & {
  emit: (event: TerminalEvent) => void
} {
  let listener: ((event: unknown) => void) | undefined
  return {
    endpoint: '/dev/null',
    call: (async (method: string) => {
      if (method === 'terminal.list') {
        return [{ id: 't1', running: options.running ?? true, exitCode: options.exitCode }]
      }
      return []
    }) as unknown as RuntimeClient['call'],
    subscribe: (async (_method: string, _params: unknown, onEvent: (event: unknown) => void) => {
      listener = onEvent
      return { id: 's1', unsubscribe: async () => {} }
    }) as unknown as RuntimeClient['subscribe'],
    close: () => {},
    emit: (event) => listener?.(event)
  }
}

const data = (text: string): TerminalEvent => ({ type: 'data', data: text }) as TerminalEvent

describe('waiting for a terminal', () => {
  for (const monotonic of ['counted', 'uncounted'] as const) {
    it(`does not call a machine that slept quiet, with a ${monotonic} monotonic clock`, async () => {
      const time = timeline()
      const client = fakeClient()
      // Output on every look, so silence is never genuinely observed and the only
      // honest way out is the timeout. A wall clock alone reads the hour as quiet.
      time.onIdle((tick) => {
        client.emit(data('.'))
        if (tick === 2) time.suspend(3_600_000, monotonic)
      })

      const wait = waitForTerminal({
        client,
        terminalId: 't1',
        until: 'quiet',
        quietMs: 1_500,
        timeoutMs: 2_000,
        ...time.timing
      })

      await expect(wait).rejects.toBeInstanceOf(WaitTimeout)
      await expect(wait).rejects.toMatchObject({ interrupted: true, code: 'wait_timeout' })
      // The hour bought no progress at all: the interrupted look was charged nothing.
      expect(time.ticks()).toBe(2_000 / 250 + 1)
    })
  }

  it('still reports quiet when the terminal is genuinely silent', async () => {
    const time = timeline()
    const client = fakeClient()
    time.onIdle((tick) => {
      if (tick === 1) client.emit(data('hello'))
    })

    const result = await waitForTerminal({
      client,
      terminalId: 't1',
      until: 'quiet',
      quietMs: 1_500,
      timeoutMs: 60_000,
      ...time.timing
    })

    expect(result).toMatchObject({ reason: 'quiet', output: 'hello', interrupted: false })
    expect(time.ticks()).toBe(1 + 1_500 / 250)
  })

  it('reports quiet after a sleep only once the silence has been watched in full', async () => {
    const time = timeline()
    const client = fakeClient()
    time.onIdle((tick) => {
      if (tick === 1) client.emit(data('hello'))
      if (tick === 2) time.suspend(3_600_000, 'counted')
    })

    const result = await waitForTerminal({
      client,
      terminalId: 't1',
      until: 'quiet',
      quietMs: 1_500,
      timeoutMs: 60_000,
      ...time.timing
    })

    // Quiet, but only on evidence gathered after the wake, and flagged as such.
    expect(result).toMatchObject({ reason: 'quiet', interrupted: true })
    expect(time.ticks()).toBe(2 + 1_500 / 250)
  })

  it('still times out when the time was really spent waiting', async () => {
    const time = timeline()
    const client = fakeClient()
    time.onIdle(() => client.emit(data('.')))

    const wait = waitForTerminal({
      client,
      terminalId: 't1',
      until: 'quiet',
      quietMs: 1_500,
      timeoutMs: 1_000,
      ...time.timing
    })

    await expect(wait).rejects.toBeInstanceOf(WaitTimeout)
    await expect(wait).rejects.toMatchObject({ interrupted: false })
  })

  it('waits for the real exit even across a sleep, because an exit is observed', async () => {
    const time = timeline()
    const client = fakeClient()
    time.onIdle((tick) => {
      if (tick === 1) time.suspend(3_600_000, 'counted')
      if (tick === 4) client.emit({ type: 'exit', exitCode: 3 } as TerminalEvent)
    })

    const result = await waitForTerminal({
      client,
      terminalId: 't1',
      until: 'exit',
      quietMs: 1_500,
      timeoutMs: 60_000,
      ...time.timing
    })

    expect(result).toMatchObject({ reason: 'exit', exitCode: 3, interrupted: true })
  })
})

describe('waiting for a state', () => {
  const stateWait = (read: () => Promise<string>, timeoutMs: number, time: Timeline): Promise<string> =>
    waitForState({
      client: fakeClient(),
      what: 'worktree x',
      read,
      settled: (value: string) => value === 'ready',
      timeoutMs,
      ...time.timing
    })

  it('does not time out over an hour it slept through', async () => {
    const time = timeline()
    let state = 'creating'
    time.onIdle((tick) => {
      if (tick === 1) time.suspend(3_600_000, 'counted')
      if (tick === 2) state = 'ready'
    })

    // Wall-clock bookkeeping would have given up on the first look back.
    await expect(stateWait(async () => state, 1_000, time)).resolves.toBe('ready')
  })

  it('still times out when nothing settles and nothing slept', async () => {
    const time = timeline()
    const wait = stateWait(async () => 'creating', 1_000, time)
    await expect(wait).rejects.toBeInstanceOf(WaitTimeout)
    await expect(wait).rejects.toMatchObject({ interrupted: false })
  })

  it('says so when a wait that slept does eventually time out', async () => {
    const time = timeline()
    time.onIdle((tick) => {
      if (tick === 1) time.suspend(3_600_000, 'uncounted')
    })
    const wait = stateWait(async () => 'creating', 1_000, time)
    await expect(wait).rejects.toMatchObject({ interrupted: true, code: 'wait_timeout' })
  })
})
