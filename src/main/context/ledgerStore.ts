// One project's coordination ledger on disk, `<userData>/memory/<projectId>.json`.
// Salvaged record by record on read, written back coalesced and crash-atomic.

import { rename, stat } from 'node:fs/promises'
import { z } from 'zod'
import { MAX_NOTE_CHARS, MAX_NOTE_PATHS, NOTE_KINDS, type MemoryNote } from '../../shared/memory'
import { MAX_CLAIM_GLOBS } from '../../shared/ledgerMethods'
import { openJsonFile, writeJsonFileAtomically } from '../store/atomicJsonFile'
import type { StoreProblem } from '../store/workspaceStore'

export const LEDGER_VERSION = 1
export const MAX_NOTES = 500
export const MAX_LANDINGS = 200
export const MAX_TOUCHED = 1000
export const MAX_WARNINGS = 50
const MAX_FILE_BYTES = 4_000_000

/** A warning shown about an overlap; `heeded` stays null until the edit-time hook measures it. */
export type LedgerWarning = { path: string; with: string; at: number; via: string; heeded: boolean | null }

export type LedgerWorktree = {
  id: string
  name: string
  branch: string
  /** The task's first line. */
  goal: string
  parentId?: string
  /** What it lands in: its parent's branch, or the base ref. */
  base?: string
  /** The record's state, or `landed` once its commits are in its base. */
  state: string
  owner: 'me'
  /** Committed since the base and uncommitted paths together, repo-relative. */
  touched: string[]
  /** The committed part of `touched`: all `git merge-tree` can see. */
  committed: string[]
  tip?: string
  ahead?: number
  claims: string[]
  /** Paths another live worktree touched too, over this one's life. */
  shared: string[]
  warnings: LedgerWarning[]
}

/** One landed worktree, for comparing periods with warnings on and off. Local only. */
export type LandingRecord = {
  worktreeId: string
  name: string
  into: string
  landedAt: number
  /** Paths the landing merge had to resolve. */
  conflicts: string[]
  shared: string[]
  warnings: LedgerWarning[]
}

export type LedgerDocument = {
  version: number
  revision: number
  worktrees: LedgerWorktree[]
  notes: MemoryNote[]
  landings: LandingRecord[]
}

export function emptyLedgerWorktree(id: string): LedgerWorktree {
  return {
    id,
    name: '',
    branch: '',
    goal: '',
    state: 'ready',
    owner: 'me',
    touched: [],
    committed: [],
    claims: [],
    shared: [],
    warnings: []
  }
}

const Text = z.string().max(4096)
const Paths = (max: number) => z.array(z.string().min(1).max(4096)).transform((paths) => paths.slice(0, max))

const Warning = z.object({
  path: Text,
  with: Text,
  at: z.number(),
  via: z.string().max(32),
  heeded: z.boolean().nullable()
})

const WorktreeSchema = z.object({
  id: z.string().min(1).max(256),
  name: Text,
  branch: Text,
  goal: Text,
  parentId: z.string().min(1).max(256).optional(),
  base: z.string().max(256).optional(),
  state: z.string().max(32),
  owner: z.literal('me'),
  touched: Paths(MAX_TOUCHED),
  committed: Paths(MAX_TOUCHED),
  tip: z.string().max(64).optional(),
  ahead: z.number().int().nonnegative().optional(),
  claims: Paths(MAX_CLAIM_GLOBS),
  shared: Paths(MAX_TOUCHED),
  warnings: z.array(Warning).transform((warnings) => warnings.slice(-MAX_WARNINGS))
})

const NoteSchema = z.object({
  id: z.string().min(1).max(256),
  worktreeId: z.string().min(1).max(256),
  kind: z.enum(NOTE_KINDS as [MemoryNote['kind'], ...MemoryNote['kind'][]]),
  text: z.string().max(MAX_NOTE_CHARS),
  scope: z.enum(['private', 'team']),
  open: z.boolean().optional(),
  answer: z.string().max(MAX_NOTE_CHARS).optional(),
  paths: z.array(z.string().min(1).max(4096)).max(MAX_NOTE_PATHS).optional(),
  at: z.number(),
  author: z.string().min(1).max(256),
  agentId: z.string().max(256).optional()
})

const LandingSchema = z.object({
  worktreeId: z.string().min(1).max(256),
  name: Text,
  into: Text,
  landedAt: z.number(),
  conflicts: Paths(MAX_TOUCHED),
  shared: Paths(MAX_TOUCHED),
  warnings: z.array(Warning).transform((warnings) => warnings.slice(-MAX_WARNINGS))
})

function salvage<T>(rows: unknown, schema: z.ZodType<T>, max: number): T[] {
  if (!Array.isArray(rows)) return []
  const kept: T[] = []
  for (const row of rows.slice(-max)) {
    const parsed = schema.safeParse(row)
    if (parsed.success) kept.push(parsed.data)
  }
  return kept
}

/** Never throws: a record that does not parse is dropped and the rest kept. */
export function parseLedger(raw: unknown): LedgerDocument {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const revision = typeof value.revision === 'number' && Number.isFinite(value.revision) ? value.revision : 0
  return {
    version: LEDGER_VERSION,
    revision,
    worktrees: salvage(value.worktrees, WorktreeSchema, 1000) as LedgerWorktree[],
    notes: salvage(value.notes, NoteSchema, MAX_NOTES) as MemoryNote[],
    landings: salvage(value.landings, LandingSchema, MAX_LANDINGS)
  }
}

export type LedgerStoreOptions = { onProblem?: (problem: StoreProblem) => void; now?: () => number }

export class LedgerStore {
  readonly #onProblem: (problem: StoreProblem) => void
  readonly #now: () => number
  #queue: Promise<void> = Promise.resolve()
  #queued = false
  #unreadableReason: string | undefined

  private constructor(
    readonly filePath: string,
    readonly projectId: string,
    readonly document: LedgerDocument,
    options: LedgerStoreOptions
  ) {
    this.#onProblem = options.onProblem ?? ((problem) => console.error('[context]', problem.kind, problem.filePath))
    this.#now = options.now ?? Date.now
  }

  static async open(filePath: string, projectId: string, options: LedgerStoreOptions = {}): Promise<LedgerStore> {
    const size = await stat(filePath).then(
      (stats) => stats.size,
      () => 0
    )
    const read =
      size > MAX_FILE_BYTES ? { kind: 'unreadable' as const, reason: `${size} bytes` } : await openJsonFile(filePath)
    const store = new LedgerStore(filePath, projectId, parseLedger(read.kind === 'parsed' ? read.value : {}), options)
    if (read.kind === 'unreadable') {
      store.#unreadableReason = read.reason
      store.#onProblem({ kind: 'unreadable', filePath, reason: read.reason })
    }
    return store
  }

  worktree(id: string): LedgerWorktree | undefined {
    return this.document.worktrees.find((worktree) => worktree.id === id)
  }

  addLanding(record: LandingRecord): void {
    this.document.landings.push(record)
    this.document.landings.splice(0, Math.max(0, this.document.landings.length - MAX_LANDINGS))
  }

  /** Queues a write of the whole document; several calls in a burst write once. */
  save(): void {
    if (this.#queued) return
    this.#queued = true
    this.#queue = this.#queue.then(async () => {
      this.#queued = false
      try {
        if (!(await this.#keepUnreadableFile())) return
        await writeJsonFileAtomically(this.filePath, this.document)
      } catch (error) {
        this.#onProblem({ kind: 'writeFailed', filePath: this.filePath, reason: describe(error) })
      }
    })
  }

  async flush(): Promise<void> {
    let awaited: Promise<void>
    do {
      awaited = this.#queue
      await awaited
    } while (awaited !== this.#queue)
  }

  async #keepUnreadableFile(): Promise<boolean> {
    if (this.#unreadableReason === undefined) return true
    const keptAt = `${this.filePath}.unreadable-${new Date(this.#now()).toISOString().replace(/[:.]/g, '-')}`
    try {
      await rename(this.filePath, keptAt)
    } catch (error) {
      this.#onProblem({ kind: 'notWritten', filePath: this.filePath, reason: describe(error) })
      return false
    }
    this.#unreadableReason = undefined
    this.#onProblem({ kind: 'keptAside', filePath: this.filePath, keptAt })
    return true
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
