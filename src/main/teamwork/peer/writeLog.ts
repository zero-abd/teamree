// The owner's record of every keystroke a teammate sent: who, when, which pane, how much, whether it landed.
// Never the bytes — input includes what a program deliberately keeps off screen (a passphrase at an `ssh`
// prompt), and a log of it would be a plaintext credential store. JSON Lines, appended, rotated once at a cap.

import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { RemoteWrite, RemoteWriteLog } from '../../../shared/entities'

/** Beside the identity, in the app's own data directory and never a repository. */
export const WRITE_LOG_DIR = 'teamwork'
export const WRITE_LOG_FILE = 'remote-writes.log'
/** One generation back, so a rotation does not throw away yesterday. */
export const WRITE_LOG_PREVIOUS_FILE = 'remote-writes.1.log'

/**
 * How much is kept before the current file becomes the previous one: some five thousand entries. Rotation
 * is also a way in — enough refusals could roll the owner's real record out of both generations — so
 * `peerService.ts` collapses a link's unaimed refusals into one counted entry before they arrive here.
 */
export const WRITE_LOG_MAX_BYTES = 1_048_576

/**
 * The most one entry may be. A line carries strings a teammate chose the length of, so two entries could
 * once be a megabyte each and rotate the owner's evidence away twice. Truncated rather than dropped:
 * a write nothing recorded is not a record.
 */
export const WRITE_LOG_MAX_ENTRY_BYTES = 2_048

/** The most of any one string in an entry that is kept; the ceiling on the ones that arrive from a teammate. */
export const WRITE_LOG_MAX_FIELD_CHARS = 200

/** What a truncated field ends with, so a reader can see it was cut. */
export const WRITE_LOG_TRUNCATION_MARK = '…'

/** Owner read/write: no secret, but who reached this machine and when is nobody else's business on a shared box. */
export const WRITE_LOG_MODE = 0o600

export type RemoteWriteLogOptions = {
  /** The app's own data directory, never a repository. */
  dataDir: string
  now?: () => number
  maxBytes?: number
  /** Told once per failure, so a disk that has gone is not silent. */
  onError?: (error: unknown) => void
}

export type RemoteWriteRecorder = {
  /**
   * Files one write. Not async and cannot fail: an audit trail that could hold up a pty write gets bypassed
   * the first time a disk is slow. A failed append surfaces as `problem` on the next read and via `onError`.
   */
  record: (write: RemoteWrite) => void
  /** Everything retained, oldest first, with the newest `limit` kept. */
  read: (limit?: number) => Promise<RemoteWriteLog>
  /** Resolves when everything recorded so far is on disk. */
  flush: () => Promise<void>
}

export function createRemoteWriteLog(options: RemoteWriteLogOptions): RemoteWriteRecorder {
  const now = options.now ?? (() => Date.now())
  const maxBytes = options.maxBytes ?? WRITE_LOG_MAX_BYTES
  const directory = join(options.dataDir, WRITE_LOG_DIR)
  const current = join(directory, WRITE_LOG_FILE)
  const previous = join(directory, WRITE_LOG_PREVIOUS_FILE)

  /** Written but not yet on disk. Drained as one append, in arrival order. */
  const pending: RemoteWrite[] = []
  let writing: Promise<void> = Promise.resolve()
  let onDisk: number | undefined
  let problem: string | null = null

  const fail = (error: unknown): void => {
    problem = `the remote write log could not be written: ${messageOf(error)}`
    options.onError?.(error)
  }

  const drain = async (): Promise<void> => {
    const batch = pending.splice(0)
    if (batch.length === 0) return
    let text = `${batch.map((write) => JSON.stringify(write)).join('\n')}\n`
    let bytes = Buffer.byteLength(text, 'utf8')
    try {
      await mkdir(directory, { recursive: true })
      onDisk ??= await sizeOf(current)
      // Rotated before rather than after, so the cap is a ceiling on what is there.
      if (onDisk > 0 && onDisk + bytes > maxBytes) {
        await rename(current, previous)
        onDisk = 0
        // An audit trail that lost some of itself in silence is worse than one that says so: `read` turns
        // this line into `problem`, and it survives a restart because it is on disk. At the head, where the hole is.
        text = `${JSON.stringify(rotationMarker(now()))}\n${text}`
        bytes = Buffer.byteLength(text, 'utf8')
      }
      await appendFile(current, text, { encoding: 'utf8', mode: WRITE_LOG_MODE })
      onDisk += bytes
      problem = null
    } catch (error) {
      // Gone rather than retried: a retry queue grows without bound for as long as the disk stays wrong.
      onDisk = undefined
      fail(error)
    }
  }

  return {
    record: (write) => {
      // Bounded here rather than trusted: a line this file cannot bound is a file the cap cannot bound.
      pending.push(boundedEntry(write))
      // Chained rather than raced: two appends in flight can interleave their lines.
      writing = writing.then(drain, drain)
    },

    flush: () => writing,

    read: async (limit) => {
      await writing
      const [older, newer] = await Promise.all([readIfPresent(previous), readIfPresent(current)])
      const writes: RemoteWrite[] = []
      let unreadable = 0
      let discardedAt: number | undefined
      for (const line of `${older}${newer}`.split('\n')) {
        if (line.trim() === '') continue
        const rotated = rotationAt(line)
        if (rotated !== undefined) {
          // The oldest marker retained is the edge of what is missing.
          discardedAt ??= rotated
          continue
        }
        const parsed = parseWrite(line)
        if (parsed === undefined) unreadable += 1
        else writes.push(parsed)
      }
      // A half-written last line after a crash is ordinary, and said rather than hidden.
      const unread = unreadable > 0 ? `${unreadable} entr${unreadable === 1 ? 'y' : 'ies'} could not be read` : null
      // A log that silently began where somebody filled it cannot be told from one nothing happened in.
      const rotatedNote =
        discardedAt === undefined
          ? null
          : `entries before ${new Date(discardedAt).toISOString()} were discarded when this log reached its size cap`
      const detail = [rotatedNote, unread].filter((part) => part !== null).join('; ')
      return {
        writes: limit === undefined ? writes : writes.slice(-limit),
        problem: problem ?? (detail === '' ? null : detail),
        readAt: now()
      }
    }
  }
}

/**
 * The line that stands where discarded history was. Deliberately not shaped like an entry — `parseWrite`
 * refuses it — so a note about the log can never read as somebody's keystroke.
 */
function rotationMarker(at: number): { rotatedAt: number; discarded: string } {
  return { rotatedAt: at, discarded: 'entries older than this were discarded when the log reached its size cap' }
}

/** When a line says a rotation happened, or undefined for anything else. */
function rotationAt(line: string): number | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const at = (value as { rotatedAt?: unknown }).rotatedAt
  return typeof at === 'number' && Number.isFinite(at) ? at : undefined
}

/**
 * One entry, cut down to a bound. Fields first, then the whole line: JSON escaping makes a hundred control
 * characters six hundred bytes of `\u00xx`, and a bound only for well-behaved input is no bound.
 */
function boundedEntry(write: RemoteWrite): RemoteWrite {
  const bounded: RemoteWrite = {
    ...write,
    handle: clampField(write.handle),
    publicKey: clampField(write.publicKey),
    projectId: clampField(write.projectId),
    terminalId: clampField(write.terminalId)
  }
  if (write.reason !== undefined) bounded.reason = clampField(write.reason)
  if (entryBytes(bounded) <= WRITE_LOG_MAX_ENTRY_BYTES) return bounded
  // Escaping got there anyway; given up in the order the owner can most afford to lose.
  if (bounded.reason !== undefined) {
    bounded.reason = WRITE_LOG_TRUNCATION_MARK
    if (entryBytes(bounded) <= WRITE_LOG_MAX_ENTRY_BYTES) return bounded
  }
  bounded.terminalId = WRITE_LOG_TRUNCATION_MARK
  if (entryBytes(bounded) <= WRITE_LOG_MAX_ENTRY_BYTES) return bounded
  bounded.handle = WRITE_LOG_TRUNCATION_MARK
  bounded.publicKey = WRITE_LOG_TRUNCATION_MARK
  bounded.projectId = WRITE_LOG_TRUNCATION_MARK
  return bounded
}

function clampField(text: string): string {
  if (text.length <= WRITE_LOG_MAX_FIELD_CHARS) return text
  return `${text.slice(0, WRITE_LOG_MAX_FIELD_CHARS)}${WRITE_LOG_TRUNCATION_MARK}`
}

function entryBytes(write: RemoteWrite): number {
  return Buffer.byteLength(JSON.stringify(write), 'utf8')
}

/** How many submissions a write carried, which is what makes it a command. */
export function returnsIn(data: string): number {
  let count = 0
  for (const character of data) if (character === '\r' || character === '\n') count += 1
  return count
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

async function readIfPresent(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * One line back into an entry, refusing anything it cannot read exactly: an invented entry in an audit
 * trail is worse than a missing one, because it would be believed.
 */
function parseWrite(line: string): RemoteWrite | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.at !== 'number' || typeof record.handle !== 'string') return undefined
  if (typeof record.publicKey !== 'string' || typeof record.projectId !== 'string') return undefined
  if (typeof record.terminalId !== 'string' || typeof record.outcome !== 'string') return undefined
  if (typeof record.bytes !== 'number' || typeof record.returns !== 'number') return undefined
  const write: RemoteWrite = {
    at: record.at,
    handle: record.handle,
    publicKey: record.publicKey,
    projectId: record.projectId,
    terminalId: record.terminalId,
    bytes: record.bytes,
    returns: record.returns,
    outcome: record.outcome as RemoteWrite['outcome']
  }
  if (typeof record.reason === 'string') write.reason = record.reason
  return write
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
