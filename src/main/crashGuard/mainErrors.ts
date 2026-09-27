// What happens to an error nothing else caught in the main process: a line in the log, then either a
// notice in the window (the app still works) or one restart question (the launch did not finish).

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export const ERROR_LOG_NAME = 'main-errors.log'
export const ERROR_LOG_MAX_BYTES = 1_000_000
/** The window hears of at most one error in this long. */
export const NOTICE_GAP_MS = 60_000
/** Entries written per minute; a loop past this is only counted. */
export const LOG_BURST = 20
const BURST_WINDOW_MS = 60_000
const MAX_DETAILS_CHARS = 16_000

export type MainErrorsHost = {
  /** Resolved per write: the profile can change after this module loads. */
  logFile: () => string
  version: string
  now?: () => number
  /** The one terse question after a failed launch. */
  offerRestart: (details: string) => void
  print?: (entry: string) => void
}

export type MainErrors = {
  /** An error that reached the process's last handler: logged, and told to the window. */
  caught: (kind: string, error: unknown) => void
  /** Logged only; for errors with a place of their own to show. */
  log: (kind: string, error: unknown) => string
  launchFailed: (error: unknown) => void
  /** Where the window hears of errors; one seen before it arrived is told then. */
  attach: (notify: (details: string) => void) => void
  leaving: () => void
  logFile: () => string
}

/** Appends `entry`, first moving a file it would take past `maxBytes` to `<file>.1`. False when nothing was written. */
export function appendErrorLog(file: string, entry: string, maxBytes = ERROR_LOG_MAX_BYTES): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true })
    let size = 0
    try {
      size = statSync(file).size
    } catch {
      size = 0
    }
    if (size > 0 && size + Buffer.byteLength(entry) > maxBytes) renameSync(file, `${file}.1`)
    appendFileSync(file, entry)
    return true
  } catch {
    return false
  }
}

function describeError(error: unknown): string {
  let text: string
  if (error instanceof Error) text = error.stack ?? `${error.name}: ${error.message}`
  else if (typeof error === 'string') text = error
  else {
    try {
      text = JSON.stringify(error) ?? String(error)
    } catch {
      text = String(error)
    }
  }
  return text.length > MAX_DETAILS_CHARS ? `${text.slice(0, MAX_DETAILS_CHARS)}…` : text
}

export function createMainErrors(host: MainErrorsHost): MainErrors {
  const now = host.now ?? Date.now
  let state: 'running' | 'failed' | 'leaving' = 'running'
  let burstStart = -Infinity
  let logged = 0
  let dropped = 0
  let notify: ((details: string) => void) | undefined
  let pending: string | undefined
  let toldAt = -Infinity

  const log = (kind: string, error: unknown): string => {
    const at = now()
    const entry = `[${new Date(at).toISOString()}] teamree ${host.version} ${kind}\n${describeError(error)}\n\n`
    if (at - burstStart >= BURST_WINDOW_MS) {
      if (dropped > 0) appendErrorLog(host.logFile(), `${dropped} more not logged\n\n`)
      burstStart = at
      logged = 0
      dropped = 0
    }
    if (logged >= LOG_BURST) {
      dropped += 1
      return entry
    }
    logged += 1
    appendErrorLog(host.logFile(), entry)
    host.print?.(entry)
    return entry
  }

  const tell = (details: string): void => {
    if (notify === undefined) {
      pending ??= details
      return
    }
    if (now() - toldAt < NOTICE_GAP_MS) return
    toldAt = now()
    notify(details)
  }

  return {
    caught(kind, error) {
      // The handler of last resort: a throw here would come straight back to it.
      try {
        const details = log(kind, error)
        if (state === 'running') tell(details)
      } catch {
        return
      }
    },
    log(kind, error) {
      try {
        return log(kind, error)
      } catch {
        return ''
      }
    },
    launchFailed(error) {
      const details = log('launch failed', error)
      if (state !== 'running') return
      state = 'failed'
      host.offerRestart(details)
    },
    attach(next) {
      notify = next
      const early = pending
      pending = undefined
      if (early !== undefined && state === 'running') tell(early)
    },
    leaving() {
      if (state === 'running') state = 'leaving'
    },
    logFile: host.logFile
  }
}
