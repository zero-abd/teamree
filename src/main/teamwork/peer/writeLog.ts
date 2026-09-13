// The owner's record of every keystroke a teammate sent, on the owner's own
// machine.
//
// WHY THERE ARE NO BYTES IN IT. The obvious content of an audit log for this
// feature is what was typed, and it is deliberately not here. Three reasons,
// and the middle one is the one that decides it:
//
// **The owner already sees the content.** A remote keystroke lands in a pane
// the owner is looking at, attributed live while it happens, and the shell
// echoes what it was. This file answers the question the screen cannot —
// *what happened while I was not looking, and who did it* — and that question
// is answered by who, when, which pane, how much, and whether it landed.
//
// **A write carries input, and input is not output.** What a terminal shows is
// what it chose to echo; what crosses this wire is every byte a teammate sent,
// including the ones a program deliberately swallows. A passphrase at an `ssh`
// prompt, a token pasted into a login, a recovery code — none of that is on the
// owner's screen or in their scrollback, and all of it would be in this file.
// That would build a plaintext credential store, out of other people's secrets,
// as a side effect of a safety feature. The screen is the less dangerous record
// precisely because a program can keep things off it, and a log of raw input
// takes that choice away from every program that ever made it.
//
// **A log nobody dares keep is a log that gets turned off.** This one is safe
// to retain, safe to hand to somebody, and safe to leave running for months,
// which is the only way an audit trail is ever there when it is wanted.
//
// What is kept instead of the bytes is their shape: the byte count, and how
// many submissions the write carried. "ana sent 46 bytes with 2 returns in it"
// is enough to tell a keypress from two commands, and tells nobody a password.
//
// The file is JSON Lines so it is greppable by hand, appended to rather than
// rewritten so a crash costs at most the last line, and rotated once at a cap
// so a stuck agent typing all night cannot fill a disk.

import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { RemoteWrite, RemoteWriteLog } from '../../../shared/entities'

/** Beside the identity, in the app's own data directory and never a repository. */
export const WRITE_LOG_DIR = 'teamwork'
export const WRITE_LOG_FILE = 'remote-writes.log'
/** One generation back, so a rotation does not throw away yesterday. */
export const WRITE_LOG_PREVIOUS_FILE = 'remote-writes.1.log'

/**
 * How much is kept before the current file becomes the previous one.
 *
 * An entry is around two hundred bytes, so this is some five thousand remote
 * keystrokes per generation — far more than a person types, and a bound a
 * runaway agent cannot turn into a full disk.
 */
export const WRITE_LOG_MAX_BYTES = 1_048_576

/**
 * The most one entry may be.
 *
 * The cap above is a bound on the file and was not a bound on a line, and a
 * line is written from what a teammate sent: the pane id they named goes in
 * here verbatim, and a refused write is recorded exactly like a landed one. So
 * two entries used to be able to be a megabyte each, rotate this file twice,
 * and take every earlier entry with them — the whole of the owner's evidence,
 * erased by the person it was evidence about, from the other end of a relay.
 *
 * Two kilobytes is ten times the largest entry anything here writes, and five
 * hundred of them to a rotation. Everything past it is truncated rather than
 * dropped: an entry that says *somebody typed, and their pane id was too long
 * to keep* is still the record of a write, and a write nothing recorded is not.
 */
export const WRITE_LOG_MAX_ENTRY_BYTES = 2_048

/**
 * The most of any one string in an entry that is kept.
 *
 * A handle, a key, a project, a pane id and a refusal are all short by
 * construction. This is the ceiling on the ones that arrive from a teammate.
 */
export const WRITE_LOG_MAX_FIELD_CHARS = 200

/** What a truncated field ends with, so a reader can see it was cut. */
export const WRITE_LOG_TRUNCATION_MARK = '…'

/**
 * Owner read/write. The same reasoning as the private key's mode: this holds no
 * secret, but it holds who reached this machine and when, which is nobody
 * else's business on a shared box.
 */
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
   * Files one write. Deliberately not async and deliberately cannot fail: the
   * caller is deciding whether bytes reach a pty, and an audit trail that could
   * hold that decision up is an audit trail that gets bypassed the first time a
   * disk is slow. Durability follows on its own; a failure to reach the disk
   * surfaces as `problem` on the next read and through `onError` at the time.
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
      // Rotated before rather than after, so the cap is a ceiling on what is
      // there rather than on what was there before the last burst.
      if (onDisk > 0 && onDisk + bytes > maxBytes) {
        await rename(current, previous)
        onDisk = 0
        // A rotation that pushes out the generation before it discards history,
        // and an audit trail that lost some of itself in silence is worse than
        // one that says so: `read` turns this line into the owner's `problem`,
        // and it survives a restart because it is on the disk rather than in
        // this process. Written at the head of the new file, where the hole is.
        text = `${JSON.stringify(rotationMarker(now()))}\n${text}`
        bytes = Buffer.byteLength(text, 'utf8')
      }
      await appendFile(current, text, { encoding: 'utf8', mode: WRITE_LOG_MODE })
      onDisk += bytes
      problem = null
    } catch (error) {
      // The entries are gone rather than retried. A retry queue here would grow
      // without bound for exactly as long as the thing that is wrong stays
      // wrong, and the loss is already being reported rather than swallowed.
      onDisk = undefined
      fail(error)
    }
  }

  return {
    record: (write) => {
      // Bounded here rather than trusted from the caller. Everything upstream
      // of this is a string somebody else chose the length of, and a line this
      // file cannot bound is a file the cap above cannot bound either.
      pending.push(boundedEntry(write))
      // Chained rather than raced: two appends in flight at once can interleave
      // their lines, and a record of who typed what in which order is the one
      // thing this file exists to be.
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
          // The oldest marker still retained is the edge of what is missing:
          // everything before it went with the generation this one replaced.
          discardedAt ??= rotated
          continue
        }
        const parsed = parseWrite(line)
        if (parsed === undefined) unreadable += 1
        else writes.push(parsed)
      }
      // A half-written last line after a crash is the ordinary way this
      // happens, and it is said rather than hidden: a record with a hole in it
      // that claimed to be complete would be the worst of both.
      const unread = unreadable > 0 ? `${unreadable} entr${unreadable === 1 ? 'y' : 'ies'} could not be read` : null
      // The same argument for the rotation: a log that silently began at the
      // point somebody filled it is a log that cannot be told from a log
      // nothing happened in.
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
 * The line that stands where discarded history was.
 *
 * Deliberately not shaped like an entry — `parseWrite` refuses it, and `read`
 * recognises it before trying — because an audit trail must never be able to
 * turn a note about itself into something that reads as somebody's keystroke.
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
 * One entry, cut down to something this file can hold a bound on.
 *
 * Fields first, because a field is the thing that is long; then the whole line,
 * because JSON escaping can make a short string a long one — a hundred control
 * characters is six hundred bytes of `\u00xx` — and a bound that only held for
 * well-behaved input would be no bound at all against somebody choosing it.
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
  // Escaping got there anyway. Given up in the order the owner can most afford
  // to lose: the words the teammate was given, then the id they named, then
  // everything else this machine knows about them.
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
 * One line back into an entry, refusing anything it cannot read exactly.
 *
 * The file is the owner's evidence, so a line that does not parse is counted
 * and dropped rather than guessed at: an invented entry in an audit trail is
 * worse than a missing one, because it would be believed.
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
