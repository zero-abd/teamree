// What each teammate last showed, kept so a laptop closing does not empty the
// sidebar (see `docs/teamwork.md`). Beside the workspace file, not inside it:
// presence moves several times a minute. Everything bounded: every byte came from another disk.

import { rename, stat } from 'node:fs/promises'
import { z } from 'zod'
import type { PeerPane, PeerWorktree } from '../../shared/entities'
import { AgentKindOnRead } from '../terminals/agent-command'
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
/** Older than this and a snapshot has stopped being a picture of the project. */
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

/** A pane's name another build sent or wrote: anything but a string reads as unnamed, not as a bad record. */
export const PaneLabelOnRead = z.string().optional().catch(undefined)

const PaneSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  shell: z.string(),
  label: PaneLabelOnRead,
  agent: AgentKindOnRead,
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
 * Never throws: a row that does not parse is dropped and the rest kept.
 * Bounded again here; the file is the boundary whatever wrote it.
 */
export function parseTeammateCache(raw: unknown): TeammateCacheDocument {
  if (typeof raw !== 'object' || raw === null) return { version: TEAMMATE_CACHE_VERSION, teammates: [] }
  const rows = (raw as Record<string, unknown>).teammates
  if (!Array.isArray(rows)) return { version: TEAMMATE_CACHE_VERSION, teammates: [] }

  const teammates: CachedTeammate[] = []
  for (const candidate of rows.slice(0, MAX_CACHED_PEERS)) {
    const parsed = TeammateSchema.safeParse(candidate)
    if (parsed.success) teammates.push(boundTeammate(parsed.data))
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
  const bounded = { ...pane, id: clip(pane.id), title: clip(pane.title), shell: clip(pane.shell) }
  if (pane.label !== undefined) bounded.label = clip(pane.label)
  return bounded
}

function clip(text: string): string {
  return text.length <= MAX_CACHED_TEXT ? text : text.slice(0, MAX_CACHED_TEXT)
}

export type TeammateCacheOptions = {
  onProblem?: (problem: StoreProblem) => void
  now?: () => number
}

/** The cache as a file, read once at startup and written back coalesced. */
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
      // Checked before the bytes are read, so a grown file is never allocated.
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

  /** Replaces, never merges: a snapshot is the complete list, so what is missing is gone. */
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

  /** Moves an unreadable file aside: the one piece of evidence about why it failed to parse. */
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
