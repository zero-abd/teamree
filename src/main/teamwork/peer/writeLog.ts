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
//
// THE CAP IS ALSO A WAY IN, AND THE CALLER CLOSES IT. Rotation is what stops a
// disk filling, and it is equally what lets whoever fills it decide what falls
// off the end: a refusal needs no valid pane and no valid project, so anybody
// who may open a link could once send enough of them to roll the owner's record
// of what they really typed out of both generations. This file does not judge
// what it is handed — it must not, or a record would depend on a guess — so the
// bound lives where the sender is known: `peerService.ts` files the first of a
// link's unaimed refusals as they are and collapses the rest into one entry
// carrying the count. Nothing here changes; what arrives is already bounded.

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
    const text = `${batch.map((write) => JSON.stringify(write)).join('\n')}\n`
    const bytes = Buffer.byteLength(text, 'utf8')
    try {
      await mkdir(directory, { recursive: true })
      onDisk ??= await sizeOf(current)
      // Rotated before rather than after, so the cap is a ceiling on what is
      // there rather than on what was there before the last burst.
      if (onDisk > 0 && onDisk + bytes > maxBytes) {
        await rename(current, previous)
        onDisk = 0
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
      pending.push(write)
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
      for (const line of `${older}${newer}`.split('\n')) {
        if (line.trim() === '') continue
        const parsed = parseWrite(line)
        if (parsed === undefined) unreadable += 1
        else writes.push(parsed)
      }
      // A half-written last line after a crash is the ordinary way this
      // happens, and it is said rather than hidden: a record with a hole in it
      // that claimed to be complete would be the worst of both.
      const detail = unreadable > 0 ? `${unreadable} entr${unreadable === 1 ? 'y' : 'ies'} could not be read` : null
      return {
        writes: limit === undefined ? writes : writes.slice(-limit),
        problem: problem ?? detail,
        readAt: now()
      }
    }
  }
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
