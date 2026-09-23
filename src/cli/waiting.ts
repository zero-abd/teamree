// Blocking waits for agents. A coding agent driving teamree needs to know when
// a worktree is usable, when a command it typed has actually finished, and when
// the app it asked to quit has gone; without these it can only sleep and hope.
//
// Each of them turns elapsed time into a claim about someone else's work — "that
// terminal has gone quiet", "that worktree never settled", "that app is not
// leaving" — so each has to know when this process was not running. A closing lid moves the wall clock by
// the whole sleep, and read naively that jump says the terminal fell silent or
// the deadline passed. Neither was observed. Time is therefore measured through
// `startTimedWindow`, which reads a monotonic clock and reports the two traces a
// suspend leaves, and an unobserved gap is never spent as evidence: the quiet
// window restarts and the timeout budget is charged only for watched time.

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
 * How long `teamree quit` waits for the endpoint to go.
 *
 * The teardown kills a process tree per pane and waits for each, then writes
 * every pane's transcript, so it is a second or two on a busy workspace and not
 * instant on an idle one. Generous enough that a real quit is never called a
 * failure, short enough that a script is not held by one that hung.
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

/**
 * Idles once and reports what was actually observed.
 *
 * An interrupted idle is charged nothing at all. How much of it this process was
 * awake for is exactly what a suspend makes unknowable, and the cost of guessing
 * high is a timeout that never watched for the time it claims to have watched.
 */
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
 * Resolves once `read` returns a value `settled` accepts. Wakes on the workspace
 * change stream where the runtime offers one, and falls back to polling against
 * an older runtime that does not.
 *
 * A value that satisfies `settled` is something the runtime said, so a sleep
 * cannot fabricate it; only the timeout is an inference from elapsed time, and
 * that is what the observed-time budget protects.
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
    // No change stream on this runtime; polling still gets the job done.
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
 * Waits for the runtime's endpoint to disappear, which is what proves a quit
 * finished rather than merely started.
 *
 * The socket file is removed last of all — after every pty is killed and every
 * transcript written, at the end of `Runtime.stop` — so its absence is the one
 * observation from out here that means the whole teardown ran. A reply to
 * `app.quit` means only that the app heard.
 *
 * A named pipe on Windows lives in the kernel and cannot be stat'd, so there is
 * nothing to watch and the wait says so rather than inventing an answer.
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
    // Rounded because this is read by a person and printed in a payload, and
    // the monotonic clock behind it counts in fractions of a millisecond.
    if (!exists(endpoint)) return { gone: true, waitedMs: Math.round(observedMs) }
    if (observedMs >= timeoutMs) return { gone: false, waitedMs: Math.round(observedMs) }
    // Charged the same way every other wait here is: a machine that slept
    // through part of this was not watching, and an unwatched gap must not be
    // spent as evidence that the app failed to go.
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
  /**
   * Whether this machine slept mid-wait. The result itself is still evidence —
   * quiet was re-observed in full after the wake — but far more wall-clock time
   * passed than the wait asked for, which anything timing the command needs.
   */
  interrupted: boolean
}

/**
 * Waits for a terminal to stop producing output, or to exit. Quiet is what an
 * agent actually wants: a shell that has finished a command sits idle at its
 * prompt and never exits.
 */
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
  // Restarted on every byte, and again after any gap this process slept through,
  // so quiet can only mean silence that was watched from one end to the other.
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

      // An exit is an event the runtime reported; unlike quiet it is not read
      // off the clock, so a sleep cannot invent one.
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
