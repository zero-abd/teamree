// Blocking waits for agents. Each turns elapsed time into a claim about someone
// else's work, so a closing lid must not read as silence or a missed deadline:
// time goes through `startTimedWindow`, and an unobserved gap is never spent as evidence.

import { existsSync } from 'node:fs'
import { startTimedWindow, type ElapsedClock } from '../main/runtime/elapsed.js'
import type { TerminalEvent } from '../shared/methods.js'
import { isPipe } from './discovery.js'
import { CliError, ExitCode } from './exit.js'
import type { RuntimeClient } from './transport.js'

/** How long a terminal must produce nothing before it counts as quiet. */
export const DEFAULT_QUIET_MS = 1500
export const DEFAULT_WAIT_TIMEOUT_MS = 120_000

/**
 * How long `teamree quit` waits for the endpoint to go. Teardown kills a process
 * tree per pane and writes every transcript, so a busy workspace takes a second or two.
 */
export const DEFAULT_QUIT_TIMEOUT_MS = 20_000

/** How often the endpoint is looked for while quitting. */
const QUIT_POLL_MS = 25

/** Fallback cadence when the runtime has no change stream to listen to. */
const POLL_INTERVAL_MS = 250

/** An idle that an event can cut short without leaving its timer behind. */
export type Delay = (ms: number) => { done: Promise<void>; cancel: () => void }

/** The clocks and the idle, injectable so a test can jump time without spending it. */
export type WaitTiming = {
  clock?: ElapsedClock
  delay?: Delay
}

const systemClock: ElapsedClock = { now: () => Date.now() }

const realDelay: Delay = (ms) => {
  let timer: NodeJS.Timeout | undefined
  const done = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
  })
  return { done, cancel: () => clearTimeout(timer) }
}

export class WaitTimeout extends CliError {
  /** Whether this machine slept during the wait, so the wall clock outran the budget. */
  readonly interrupted: boolean

  constructor(what: string, timeoutMs: number, interrupted = false) {
    super({
      code: 'wait_timeout',
      message: interrupted
        ? `Timed out after ${timeoutMs}ms of observed waiting for ${what}. This machine slept during the wait, ` +
          'so more wall-clock time than that has passed.'
        : `Timed out after ${timeoutMs}ms waiting for ${what}.`,
      exitCode: ExitCode.Failure,
      data: { interrupted }
    })
    this.name = 'WaitTimeout'
    this.interrupted = interrupted
  }
}

type Observation = {
  /** Time to charge against the budget: what was watched, never the gap. */
  observedMs: number
  interrupted: boolean
}

// Idles once and reports what was observed. An interrupted idle is charged
// nothing: how much of it was awake is exactly what a suspend makes unknowable.
async function observeIdle(
  clock: ElapsedClock,
  armedForMs: number,
  start: () => { done: Promise<void>; cancel: () => void }
): Promise<Observation> {
  const window = startTimedWindow(clock, armedForMs)
  const handle = start()
  try {
    await handle.done
  } finally {
    handle.cancel()
  }
  const interrupted = window.wasInterrupted()
  return { observedMs: interrupted ? 0 : window.elapsedMs(), interrupted }
}

/**
 * Resolves once `read` returns a value `settled` accepts, woken by the workspace
 * change stream where the runtime offers one, polling otherwise.
 */
export async function waitForState<T>(
  options: {
    client: RuntimeClient
    what: string
    read: () => Promise<T>
    settled: (value: T) => boolean
    timeoutMs: number
  } & WaitTiming
): Promise<T> {
  const { client, what, read, settled, timeoutMs } = options
  const clock = options.clock ?? systemClock
  const delay = options.delay ?? realDelay

  const first = await read()
  if (settled(first)) return first

  let wake: (() => void) | undefined
  let subscription: { unsubscribe: () => Promise<void> } | undefined
  try {
    subscription = await client.subscribe('workspace.subscribe', {}, () => wake?.())
  } catch {
    // No change stream on this runtime; polling still works.
  }

  // Still bounded by the poll interval so a missed event cannot hang us.
  const idleMs = subscription ? POLL_INTERVAL_MS * 4 : POLL_INTERVAL_MS
  const start = (): { done: Promise<void>; cancel: () => void } => {
    const timer = delay(idleMs)
    if (!subscription) return timer
    const done = new Promise<void>((resolve) => {
      wake = resolve
      void timer.done.then(resolve)
    })
    return {
      done,
      cancel: () => {
        wake = undefined
        timer.cancel()
      }
    }
  }

  let observedMs = 0
  let interrupted = false
  try {
    while (observedMs < timeoutMs) {
      const tick = await observeIdle(clock, idleMs, start)
      observedMs += tick.observedMs
      interrupted = interrupted || tick.interrupted

      const value = await read()
      if (settled(value)) return value
    }
  } finally {
    await subscription?.unsubscribe().catch(() => {})
  }

  throw new WaitTimeout(what, timeoutMs, interrupted)
}

export type EndpointOutcome = {
  /** False when the wait ran out with the endpoint still there. */
  gone: boolean
  /** Null when the endpoint is a named pipe, which cannot be watched from here. */
  waitedMs: number | null
}

/**
 * Waits for the endpoint to disappear: the socket file is removed last in
 * `Runtime.stop`, so its absence proves the whole teardown ran, where a reply to
 * `app.quit` only proves the app heard. A Windows named pipe cannot be stat'd, so the wait says so.
 */
export async function waitForEndpointGone(
  options: { endpoint: string; timeoutMs: number; exists?: (path: string) => boolean } & WaitTiming
): Promise<EndpointOutcome> {
  const { endpoint, timeoutMs } = options
  if (isPipe(endpoint)) return { gone: true, waitedMs: null }
  const exists = options.exists ?? existsSync
  const clock = options.clock ?? systemClock
  const delay = options.delay ?? realDelay

  let observedMs = 0
  while (true) {
    // Rounded: the monotonic clock counts fractions of a millisecond and this is printed.
    if (!exists(endpoint)) return { gone: true, waitedMs: Math.round(observedMs) }
    if (observedMs >= timeoutMs) return { gone: false, waitedMs: Math.round(observedMs) }
    const tick = await observeIdle(clock, QUIT_POLL_MS, () => delay(QUIT_POLL_MS))
    observedMs += tick.observedMs
  }
}

export type TerminalWaitResult = {
  reason: 'quiet' | 'exit' | 'already-exited'
  terminalId: string
  exitCode?: number
  /** Output observed while waiting, so a caller need not read separately. */
  output: string
  /** Whether this machine slept mid-wait: quiet was re-observed in full, but far more wall-clock time passed. */
  interrupted: boolean
}

/** Waits for a terminal to go quiet or exit; a shell that finished a command sits at its prompt and never exits. */
export async function waitForTerminal(
  options: {
    client: RuntimeClient
    terminalId: string
    until: 'quiet' | 'exit'
    quietMs: number
    timeoutMs: number
  } & WaitTiming
): Promise<TerminalWaitResult> {
  const { client, terminalId, until, quietMs, timeoutMs } = options
  const clock = options.clock ?? systemClock
  const delay = options.delay ?? realDelay

  const existing = await client.call('terminal.list', {})
  const terminal = existing.find((row) => row.id === terminalId)
  if (!terminal) throw new Error(`No such terminal: ${terminalId}`)
  if (!terminal.running) {
    return { reason: 'already-exited', terminalId, exitCode: terminal.exitCode, output: '', interrupted: false }
  }

  let output = ''
  let exited: { exitCode: number } | undefined
  // Restarted on every byte and after any gap slept through, so quiet means watched silence.
  let quiet = startTimedWindow(clock)

  const subscription = await client.subscribe('terminal.subscribe', { terminalId }, (raw) => {
    const event = raw as TerminalEvent
    if (event.type === 'data') {
      output += event.data
      quiet = startTimedWindow(clock)
    } else if (event.type === 'exit') {
      exited = { exitCode: event.exitCode }
    }
  })

  const idleMs = Math.max(1, Math.min(POLL_INTERVAL_MS, quietMs))
  let observedMs = 0
  let interrupted = false
  try {
    while (observedMs < timeoutMs) {
      const tick = await observeIdle(clock, idleMs, () => delay(idleMs))
      observedMs += tick.observedMs
      if (tick.interrupted) {
        interrupted = true
        quiet = startTimedWindow(clock)
      }

      // An exit is reported by the runtime, not read off the clock, so a sleep cannot invent one.
      if (exited) return { reason: 'exit', terminalId, exitCode: exited.exitCode, output, interrupted }
      if (until === 'quiet' && quiet.elapsedMs() >= quietMs) {
        return { reason: 'quiet', terminalId, output, interrupted }
      }
    }
  } finally {
    await subscription.unsubscribe().catch(() => {})
  }

  throw new WaitTimeout(`terminal ${terminalId}`, timeoutMs, interrupted)
}
