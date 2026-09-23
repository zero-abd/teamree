// What each pane printed, kept beside `workspace.json` (never inside it) as one
// bounded file per pane. Written from a pane exiting, the app quitting and a
// running checkpoint; one write chain, atomic renames, unchanged writes skipped.

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { sanitizeRecordedOutput, tailFromLineBoundary, type RecordedScrollback } from '../terminals/scrollbackRecord'
import { writeJsonFileAtomically } from './atomicJsonFile'

/** Beside `workspace.json`, in the app's own data directory. */
export const SCROLLBACK_DIR_NAME = 'scrollback'
export const SCROLLBACK_RECORD_VERSION = 1

/**
 * How much of one pane's output is kept: the tail, half of
 * `EXITED_RETENTION_BYTES`. Multiplied by every open pane, on disk and in memory.
 */
export const MAX_RECORD_BYTES = 128 * 1024

/**
 * Checked off the stat before the bytes are read. Well above what a capped
 * record serialises to even after JSON escaping.
 */
export const MAX_RECORD_FILE_BYTES = 1_000_000

/** A terminal id comes from an untrusted file; `..` and a separator cannot survive this. */
const TERMINAL_ID = /^[A-Za-z0-9_-]{1,64}$/

/** Files this directory is allowed to contain, and therefore to remove. */
const OWN_FILE = /^[A-Za-z0-9_-]{1,64}\.json$|\.tmp$/

export type ScrollbackArchiveOptions = {
  /** Said out loud rather than thrown: a failure costs a transcript, never the pane or the launch. */
  onProblem?: (reason: string) => void
  now?: () => number
}

/**
 * Satisfies the session manager's `ScrollbackRepository` port. `read` is
 * synchronous because the restore that consumes it runs before any window exists.
 */
export class ScrollbackArchive {
  readonly #onProblem: (reason: string) => void
  readonly #now: () => number

  #queue: Promise<void> = Promise.resolve()
  #reportedWriteFailure = false
  /**
   * Digest of what each pane's file was last asked to hold, so the three
   * overlapping writers do not rewrite a file to say what it already says.
   * A digest, not the tail: no second copy of every record in memory.
   */
  readonly #lastWritten = new Map<string, string>()

  private constructor(
    readonly directory: string,
    options: ScrollbackArchiveOptions
  ) {
    this.#onProblem = options.onProblem ?? ((reason) => console.warn('[scrollback]', reason))
    this.#now = options.now ?? Date.now
  }

  /**
   * Opens the directory and sweeps records nothing points at: the backstop for a
   * crash between the two writes. `keep` is undefined when the workspace file
   * could not be read — not knowing is not knowing there are none, so no sweep.
   */
  static async open(
    directory: string,
    keep: Iterable<string> | undefined,
    options: ScrollbackArchiveOptions = {}
  ): Promise<ScrollbackArchive> {
    const archive = new ScrollbackArchive(directory, options)
    if (keep === undefined) return archive
    const wanted = new Set([...keep].map((terminalId) => `${terminalId}.json`))

    let names: string[]
    try {
      names = await readdir(directory)
    } catch {
      // Nothing has been written yet, which is every first launch.
      return archive
    }

    for (const name of names) {
      if (wanted.has(name) || !OWN_FILE.test(name)) continue
      try {
        await rm(join(directory, name), { force: true })
      } catch (error) {
        archive.#onProblem(`could not remove ${name}: ${describe(error)}`)
      }
    }
    return archive
  }

  /**
   * The pane's record, or undefined when there is none to be had. Every failure
   * is the same answer: the caller can only open the pane empty.
   */
  read(terminalId: string): RecordedScrollback | undefined {
    const path = this.#pathFor(terminalId)
    if (path === undefined) return undefined

    try {
      const stats = statSync(path)
      if (stats.size > MAX_RECORD_FILE_BYTES) {
        this.#onProblem(`${path} is ${stats.size} bytes, past the ${MAX_RECORD_FILE_BYTES} allowed`)
        return undefined
      }
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof raw !== 'object' || raw === null) return undefined
      const { text, recordedAt, endedAt } = raw as Record<string, unknown>
      if (typeof text !== 'string' || text.length === 0) return undefined
      // `endedAt` is the pre-checkpoint name for the same number; still read so an
      // upgrade does not date every restored pane to the moment of the upgrade.
      const at = typeof recordedAt === 'number' ? recordedAt : endedAt

      // Sanitised and capped again here: the file is the boundary whatever wrote it.
      const kept = tailFromLineBoundary(sanitizeRecordedOutput(text), MAX_RECORD_BYTES)
      if (kept.length === 0) return undefined
      return { text: kept, recordedAt: typeof at === 'number' && Number.isFinite(at) ? at : this.#now() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#onProblem(`could not read the record for ${terminalId}: ${describe(error)}`)
      }
      return undefined
    }
  }

  /**
   * Writes the capped, inert tail of `text`. Queued; `flush` waits for it. An
   * unchanged record is skipped, timestamp included: it says when output was last new.
   */
  put(terminalId: string, text: string): void {
    const path = this.#pathFor(terminalId)
    if (path === undefined) return

    const kept = tailFromLineBoundary(sanitizeRecordedOutput(text), MAX_RECORD_BYTES)
    if (kept.length === 0) {
      this.remove(terminalId)
      return
    }

    const fingerprint = createHash('sha256').update(kept).digest('base64')
    if (this.#lastWritten.get(terminalId) === fingerprint) return
    // Taken now, not when the write lands: an exit and a quit arrive together.
    this.#lastWritten.set(terminalId, fingerprint)

    const document = {
      version: SCROLLBACK_RECORD_VERSION,
      terminalId,
      recordedAt: this.#now(),
      text: kept
    }
    this.#enqueue(
      async () => {
        await writeJsonFileAtomically(path, document)
      },
      `could not write the record for ${terminalId}`,
      // A failed write left something else on disk; forget it unless a later `put` has since been promised.
      () => {
        if (this.#lastWritten.get(terminalId) === fingerprint) this.#lastWritten.delete(terminalId)
      }
    )
  }

  /** Drops a pane's record, because the pane itself has been dropped. */
  remove(terminalId: string): void {
    const path = this.#pathFor(terminalId)
    if (path === undefined) return
    this.#lastWritten.delete(terminalId)
    this.#enqueue(async () => {
      await rm(path, { force: true })
    }, `could not remove the record for ${terminalId}`)
  }

  /** Waits for everything queued. Called on the way out, so the last write lands. */
  async flush(): Promise<void> {
    let awaited: Promise<void>
    do {
      awaited = this.#queue
      await awaited
    } while (awaited !== this.#queue)
  }

  #pathFor(terminalId: string): string | undefined {
    if (!TERMINAL_ID.test(terminalId)) {
      this.#onProblem(`refusing a record for an id that is not one: ${JSON.stringify(terminalId)}`)
      return undefined
    }
    return join(this.directory, `${terminalId}.json`)
  }

  /** One chain, so a shutdown writing every pane cannot hold a hundred file handles at once. */
  #enqueue(work: () => Promise<void>, failure: string, onFailure?: () => void): void {
    this.#queue = this.#queue.then(async () => {
      try {
        await work()
        this.#reportedWriteFailure = false
      } catch (error) {
        onFailure?.()
        // Said once: a full disk fails every pane on the way out.
        if (this.#reportedWriteFailure) return
        this.#reportedWriteFailure = true
        this.#onProblem(`${failure}: ${describe(error)}`)
      }
    })
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
