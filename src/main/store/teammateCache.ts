// What each teammate last showed, kept on this machine so that a laptop
// closing does not empty the sidebar.
//
// `docs/teamwork.md` argues the point better than a comment can: a row
// vanishing reads as "it was deleted", and for a worktree that is the one thing
// this app must never wrongly say. So a snapshot outlives the link it arrived
// on, and outlives this process too — a restart is the commonest way a peer
// link goes away, and a cache that did not survive one would be a cache that
// helps only with the case nobody notices.
//
// **It lives beside the workspace file, not inside it**, and that is a decision
// rather than a convenience. Presence moves whenever a pane goes busy or quiet,
// so folding it into `workspace.json` would rewrite the file holding somebody's
// projects several times a minute for data that is regenerated the moment a
// teammate reconnects. It also keeps bytes another machine sent out of the one
// file this app cannot afford to lose — the store's rule about never writing
// over something it could not read is about the user's own work, and nothing
// here is that.
//
// **Everything in it is bounded**, because every byte came from somebody else's
// disk. The peer is not assumed hostile; their workspace is assumed unknown,
// which is enough reason not to let a count or a string from it decide how much
// memory this process spends.

import { rename, stat } from 'node:fs/promises'
import { z } from 'zod'
import type { PeerPane, PeerWorktree } from '../../shared/entities'
import { AGENT_KINDS } from '../terminals/agent-command'
import { openJsonFile, writeJsonFileAtomically } from './atomicJsonFile'
import type { StoreProblem } from './workspaceStore'

export const TEAMMATE_CACHE_FILE = 'teammates.json'
export const TEAMMATE_CACHE_VERSION = 1

/** Teammate-and-project pairs kept. Past this, the least recently heard goes. */
export const MAX_CACHED_PEERS = 64
export const MAX_CACHED_WORKTREES = 50
export const MAX_CACHED_PANES = 24
/** Names, branches, titles and shells. Long enough for every real one. */
export const MAX_CACHED_TEXT = 160
/**
 * Older than this and a snapshot has stopped being a picture of the project.
 *
 * It is not a correctness bound — a stale row says how old it is, and a
 * fortnight-old one says so plainly — but an unbounded one would keep a
 * colleague's worktrees on screen for as long as the app is installed.
 */
export const MAX_CACHE_AGE_MS = 14 * 24 * 60 * 60 * 1000
/** Read before the file is: nothing this app wrote comes close. */
export const MAX_CACHE_BYTES = 2_000_000

/** One teammate's worktrees in one repository, as this machine last heard them. */
export type CachedTeammate = {
  publicKey: string
  projectKey: string
  /** What their own roster filed their key under, when they said. */
  handle: string | null
  /** When it was heard, by this machine's clock — never by theirs. */
  heardAt: number
  worktrees: PeerWorktree[]
}

/** The narrow port the peer service holds, so a test can hand it a map. */
export type TeammateCache = {
  get: (publicKey: string, projectKey: string) => CachedTeammate | undefined
  /** Replaces, never merges: see `TeammateCacheStore.put`. */
  put: (entry: CachedTeammate) => void
  flush: () => Promise<void>
}

const PaneSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  shell: z.string(),
  agent: z.enum(AGENT_KINDS as [string, ...string[]]).optional(),
  running: z.boolean(),
  exitCode: z.number().optional(),
  busy: z.boolean(),
  quietForMs: z.number().nonnegative()
})

const WorktreeSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  branch: z.string(),
  state: z.enum(['creating', 'ready', 'removing', 'failed']),
  panes: z.array(PaneSchema)
})

const TeammateSchema = z.object({
  publicKey: z.string().min(1),
  projectKey: z.string().min(1),
  handle: z.string().nullable(),
  heardAt: z.number(),
  worktrees: z.array(WorktreeSchema)
})

export type TeammateCacheDocument = {
  version: number
  teammates: CachedTeammate[]
}

/**
 * Never throws, and never trusts a count.
 *
 * A file written by another build of this app is the ordinary case, not the
 * exotic one, so a row that does not parse is dropped and the rest is kept —
 * the same trade `parseWorkspaceDocument` makes, for the same reason. Bounds
 * are applied here as well as on the way in, because the file is the boundary
 * whatever wrote it.
 */
export function parseTeammateCache(raw: unknown): TeammateCacheDocument {
  if (typeof raw !== 'object' || raw === null) return { version: TEAMMATE_CACHE_VERSION, teammates: [] }
  const rows = (raw as Record<string, unknown>).teammates
  if (!Array.isArray(rows)) return { version: TEAMMATE_CACHE_VERSION, teammates: [] }

  const teammates: CachedTeammate[] = []
  for (const candidate of rows.slice(0, MAX_CACHED_PEERS)) {
    const parsed = TeammateSchema.safeParse(candidate)
    if (parsed.success) teammates.push(boundTeammate(parsed.data as CachedTeammate))
  }
  return { version: TEAMMATE_CACHE_VERSION, teammates }
}

/** Caps every count and clips every string, in one place both directions use. */
export function boundTeammate(entry: CachedTeammate): CachedTeammate {
  return {
    publicKey: clip(entry.publicKey),
    projectKey: clip(entry.projectKey),
    handle: entry.handle === null ? null : clip(entry.handle),
    heardAt: entry.heardAt,
    worktrees: entry.worktrees.slice(0, MAX_CACHED_WORKTREES).map(boundWorktree)
  }
}

function boundWorktree(worktree: PeerWorktree): PeerWorktree {
  return {
    ...worktree,
    id: clip(worktree.id),
    name: clip(worktree.name),
    branch: clip(worktree.branch),
    panes: worktree.panes.slice(0, MAX_CACHED_PANES).map(boundPane)
  }
}

function boundPane(pane: PeerPane): PeerPane {
  return {
    ...pane,
    id: clip(pane.id),
    title: clip(pane.title),
    shell: clip(pane.shell)
  }
}

function clip(text: string): string {
  return text.length <= MAX_CACHED_TEXT ? text : text.slice(0, MAX_CACHED_TEXT)
}

export type TeammateCacheOptions = {
  onProblem?: (problem: StoreProblem) => void
  now?: () => number
}

/**
 * The cache as a file, read once at startup and written back coalesced.
 *
 * Reads are synchronous because the peer service answers from memory; writes
 * are queued the way the workspace store queues its own, so a burst of
 * snapshots costs one rename.
 */
export class TeammateCacheStore implements TeammateCache {
  readonly #entries = new Map<string, CachedTeammate>()
  readonly #onProblem: (problem: StoreProblem) => void
  readonly #now: () => number

  #queue: Promise<void> = Promise.resolve()
  #queued = false
  #writeError: unknown
  #reportedWriteFailure = false
  /** Set while the file on disk is one this process could not read. */
  #unreadableReason: string | undefined

  private constructor(
    readonly filePath: string,
    entries: readonly CachedTeammate[],
    options: TeammateCacheOptions
  ) {
    this.#onProblem = options.onProblem ?? ((problem) => console.error('[teammates]', problem.kind, problem.filePath))
    this.#now = options.now ?? Date.now
    for (const entry of entries) this.#entries.set(keyFor(entry.publicKey, entry.projectKey), entry)
    this.#prune()
  }

  static async open(filePath: string, options: TeammateCacheOptions = {}): Promise<TeammateCacheStore> {
    const oversized = await isOversized(filePath)
    if (oversized !== undefined) {
      // Read before the bytes are, so a file that has somehow grown cannot make
      // this process allocate it just to find out it was too big.
      const store = new TeammateCacheStore(filePath, [], options)
      store.#unreadableReason = oversized
      store.#onProblem({ kind: 'unreadable', filePath, reason: oversized })
      return store
    }

    const read = await openJsonFile(filePath)
    const document = read.kind === 'parsed' ? parseTeammateCache(read.value) : { teammates: [] }
    const store = new TeammateCacheStore(filePath, document.teammates, options)
    if (read.kind === 'unreadable') {
      store.#unreadableReason = read.reason
      store.#onProblem({ kind: 'unreadable', filePath, reason: read.reason })
    }
    return store
  }

  get(publicKey: string, projectKey: string): CachedTeammate | undefined {
    return this.#entries.get(keyFor(publicKey, projectKey))
  }

  list(): CachedTeammate[] {
    return [...this.#entries.values()]
  }

  /**
   * Replaces what was held for this teammate in this repository.
   *
   * Never a merge, and that is the whole of how a removed worktree stops being
   * shown: a teammate's snapshot is the complete list of what they have, so
   * anything missing from it is gone rather than unmentioned. Merging would
   * make the cache a place deleted work lived forever, which is the failure
   * this feature exists to avoid the inverse of.
   */
  put(entry: CachedTeammate): void {
    this.#entries.set(keyFor(entry.publicKey, entry.projectKey), boundTeammate(entry))
    this.#prune()
    this.#persist()
  }

  async flush(): Promise<void> {
    let awaited: Promise<void>
    do {
      awaited = this.#queue
      await awaited
    } while (awaited !== this.#queue)

    const error = this.#writeError
    if (error !== undefined) {
      this.#writeError = undefined
      throw error
    }
  }

  /** Age first, then count: the oldest snapshot is the least worth keeping. */
  #prune(): void {
    const cutoff = this.#now() - MAX_CACHE_AGE_MS
    for (const [key, entry] of [...this.#entries]) if (entry.heardAt < cutoff) this.#entries.delete(key)
    if (this.#entries.size <= MAX_CACHED_PEERS) return
    const oldestFirst = [...this.#entries].sort((a, b) => a[1].heardAt - b[1].heardAt)
    for (const [key] of oldestFirst.slice(0, this.#entries.size - MAX_CACHED_PEERS)) this.#entries.delete(key)
  }

  #persist(): void {
    if (this.#queued) return
    this.#queued = true
    this.#queue = this.#queue.then(async () => {
      this.#queued = false
      try {
        if (!(await this.#keepUnreadableFile())) return
        const document: TeammateCacheDocument = {
          version: TEAMMATE_CACHE_VERSION,
          teammates: this.list()
        }
        await writeJsonFileAtomically(this.filePath, document)
        this.#reportedWriteFailure = false
      } catch (error) {
        this.#writeError = error
        if (!this.#reportedWriteFailure) {
          this.#reportedWriteFailure = true
          this.#onProblem({
            kind: 'writeFailed',
            filePath: this.filePath,
            reason: describe(error)
          })
        }
      }
    })
  }

  /**
   * Moves an unreadable file aside before anything writes over it.
   *
   * Nothing in here is the user's own work — it is a cache, and the peers who
   * filled it will fill it again — but "could not read" and "is not there" are
   * two different events everywhere else in this directory, and a file this
   * process failed to parse is the one piece of evidence about why.
   */
  async #keepUnreadableFile(): Promise<boolean> {
    if (this.#unreadableReason === undefined) return true
    const keptAt = `${this.filePath}.unreadable-${new Date(this.#now()).toISOString().replace(/[:.]/g, '-')}`
    try {
      await rename(this.filePath, keptAt)
    } catch (error) {
      this.#onProblem({
        kind: 'notWritten',
        filePath: this.filePath,
        reason: describe(error)
      })
      return false
    }
    this.#unreadableReason = undefined
    this.#onProblem({ kind: 'keptAside', filePath: this.filePath, keptAt })
    return true
  }
}

/** Returns why the file is too big to read, or undefined when it is not. */
async function isOversized(filePath: string): Promise<string | undefined> {
  try {
    const stats = await stat(filePath)
    if (stats.size > MAX_CACHE_BYTES) return `the file is ${stats.size} bytes, past the ${MAX_CACHE_BYTES} allowed`
  } catch {
    // Missing, or unreadable in a way the read itself will report properly.
  }
  return undefined
}

/** A space, because a base64 key and a hex project key can neither contain one. */
function keyFor(publicKey: string, projectKey: string): string {
  return `${publicKey} ${projectKey}`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
