// The coordination ledger: per project, what each worktree is for, which paths
// it touched or claimed, which of those a sibling shares, and the few decisions on them.

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { PROVIDER_TIMEOUT_MS, type MemoryEvent } from '../../shared/contextProvider'
import type { Project, Worktree } from '../../shared/entities'
import {
  MAX_CLAIM_GLOBS,
  type EditCheck,
  type EditOverlapKind,
  type ProjectMemory,
  type WorktreeClaims
} from '../../shared/ledgerMethods'
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
import { writeWorkingTree } from '../git/workingTree'
import { notFound } from '../runtime/runtimeError'
import { buildBundle } from './bundle'
import { editOverlaps, editWarning, repoRelative } from './editCheck'
import { baseChanges, isAncestor, landingConflicts, mergeConflicts, readTouches, resolveCommit } from './gitReads'
import { normalizeGlob } from '../../shared/globs'
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
  /** `git merge-tree` runs per pass, pairs and bases together; the rest wait for the next. */
  maxMergeTreesPerPass?: number
  /** Something an agent or the window reads changed. */
  onChange?: (projectId: string) => void
  providers?: ContextSource[]
  /** Settings › Warn Agents About Overlaps; absent, on. */
  warnAgents?: () => boolean
}

/** A teammate's worktree as presence carries it: changed paths, never contents. */
export type TeammatePaths = { handle: string; worktreeId: string; paths: readonly string[] }

export type LedgerStats = {
  passes: number
  gitRuns: number
  mergeTrees: number
  /** Working trees written for a merge-tree; an idle one is not written again. */
  snapshots: number
  lastPassMs: number
}

type ProjectView = { project: Project; worktrees: Worktree[] }

/** One worktree's side of a merge, as the last pass read it. */
type Side = {
  path: string
  tip: string
  ahead: number
  /** Changed on disk, not committed; relative to the checkout. */
  uncommitted: string[]
  /** The working tree last written, and the file dates behind it; none while a date could still move unseen. */
  tree?: string
  print?: string
  /** What this pass compares: the tip, or the tip and its working tree. Unset when out of any comparison. */
  key?: string
  snapped?: boolean
}

/** A worktree against the branch it merges into, once that branch changed a file it shared with a sibling. */
type Against = { with: { base: string; worktreeId?: string }; key: string }

const SNAPSHOT_TIMEOUT_MS = 20_000

export class ContextLedger {
  readonly #options: ContextLedgerOptions
  readonly #runner: GitRunner
  readonly #now: () => number
  readonly #stores = new Map<string, Promise<LedgerStore>>()
  /** Conflicts by the two sides compared (commit, or commit and tree), so an unchanged pair never runs twice. */
  readonly #merges = new Map<string, string[]>()
  readonly #sides = new Map<string, Side>()
  /** What a base changed since a tip left it, by tip and base commit. */
  readonly #moves = new Map<string, { paths: string[]; clipped: boolean }>()
  readonly #against = new Map<string, Against>()
  /** False once git turns down a tree for a side (before 2.45): commits alone, as before. */
  #treesWork = true
  readonly #stats: LedgerStats = { passes: 0, gitRuns: 0, mergeTrees: 0, snapshots: 0, lastPassMs: 0 }
  readonly #builtIn: ContextSource
  readonly #lastPassAt = new Map<string, number>()
  #running: Promise<void> = Promise.resolve()
  #timer: NodeJS.Timeout | undefined
  /** What the scheduled pass re-reads: 'all' once anything asked without naming worktrees. */
  #dirty: Set<string> | 'all' = new Set()
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

  /** Asks for a pass soon, re-reading `worktreeIds` or every worktree: after a quiet spell, never sooner than the floor. */
  schedule(worktreeIds?: readonly string[]): void {
    if (this.#closed) return
    if (worktreeIds === undefined || this.#dirty === 'all') this.#dirty = 'all'
    else for (const id of worktreeIds) this.#dirty.add(id)
    if (this.#timer !== undefined) return
    const last = Math.max(0, ...this.#lastPassAt.values())
    const wait = Math.max(
      this.#options.refreshDelayMs ?? 2_000,
      last + (this.#options.minPassIntervalMs ?? 5_000) - this.#now()
    )
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      const dirty = this.#dirty
      this.#dirty = new Set()
      void this.refresh(undefined, dirty === 'all' ? undefined : [...dirty]).catch((error: unknown) =>
        console.error('[context]', error)
      )
    }, wait)
    this.#timer.unref?.()
  }

  /** Re-reads git for every project, or one, and every worktree or those named; passes run one at a time. */
  refresh(projectId?: string, worktreeIds?: readonly string[]): Promise<void> {
    const only = worktreeIds === undefined ? undefined : new Set(worktreeIds)
    const pass = this.#running.then(async () => {
      if (this.#closed) return
      for (const view of this.#views()) {
        if (projectId === undefined || view.project.id === projectId) await this.#pass(view, only)
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

  async list(projectId: string): Promise<ProjectMemory> {
    const store = await this.#store(projectId)
    return {
      projectId,
      revision: store.document.revision,
      worktrees: this.#live(store).map((row) => ({
        worktreeId: row.id,
        claims: [...row.claims],
        touched: [...row.touched]
      })),
      notes: store.document.notes.map((note) => ({ ...note }))
    }
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

  /** Every overlapping pair, both ways round, hot files included and marked; then each teammate's paths against yours. */
  async overlaps(projectId: string, teammates: readonly TeammatePaths[] = []): Promise<WorktreeOverlaps> {
    // Merge-tree answers live in memory, so the first read after a launch runs a pass for them.
    if (!this.#lastPassAt.has(projectId)) await this.refresh(projectId)
    const store = await this.#store(projectId)
    const overlaps: WorktreeOverlap[] = []
    const live = this.#live(store)
    const isHot = hotPathTest(live)
    for (const viewer of live) {
      for (const overlap of this.#rank(store, viewer)) {
        const uncommitted = this.#uncommitted(overlap.conflicts, viewer.id, overlap.worktreeId)
        overlaps.push({
          worktreeId: viewer.id,
          with: { worktreeId: overlap.worktreeId },
          paths: overlap.paths,
          conflicts: overlap.conflicts,
          ...(overlap.claimed.length > 0 ? { claimed: overlap.claimed } : {}),
          ...(overlap.hot.length > 0 ? { hot: overlap.hot } : {}),
          ...(uncommitted.length > 0 ? { uncommitted } : {})
        })
      }
      const against = this.#against.get(viewer.id)
      const conflicts = against === undefined ? [] : (this.#merges.get(against.key) ?? [])
      if (against !== undefined && conflicts.length > 0) {
        const uncommitted = this.#uncommitted(conflicts, viewer.id)
        overlaps.push({
          worktreeId: viewer.id,
          with: against.with,
          paths: conflicts,
          conflicts,
          ...(uncommitted.length > 0 ? { uncommitted } : {})
        })
      }
      const mine = new Set(viewer.touched)
      for (const teammate of teammates) {
        const paths = teammate.paths.filter((path) => mine.has(path))
        if (paths.length === 0) continue
        paths.sort((a, b) => Number(isHot(a)) - Number(isHot(b)) || byCodeUnit(a, b))
        const hot = paths.filter(isHot)
        overlaps.push({
          worktreeId: viewer.id,
          with: { handle: teammate.handle, worktreeId: teammate.worktreeId },
          paths,
          conflicts: [],
          ...(hot.length > 0 ? { hot } : {})
        })
      }
    }
    return { projectId, overlaps, readAt: this.#lastPassAt.get(projectId) ?? 0 }
  }

  /**
   * A warning shown about an overlap, kept for the landing log. `via` names the surface.
   * False when that surface already said it, unless it has since become a conflict.
   */
  async warned(
    worktreeId: string,
    warning: { path: string; with: string; via: string; kind?: EditOverlapKind }
  ): Promise<boolean> {
    const { store, row } = await this.#row(worktreeId)
    const seen = row.warnings.find(
      (old) => old.path === warning.path && old.with === warning.with && old.via === warning.via
    )
    if (seen !== undefined) {
      if (warning.kind !== 'conflict' || seen.kind === 'conflict') return false
      seen.kind = 'conflict'
      seen.at = this.#now()
    } else {
      row.warnings.push({ ...warning, at: this.#now(), heeded: null })
      row.warnings.splice(0, Math.max(0, row.warnings.length - MAX_WARNINGS))
    }
    store.save()
    return true
  }

  /**
   * Siblings sharing the file at `path`, from the last pass alone. A `hook` check is an
   * agent about to edit: the path counts as touched at once, and each warning is logged and said once.
   */
  async check(params: { worktreeId: string; path: string; hook?: boolean }): Promise<EditCheck> {
    const { project, worktree } = this.#locate(params.worktreeId)
    const relative = repoRelative(worktree.path, params.path)
    const nothing: EditCheck = { worktreeId: worktree.id, path: relative ?? params.path, siblings: [], text: '' }
    if (relative === undefined || (params.hook === true && this.#options.warnAgents?.() === false)) return nothing
    const store = await this.#store(project.id)
    const viewer = store.worktree(worktree.id)
    const live = this.#live(store)
    if (viewer === undefined || !live.includes(viewer)) return nothing
    const byId = new Map(store.document.worktrees.map((row) => [row.id, row]))
    const siblings = editOverlaps(
      relative,
      live.filter((other) => unrelated(viewer, other, byId)),
      {
        conflicts: (other) => this.#merges.get(this.#pairKey(viewer.id, other.id) ?? '') ?? [],
        isHot: hotPathTest(live)
      }
    )
    if (params.hook !== true) return { ...nothing, siblings, text: editWarning(relative, siblings) }

    if (!viewer.touched.includes(relative)) {
      viewer.touched = [...viewer.touched, relative].sort(byCodeUnit).slice(0, MAX_TOUCHED)
      this.#changed(store)
    }
    const fresh: EditCheck['siblings'] = []
    for (const sibling of siblings) {
      const logged = await this.warned(worktree.id, {
        path: relative,
        with: sibling.worktreeId,
        via: 'edit',
        kind: sibling.kind
      })
      if (logged) fresh.push(sibling)
    }
    return { ...nothing, siblings, text: editWarning(relative, fresh) }
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
      conflicts: (otherId) => this.#merges.get(this.#pairKey(viewer.id, otherId) ?? '') ?? [],
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

  async #pass(view: ProjectView, only?: ReadonlySet<string>): Promise<void> {
    const started = this.#now()
    this.#lastPassAt.set(view.project.id, started)
    const store = await this.#store(view.project.id)
    const document = store.document
    const before = JSON.stringify(document.worktrees)
    let landedOrGone = false

    const present = new Set(view.worktrees.map((worktree) => worktree.id))
    for (const row of [...document.worktrees]) {
      if (present.has(row.id)) continue
      this.#sides.delete(row.id)
      this.#against.delete(row.id)
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
    const ready = view.worktrees.filter(
      (worktree) =>
        worktree.state === 'ready' && worktree.missing !== true && (only === undefined || only.has(worktree.id))
    )
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
      const side = this.#sides.get(row.id)
      const read = { path: worktree.path, tip: touches.tip, ahead: touches.ahead, uncommitted: touches.uncommitted }
      this.#sides.set(row.id, side === undefined || touches.uncommitted.length === 0 ? read : { ...side, ...read })
    })

    this.#accumulateShared(store)
    const more = await this.#checkPairs(store, view.project.path)
    if (landedOrGone || JSON.stringify(document.worktrees) !== before) this.#changed(store)
    this.#stats.passes += 1
    this.#stats.lastPassMs = this.#now() - started
    // Pairs left over need no worktree re-read.
    if (more) this.schedule([])
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
      // Heeded: the file an agent was warned about did not conflict when it landed.
      warnings: row.warnings.map((warning) => ({ ...warning, heeded: !conflicts.includes(warning.path) }))
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

  /**
   * Runs merge-tree for pairs whose work shares a path, and for a worktree against its base once that base changed a
   * file it shared with a sibling; each side is its commit plus any uncommitted work. True when some had to wait.
   */
  async #checkPairs(store: LedgerStore, cwd: string): Promise<boolean> {
    const live = this.#live(store)
    const byId = new Map(store.document.worktrees.map((row) => [row.id, row]))
    for (const row of live) {
      delete this.#sides.get(row.id)?.key
      this.#against.delete(row.id)
    }
    const working = live.filter((row) => this.#hasWork(row.id))
    let budget = this.#options.maxMergeTreesPerPass ?? 8
    let more = false
    const merge = async (key: string, left: Side, right: string, rightSide?: Side): Promise<void> => {
      if (this.#merges.has(key)) return
      if (budget === 0) {
        more = true
        return
      }
      budget -= 1
      this.#stats.mergeTrees += 1
      const trees = {
        ...(left.snapped === true ? { leftTree: left.tree } : {}),
        ...(rightSide?.snapped === true ? { rightTree: rightSide.tree } : {})
      }
      let conflicts = await mergeConflicts(this.#runner, { cwd, left: left.tip, right, ...trees })
      if (conflicts === undefined && Object.keys(trees).length > 0) {
        conflicts = await mergeConflicts(this.#runner, { cwd, left: left.tip, right })
        if (conflicts !== undefined) this.#treesWork = false
      }
      if (this.#merges.size > 2_000) this.#merges.clear()
      this.#merges.set(key, conflicts ?? [])
    }

    for (let i = 0; i < working.length; i += 1) {
      for (let j = i + 1; j < working.length; j += 1) {
        const [left, right] = [working[i] as LedgerWorktree, working[j] as LedgerWorktree]
        if (!unrelated(left, right, byId)) continue
        const shared = this.#treesWork ? left.touched : left.committed
        const theirs = new Set(this.#treesWork ? right.touched : right.committed)
        if (!shared.some((path) => theirs.has(path))) continue
        const [a, b] = [await this.#sideFor(left.id), await this.#sideFor(right.id)]
        const key = this.#pairKey(left.id, right.id)
        if (a === undefined || b === undefined || key === undefined) continue
        await merge(key, a, b.tip, b)
      }
    }

    const tips = new Map<string, string | undefined>()
    for (const row of working) {
      const touched = new Set(row.touched)
      if (row.base === undefined || !row.shared.some((path) => touched.has(path))) continue
      if (!tips.has(row.base)) tips.set(row.base, await resolveCommit(this.#runner, cwd, row.base))
      const tip = tips.get(row.base)
      const side = this.#sides.get(row.id)
      if (tip === undefined || side === undefined) continue
      const moveKey = `${side.tip}:${tip}`
      let moved = this.#moves.get(moveKey)
      if (moved === undefined) {
        moved = (await baseChanges(this.#runner, { cwd, tip: side.tip, base: tip })) ?? { paths: [], clipped: false }
        if (this.#moves.size > 2_000) this.#moves.clear()
        this.#moves.set(moveKey, moved)
      }
      if (!moved.clipped && !moved.paths.some((path) => touched.has(path))) continue
      const mine = await this.#sideFor(row.id)
      if (mine?.key === undefined) continue
      const key = `${mine.key}>${tip}`
      const parent = row.parentId === undefined ? undefined : byId.get(row.parentId)
      this.#against.set(row.id, {
        with: { base: row.base, ...(parent === undefined ? {} : { worktreeId: parent.id }) },
        key
      })
      await merge(key, mine, tip)
    }
    return more
  }

  #hasWork(worktreeId: string): boolean {
    const side = this.#sides.get(worktreeId)
    return side !== undefined && (side.ahead > 0 || (this.#treesWork && side.uncommitted.length > 0))
  }

  /** This pass's side for a worktree: its tip, and the tree of its uncommitted work when there is any. */
  async #sideFor(worktreeId: string): Promise<Side | undefined> {
    const side = this.#sides.get(worktreeId)
    if (side === undefined || side.key !== undefined) return side
    const tree = await this.#workingTree(side)
    side.snapped = tree !== undefined
    side.key = tree === undefined ? side.tip : `${side.tip}+${tree}`
    return side
  }

  /** Written again only when an uncommitted file's size or date moved; a list at the cap is left to the commits. */
  async #workingTree(side: Side): Promise<string | undefined> {
    if (!this.#treesWork || side.uncommitted.length === 0 || side.uncommitted.length >= MAX_TOUCHED) return undefined
    const readAt = Date.now()
    let settled = true
    const dates = await Promise.all(
      side.uncommitted.map((path) =>
        stat(join(side.path, path)).then(
          (file) => {
            // A file written within the clock's grain of this read could change again under the same date.
            if (file.mtimeMs > readAt - 1_000) settled = false
            return `${path}\0${file.size}\0${file.mtimeMs}`
          },
          () => `${path}\0gone`
        )
      )
    )
    const print = `${side.tip}\n${dates.join('\n')}`
    if (side.tree !== undefined && side.print === print) return side.tree
    this.#stats.snapshots += 1
    try {
      side.tree = await writeWorkingTree(this.#runner, {
        cwd: side.path,
        timeoutMs: SNAPSHOT_TIMEOUT_MS,
        readOnly: true
      })
    } catch {
      delete side.tree
    }
    if (settled) side.print = print
    else delete side.print
    return side.tree
  }

  #pairKey(a: string, b: string): string | undefined {
    const [x, y] = [this.#sides.get(a)?.key, this.#sides.get(b)?.key]
    if (x === undefined || y === undefined) return undefined
    return x < y ? `${x}:${y}` : `${y}:${x}`
  }

  /** The conflicts that rest on work not yet committed on either side. */
  #uncommitted(conflicts: readonly string[], ...worktreeIds: string[]): string[] {
    const paths = new Set(
      worktreeIds.flatMap((id) => {
        const side = this.#sides.get(id)
        return side?.snapped === true ? side.uncommitted : []
      })
    )
    return conflicts.filter((path) => paths.has(path))
  }
}

async function forEachLimited<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) await run(items[next++] as T)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
}
