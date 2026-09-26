// The coordination ledger: per project, what each worktree is for, which paths
// it touched or claimed, which of those a sibling shares, and the few decisions on them.

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { PROVIDER_TIMEOUT_MS, type MemoryEvent } from '../../shared/contextProvider'
import type { Project, Worktree } from '../../shared/entities'
import { MAX_CLAIM_GLOBS, type WorktreeClaims } from '../../shared/ledgerMethods'
import {
  LEDGER_BUDGET_TOKENS,
  clampContextBudget,
  emptyProjectContext,
  type ContextSection,
  type MemoryConflict,
  type MemoryNote,
  type NoteKind,
  type NoteScope,
  type ProjectContext
} from '../../shared/memory'
import type { WorktreeOverlap, WorktreeOverlaps } from '../../shared/tasks'
import { createGitRunner, type GitRunner } from '../git/gitProcess'
import type { GitSnapshot } from '../git/gitService'
import { notFound } from '../runtime/runtimeError'
import { buildBundle } from './bundle'
import { isAncestor, landingConflicts, mergeConflicts, readTouches } from './gitReads'
import { normalizeGlob } from './globs'
import {
  LedgerStore,
  MAX_NOTES,
  MAX_TOUCHED,
  MAX_WARNINGS,
  emptyLedgerWorktree,
  type LedgerDocument,
  type LedgerWorktree
} from './ledgerStore'
import { byCodeUnit, hotPathTest, rankOverlaps, unrelated, type RankedOverlap } from './ranking'
import { askSources, type ContextSource } from './source'

const MEMORY_DIR_NAME = 'memory'

/** `project.context` re-reads git first when the last pass is older than this. */
const FRESH_MS = 2_000
const GIT_READS_AT_ONCE = 4

export type ContextLedgerOptions = {
  /** `<userData>`; files go under `memory/`. */
  dataDir: string
  snapshot: () => GitSnapshot
  runner?: GitRunner
  now?: () => number
  /** Trailing quiet time before a scheduled pass. */
  refreshDelayMs?: number
  /** Floor between two scheduled passes. */
  minPassIntervalMs?: number
  /** Pairs checked with `git merge-tree` per pass; the rest wait for the next. */
  maxMergeTreesPerPass?: number
  /** Something an agent or the window reads changed. */
  onChange?: (projectId: string) => void
  providers?: ContextSource[]
}

export type LedgerStats = { passes: number; gitRuns: number; mergeTrees: number; lastPassMs: number }

type ProjectView = { project: Project; worktrees: Worktree[] }

export class ContextLedger {
  readonly #options: ContextLedgerOptions
  readonly #runner: GitRunner
  readonly #now: () => number
  readonly #stores = new Map<string, Promise<LedgerStore>>()
  /** Conflicts by the two commits compared, so an unchanged pair never runs twice. */
  readonly #merges = new Map<string, string[]>()
  readonly #stats: LedgerStats = { passes: 0, gitRuns: 0, mergeTrees: 0, lastPassMs: 0 }
  readonly #builtIn: ContextSource
  readonly #lastPassAt = new Map<string, number>()
  #running: Promise<void> = Promise.resolve()
  #timer: NodeJS.Timeout | undefined
  #closed = false

  constructor(options: ContextLedgerOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    const runner = options.runner ?? createGitRunner()
    const stats = this.#stats
    this.#runner = {
      binary: runner.binary,
      run: (run) => {
        stats.gitRuns += 1
        return runner.run(run)
      },
      tryRun: (run) => {
        stats.gitRuns += 1
        return runner.tryRun(run)
      }
    }
    this.#builtIn = { name: 'ledger', context: (query) => this.#bundle(query.worktreeId, query) }
  }

  stats(): LedgerStats {
    return { ...this.#stats }
  }

  /** Asks for a pass soon: after a quiet spell, and never sooner than the floor after the last. */
  schedule(): void {
    if (this.#closed || this.#timer !== undefined) return
    const last = Math.max(0, ...this.#lastPassAt.values())
    const wait = Math.max(
      this.#options.refreshDelayMs ?? 2_000,
      last + (this.#options.minPassIntervalMs ?? 5_000) - this.#now()
    )
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.refresh().catch((error: unknown) => console.error('[context]', error))
    }, wait)
    this.#timer.unref?.()
  }

  /** Re-reads git for every project, or one; passes run one at a time. */
  refresh(projectId?: string): Promise<void> {
    const pass = this.#running.then(async () => {
      if (this.#closed) return
      for (const view of this.#views()) {
        if (projectId === undefined || view.project.id === projectId) await this.#pass(view)
      }
    })
    this.#running = pass.catch(() => {})
    return pass
  }

  async close(): Promise<void> {
    this.#closed = true
    clearTimeout(this.#timer)
    await this.#running
    for (const store of this.#stores.values()) await (await store).flush()
  }

  async inspect(projectId: string): Promise<LedgerDocument> {
    return (await this.#store(projectId)).document
  }

  async context(params: {
    worktreeId: string
    budgetTokens?: number
    sections?: ContextSection[]
    query?: string
  }): Promise<ProjectContext> {
    const { project } = this.#locate(params.worktreeId)
    if ((this.#lastPassAt.get(project.id) ?? 0) < this.#now() - FRESH_MS) await this.refresh(project.id)
    return askSources(
      this.#options.providers ?? [],
      this.#builtIn,
      {
        projectId: project.id,
        worktreeId: params.worktreeId,
        budgetTokens: clampContextBudget(params.budgetTokens ?? LEDGER_BUDGET_TOKENS),
        ...(params.sections === undefined ? {} : { sections: params.sections }),
        ...(params.query === undefined ? {} : { query: params.query })
      },
      PROVIDER_TIMEOUT_MS
    )
  }

  async note(params: {
    worktreeId: string
    kind: NoteKind
    text: string
    scope?: NoteScope
    paths?: string[]
    terminalId?: string
  }): Promise<MemoryNote> {
    const { project } = this.#locate(params.worktreeId)
    const store = await this.#store(project.id)
    const note: MemoryNote = {
      id: randomUUID(),
      worktreeId: params.worktreeId,
      kind: params.kind,
      text: params.text.trim(),
      scope: params.scope ?? 'private',
      at: this.#now(),
      author: 'me',
      ...(params.kind === 'question' ? { open: true } : {}),
      ...(params.paths && params.paths.length > 0 ? { paths: [...new Set(params.paths.map(normalizeGlob))] } : {}),
      ...(params.terminalId === undefined ? {} : { agentId: params.terminalId })
    }
    store.document.notes.push(note)
    store.document.notes.splice(0, Math.max(0, store.document.notes.length - MAX_NOTES))
    this.#changed(store, { type: 'note', note })
    return note
  }

  async resolve(params: { noteId: string; answer?: string }): Promise<MemoryNote> {
    const { store, note } = await this.#findNote(params.noteId)
    note.open = false
    if (params.answer !== undefined && params.answer.trim() !== '') note.answer = params.answer.trim()
    this.#changed(store, { type: 'note', note })
    return note
  }

  async forget(params: { noteId: string }): Promise<{ forgotten: true }> {
    const { store, note } = await this.#findNote(params.noteId)
    store.document.notes = store.document.notes.filter((row) => row !== note)
    this.#changed(store, { type: 'noteForgotten', noteId: note.id })
    return { forgotten: true }
  }

  async claim(params: { worktreeId: string; globs: string[] }): Promise<WorktreeClaims> {
    const { store, row } = await this.#row(params.worktreeId)
    row.claims = [...new Set([...row.claims, ...params.globs.map(normalizeGlob)])].slice(0, MAX_CLAIM_GLOBS)
    this.#changed(store)
    return { worktreeId: row.id, globs: [...row.claims] }
  }

  async unclaim(params: { worktreeId: string; globs?: string[] }): Promise<WorktreeClaims> {
    const { store, row } = await this.#row(params.worktreeId)
    const gone = params.globs === undefined ? undefined : new Set(params.globs.map(normalizeGlob))
    row.claims = gone === undefined ? [] : row.claims.filter((glob) => !gone.has(glob))
    this.#changed(store)
    return { worktreeId: row.id, globs: [...row.claims] }
  }

  /** Other worktrees sharing this one's files, worth telling an agent about. */
  async conflicts(worktreeId: string): Promise<MemoryConflict[]> {
    const { project } = this.#locate(worktreeId)
    const store = await this.#store(project.id)
    const viewer = store.worktree(worktreeId)
    if (viewer === undefined) return []
    return this.#rank(store, viewer)
      .filter((overlap) => overlap.visible)
      .map((overlap) => ({
        worktreeId: overlap.worktreeId,
        owner: 'me',
        files: overlap.paths,
        conflicts: overlap.conflicts
      }))
  }

  /** Every overlapping pair, both ways round, hot files included and marked. */
  async overlaps(projectId: string): Promise<WorktreeOverlaps> {
    const store = await this.#store(projectId)
    const overlaps: WorktreeOverlap[] = []
    for (const viewer of this.#live(store)) {
      for (const overlap of this.#rank(store, viewer)) {
        overlaps.push({
          worktreeId: viewer.id,
          with: { worktreeId: overlap.worktreeId },
          paths: overlap.paths,
          conflicts: overlap.conflicts,
          ...(overlap.claimed.length > 0 ? { claimed: overlap.claimed } : {}),
          ...(overlap.hot.length > 0 ? { hot: overlap.hot } : {})
        })
      }
    }
    return { projectId, overlaps, readAt: this.#lastPassAt.get(projectId) ?? 0 }
  }

  /** A warning shown about an overlap, kept for the landing log. `via` names the surface. */
  async warned(worktreeId: string, warning: { path: string; with: string; via: string }): Promise<void> {
    const { store, row } = await this.#row(worktreeId)
    if (row.warnings.some((seen) => seen.path === warning.path && seen.with === warning.with)) return
    row.warnings.push({ ...warning, at: this.#now(), heeded: null })
    row.warnings.splice(0, Math.max(0, row.warnings.length - MAX_WARNINGS))
    store.save()
  }

  async #bundle(
    worktreeId: string,
    query: { budgetTokens: number; sections?: ContextSection[] }
  ): Promise<ProjectContext> {
    const { project } = this.#locate(worktreeId)
    const store = await this.#store(project.id)
    const viewer = store.worktree(worktreeId)
    if (viewer === undefined) return emptyProjectContext(worktreeId)
    const byId = new Map(store.document.worktrees.map((row) => [row.id, row]))
    const ancestors: LedgerWorktree[] = []
    for (let cursor = viewer.parentId; cursor !== undefined && ancestors.length < 16; ) {
      const ancestor = byId.get(cursor)
      if (ancestor === undefined) break
      ancestors.push(ancestor)
      cursor = ancestor.parentId
    }
    const context = buildBundle({
      viewer,
      ancestors,
      overlaps: this.#rank(store, viewer),
      others: this.#live(store).filter((other) => unrelated(viewer, other, byId)),
      notes: store.document.notes,
      budgetTokens: query.budgetTokens,
      ...(query.sections === undefined ? {} : { sections: query.sections }),
      revision: store.document.revision
    })
    for (const sibling of context.siblings) {
      for (const path of sibling.overlap.slice(0, 3))
        await this.warned(worktreeId, { path, with: sibling.worktreeId, via: 'context' })
    }
    return context
  }

  #rank(store: LedgerStore, viewer: LedgerWorktree): RankedOverlap[] {
    const live = this.#live(store)
    if (!live.includes(viewer)) return []
    const byId = new Map(store.document.worktrees.map((row) => [row.id, row]))
    const others = live.filter((other) => unrelated(viewer, other, byId))
    return rankOverlaps(viewer, others, {
      conflicts: (otherId) => {
        const other = byId.get(otherId)
        const key = other === undefined ? undefined : pairKey(viewer, other)
        return key === undefined ? [] : (this.#merges.get(key) ?? [])
      },
      isHot: hotPathTest(live)
    })
  }

  #live(store: LedgerStore): LedgerWorktree[] {
    return store.document.worktrees.filter((row) => row.state === 'ready')
  }

  #views(): ProjectView[] {
    const snapshot = this.#options.snapshot()
    return snapshot.projects.map((project) => ({
      project,
      worktrees: snapshot.worktrees.filter((worktree) => worktree.projectId === project.id)
    }))
  }

  #locate(worktreeId: string): { project: Project; worktree: Worktree } {
    for (const view of this.#views()) {
      const worktree = view.worktrees.find((row) => row.id === worktreeId)
      if (worktree !== undefined) return { project: view.project, worktree }
    }
    throw notFound(`No worktree "${worktreeId}"`)
  }

  async #row(worktreeId: string): Promise<{ store: LedgerStore; row: LedgerWorktree }> {
    const { project, worktree } = this.#locate(worktreeId)
    const store = await this.#store(project.id)
    return { store, row: this.#node(store, worktree) }
  }

  async #findNote(noteId: string): Promise<{ store: LedgerStore; note: MemoryNote }> {
    for (const view of this.#views()) {
      const store = await this.#store(view.project.id)
      const note = store.document.notes.find((row) => row.id === noteId)
      if (note !== undefined) return { store, note }
    }
    throw notFound(`No note "${noteId}"`)
  }

  #store(projectId: string): Promise<LedgerStore> {
    let store = this.#stores.get(projectId)
    if (store === undefined) {
      store = LedgerStore.open(join(this.#options.dataDir, MEMORY_DIR_NAME, `${projectId}.json`), projectId)
      this.#stores.set(projectId, store)
    }
    return store
  }

  #changed(store: LedgerStore, event?: MemoryEvent): void {
    store.document.revision += 1
    store.save()
    if (event !== undefined)
      for (const provider of this.#options.providers ?? []) provider.observe?.(store.projectId, event)
    this.#options.onChange?.(store.projectId)
  }

  /** The row for a worktree, made or brought up to date from its record. */
  #node(store: LedgerStore, worktree: Worktree): LedgerWorktree {
    let row = store.worktree(worktree.id)
    if (row === undefined) {
      row = emptyLedgerWorktree(worktree.id)
      store.document.worktrees.push(row)
    }
    row.name = worktree.name
    row.branch = worktree.branch
    row.goal = (worktree.task ?? '').split('\n')[0]?.trim() ?? ''
    // A worktree can be nested or moved back to the top level after it is made.
    if (worktree.parentId === undefined) delete row.parentId
    else row.parentId = worktree.parentId
    if (row.state !== 'landed' || worktree.state !== 'ready') row.state = worktree.state
    return row
  }

  #baseOf(view: ProjectView, worktree: Worktree): string {
    const parent = view.worktrees.find((row) => row.id === worktree.parentId)
    return parent?.branch ?? worktree.baseRef ?? view.project.baseRef
  }

  async #pass(view: ProjectView): Promise<void> {
    const started = this.#now()
    this.#lastPassAt.set(view.project.id, started)
    const store = await this.#store(view.project.id)
    const document = store.document
    const before = JSON.stringify(document.worktrees)
    let landedOrGone = false

    const present = new Set(view.worktrees.map((worktree) => worktree.id))
    for (const row of [...document.worktrees]) {
      if (present.has(row.id)) continue
      // Removed: a landing is still worth logging when its commits reached the base.
      const base = row.base ?? view.project.baseRef
      if (row.state === 'ready' && row.tip !== undefined && (row.ahead ?? 0) > 0) {
        if (await isAncestor(this.#runner, view.project.path, row.tip, base)) {
          await this.#land(store, row, base, view.project.path)
        }
      }
      document.worktrees = document.worktrees.filter((kept) => kept !== row)
      document.notes = document.notes.filter((note) => note.worktreeId !== row.id)
      landedOrGone = true
    }

    const rows = new Map(view.worktrees.map((worktree) => [worktree.id, this.#node(store, worktree)]))
    const ready = view.worktrees.filter((worktree) => worktree.state === 'ready' && worktree.missing !== true)
    await forEachLimited(ready, GIT_READS_AT_ONCE, async (worktree) => {
      const row = rows.get(worktree.id) as LedgerWorktree
      const base = this.#baseOf(view, worktree)
      row.base = base
      const touches = await readTouches(this.#runner, { cwd: worktree.path, base })
      if (touches === undefined) return
      if (row.state === 'ready' && (row.ahead ?? 0) > 0 && row.tip !== undefined && touches.ahead === 0) {
        if (await isAncestor(this.#runner, worktree.path, row.tip, base)) {
          await this.#land(store, row, base, worktree.path)
          landedOrGone = true
        }
      } else if (row.state === 'landed' && touches.ahead > 0) row.state = 'ready'
      row.committed = touches.committed
      row.touched = [...new Set([...touches.committed, ...touches.uncommitted])].sort(byCodeUnit).slice(0, MAX_TOUCHED)
      row.tip = touches.tip
      row.ahead = touches.ahead
    })

    this.#accumulateShared(store)
    const more = await this.#checkPairs(store, view.project.path)
    if (landedOrGone || JSON.stringify(document.worktrees) !== before) this.#changed(store)
    this.#stats.passes += 1
    this.#stats.lastPassMs = this.#now() - started
    if (more) this.schedule()
  }

  async #land(store: LedgerStore, row: LedgerWorktree, into: string, cwd: string): Promise<void> {
    const conflicts =
      row.tip === undefined ? [] : await landingConflicts(this.#runner, { cwd, tip: row.tip, base: into })
    store.addLanding({
      worktreeId: row.id,
      name: row.name,
      into,
      landedAt: this.#now(),
      conflicts,
      shared: [...row.shared],
      warnings: [...row.warnings]
    })
    row.state = 'landed'
    row.claims = []
    row.shared = []
    row.warnings = []
    store.document.notes = store.document.notes.filter((note) => note.worktreeId !== row.id)
    for (const provider of this.#options.providers ?? []) {
      provider.observe?.(store.projectId, { type: 'landed', worktreeId: row.id, into })
    }
  }

  /** Files each live worktree shared with another live one, over its life: the landing log's duplicate-edit measure. */
  #accumulateShared(store: LedgerStore): void {
    const live = this.#live(store)
    const byId = new Map(store.document.worktrees.map((row) => [row.id, row]))
    for (const row of live) {
      const others = new Set(live.filter((other) => unrelated(row, other, byId)).flatMap((other) => other.touched))
      const shared = row.touched.filter((path) => others.has(path))
      if (shared.length === 0) continue
      row.shared = [...new Set([...row.shared, ...shared])].sort(byCodeUnit).slice(0, MAX_TOUCHED)
    }
  }

  /** Runs merge-tree for pairs whose commits share a path and were not compared yet. True when some had to wait. */
  async #checkPairs(store: LedgerStore, cwd: string): Promise<boolean> {
    const live = this.#live(store).filter((row) => (row.ahead ?? 0) > 0 && row.tip !== undefined)
    const byId = new Map(store.document.worktrees.map((row) => [row.id, row]))
    let budget = this.#options.maxMergeTreesPerPass ?? 8
    for (let i = 0; i < live.length; i += 1) {
      for (let j = i + 1; j < live.length; j += 1) {
        const [left, right] = [live[i] as LedgerWorktree, live[j] as LedgerWorktree]
        const key = pairKey(left, right)
        if (key === undefined || this.#merges.has(key) || !unrelated(left, right, byId)) continue
        const theirs = new Set(right.committed)
        if (!left.committed.some((path) => theirs.has(path))) continue
        if (budget === 0) return true
        budget -= 1
        this.#stats.mergeTrees += 1
        const conflicts = await mergeConflicts(this.#runner, { cwd, left: left.tip!, right: right.tip! })
        if (this.#merges.size > 2_000) this.#merges.clear()
        this.#merges.set(key, conflicts ?? [])
      }
    }
    return false
  }
}

function pairKey(a: LedgerWorktree, b: LedgerWorktree): string | undefined {
  if (a.tip === undefined || b.tip === undefined || !(a.ahead ?? 0) || !(b.ahead ?? 0)) return undefined
  return a.tip < b.tip ? `${a.tip}:${b.tip}` : `${b.tip}:${a.tip}`
}

async function forEachLimited<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) await run(items[next++] as T)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
}
