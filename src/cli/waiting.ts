// Blocking waits for agents. A coding agent driving teamree needs to know when
// a worktree is usable and when a command it typed has actually finished;
// without these it can only sleep and hope.

import type { RuntimeClient } from './transport.js'
import type { TerminalEvent } from '../shared/methods.js'

/** How long a terminal must produce nothing before it counts as quiet. */
export const DEFAULT_QUIET_MS = 1500
export const DEFAULT_WAIT_TIMEOUT_MS = 120_000

/** Fallback cadence when the runtime has no change stream to listen to. */
const POLL_INTERVAL_MS = 250

export class WaitTimeout extends Error {
  constructor(what: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for ${what}.`)
    this.name = 'WaitTimeout'
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Resolves once `read` returns a value `settled` accepts. Wakes on the workspace
 * change stream where the runtime offers one, and falls back to polling against
 * an older runtime that does not.
 */
export async function waitForState<T>(options: {
  client: RuntimeClient
  what: string
  read: () => Promise<T>
  settled: (value: T) => boolean
  timeoutMs: number
}): Promise<T> {
  const { client, what, read, settled, timeoutMs } = options
  const deadline = Date.now() + timeoutMs

  const first = await read()
  if (settled(first)) return first

  let wake: (() => void) | undefined
  let subscription: { unsubscribe: () => Promise<void> } | undefined
  try {
    subscription = await client.subscribe('workspace.subscribe', {}, () => wake?.())
  } catch {
    // No change stream on this runtime; polling still gets the job done.
  }

  try {
    while (Date.now() < deadline) {
      if (subscription) {
        // Still bounded by the poll interval so a missed event cannot hang us.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, POLL_INTERVAL_MS * 4)
          wake = () => {
            clearTimeout(timer)
            resolve()
          }
        })
        wake = undefined
      } else {
        await sleep(POLL_INTERVAL_MS)
      }

      const value = await read()
      if (settled(value)) return value
    }
  } finally {
    await subscription?.unsubscribe().catch(() => {})
  }

  throw new WaitTimeout(what, timeoutMs)
}

export type TerminalWaitResult = {
  reason: 'quiet' | 'exit' | 'already-exited'
  terminalId: string
  exitCode?: number
  /** Output observed while waiting, so a caller need not read separately. */
  output: string
}

/**
 * Waits for a terminal to stop producing output, or to exit. Quiet is what an
 * agent actually wants: a shell that has finished a command sits idle at its
 * prompt and never exits.
 */
export async function waitForTerminal(options: {
  client: RuntimeClient
  terminalId: string
  until: 'quiet' | 'exit'
  quietMs: number
  timeoutMs: number
}): Promise<TerminalWaitResult> {
  const { client, terminalId, until, quietMs, timeoutMs } = options

  const existing = await client.call('terminal.list', {})
  const terminal = existing.find((row) => row.id === terminalId)
  if (!terminal) throw new Error(`No such terminal: ${terminalId}`)
  if (!terminal.running) {
    return { reason: 'already-exited', terminalId, exitCode: terminal.exitCode, output: '' }
  }

  let output = ''
  let lastActivity = Date.now()
  let exited: { exitCode: number } | undefined

  const subscription = await client.subscribe('terminal.subscribe', { terminalId }, (raw) => {
    const event = raw as TerminalEvent
    if (event.type === 'data') {
      output += event.data
      lastActivity = Date.now()
    } else if (event.type === 'exit') {
      exited = { exitCode: event.exitCode }
    }
  })

  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      await sleep(Math.min(POLL_INTERVAL_MS, quietMs))
      if (exited) return { reason: 'exit', terminalId, exitCode: exited.exitCode, output }
      if (until === 'quiet' && Date.now() - lastActivity >= quietMs) {
        return { reason: 'quiet', terminalId, output }
      }
    }
  } finally {
    await subscription.unsubscribe().catch(() => {})
  }

  throw new WaitTimeout(`terminal ${terminalId}`, timeoutMs)
}
