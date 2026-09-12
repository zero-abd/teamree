// The stateful half of the git layer: which repos are tracked, which worktrees
// exist, and what is happening to them right now.
//
// Two rules shape everything below.
//
// 1. `git worktree add` is slow — seconds on a large repo — and the app has to
//    stay responsive while several of them run. So create returns a record in
//    state 'creating' and the work continues on a background task that later
//    transitions the record to 'ready' or 'failed'. Subscribers learn about the
//    transition through `events`; nothing polls.
// 2. Records are a cache, not the truth. Someone will delete a checkout in a
//    terminal, so every list/get reconciles against `git worktree list` and
//    drops rows git no longer knows about.

import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  Project,
  Worktree,
  WorktreeChanges,
  WorktreeCommit,
  WorktreeDiff,
  WorktreeMergePreview,
  WorktreeStatus
} from '../../shared/entities'
import type { ParamsOf } from '../../shared/methods'
import { ErrorCode } from '../../shared/protocol'
import { describeError, GitCommandError, GitServiceError } from './errors'
import { createGitRunner, type GitRunner } from './gitProcess'
import { createVersionProbe } from './gitVersion'
import { isInside, pathKey, samePath } from './pathIdentity'
import { createMemoryRecordStore, type GitRecordStore } from './recordStore'
import { detectBaseRef, inspectRepository, listBranchNames } from './repository'
import { listStartPoints, resolveStartPoint, type ResolvedStartPoint, type StartPointList } from './startPoint'
import { readWorktreeInventory } from './worktreeInventory'
import { allocateBranchName, allocateCheckoutPath, branchCollides } from './worktreeNaming'
import { readMergePreview } from './mergePreview'
import { commitWorktree } from './worktreeCommit'
import { readWorktreeChanges, readWorktreeDiff } from './worktreeChanges'
import { readWorktreeStatus } from './worktreeStatus'

export type GitEvent =
  | { type: 'project.added'; project: Project }
  | { type: 'project.removed'; projectId: string }
  | { type: 'worktree.created'; worktree: Worktree }
  | { type: 'worktree.updated'; worktree: Worktree }
  | { type: 'worktree.removed'; worktreeId: string; projectId: string }

export type GitEventListener = (event: GitEvent) => void

/** Minimal emitter: subscribe, get an unsubscribe back. */
export class GitEventEmitter {
  readonly #listeners = new Set<GitEventListener>()

  on(listener: GitEventListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  emit(event: GitEvent): void {
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener(event)
      } catch {
        // A broken subscriber must not abort a state transition.
      }
    }
  }
}

export type GitServiceOptions = {
  /** Parent of every checkout this app creates. */
  worktreesRoot?: string
  gitBinary?: string
  runner?: GitRunner
  /** Durable record store. Defaults to an in-memory one. */
  store?: GitRecordStore
  /** Ceiling for `git worktree add`; big repos are slow. */
  createTimeoutMs?: number
  /** Rows `listStartPoints` will return before it reports itself truncated. */
  startPointLimit?: number
  now?: () => number
  createId?: () => string
}

/** What the runtime persists between launches. */
export type GitSnapshot = { projects: Project[]; worktrees: Worktree[] }

type BranchVerdict = 'skip' | 'safe' | 'force'

const DEFAULT_CREATE_TIMEOUT_MS = 10 * 60_000

// git's own ref rules, minus the parts our slugs can never produce.
const BRANCH_FORBIDDEN = /[\s~^:?*[\\]|^-|^\.|\.\.|@\{|\.lock$|^\/|\/$|\/\/|\/\./

export class GitService {
  readonly events = new GitEventEmitter()

  readonly #runner: GitRunner
  readonly #worktreesRoot: string
  readonly #createTimeoutMs: number
  readonly #now: () => number
  readonly #createId: () => string
  readonly #ensureVersion: (cwd: string) => Promise<unknown>

  readonly #store: GitRecordStore
  readonly #startPointLimit: number | undefined
  readonly #creating = new Map<string, AbortController>()
  readonly #settling = new Map<string, Promise<Worktree>>()
  // How each worktree's start point was interpreted. Advisory display detail
  // with nowhere to live on the frozen Worktree, so it is session-scoped: the
  // durable answer is `startedFrom`, which holds the resolved sha.
  readonly #startPoints = new Map<string, ResolvedStartPoint>()
  #disposed = false

  constructor(options: GitServiceOptions = {}) {
    this.#runner = options.runner ?? createGitRunner(options.gitBinary)
    this.#store = options.store ?? createMemoryRecordStore()
    this.#worktreesRoot = options.worktreesRoot ?? path.join(os.homedir(), '.teamree', 'worktrees')
    this.#createTimeoutMs = options.createTimeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS
    this.#startPointLimit = options.startPointLimit
    this.#now = options.now ?? Date.now
    this.#createId = options.createId ?? randomUUID
    this.#ensureVersion = createVersionProbe(this.#runner)
  }

  get worktreesRoot(): string {
    return this.#worktreesRoot
  }

  // ----------------------------------------------------------------- projects

  listProjects(): Project[] {
    return this.#store.listProjects()
  }

  async addProject(params: ParamsOf<'project.add'>): Promise<Project> {
    await this.#ensureVersion(process.cwd())
    const info = await inspectRepository(this.#runner, params.path)

    const key = pathKey(info.root)
    for (const project of this.#store.listProjects()) {
      if (pathKey(project.path) === key) {
        throw new GitServiceError(ErrorCode.Conflict, `"${project.name}" already tracks ${info.root}`)
      }
    }

    const project: Project = {
      id: this.#createId(),
      name: params.name?.trim() || info.defaultName,
      path: info.root,
      baseRef: await detectBaseRef(this.#runner, info.root)
    }
    this.#store.putProject(project)
    this.events.emit({ type: 'project.added', project })
    return project
  }

  /**
   * Untracks the repo and forgets its worktrees. Nothing on disk is touched:
   * deleting checkouts as a side effect of tidying the sidebar would be
   * unforgivable, so destroying a worktree stays an explicit act.
   */
  async removeProject(params: ParamsOf<'project.remove'>): Promise<{ removed: true }> {
    const project = this.#requireProject(params.projectId)
    for (const worktree of this.#store.listWorktrees(project.id)) {
      await this.cancelWorktreeCreate(worktree.id).catch(() => undefined)
      this.#store.removeWorktree(worktree.id)
      this.events.emit({ type: 'worktree.removed', worktreeId: worktree.id, projectId: project.id })
    }
    this.#store.removeProject(project.id)
    this.events.emit({ type: 'project.removed', projectId: project.id })
    return { removed: true }
  }

  // ---------------------------------------------------------------- worktrees

  async listWorktrees(params: ParamsOf<'worktree.list'> = {}): Promise<Worktree[]> {
    await this.#reconcile(params.projectId)
    return this.#store
      .listWorktrees(params.projectId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }

  async getWorktree(params: ParamsOf<'worktree.get'>): Promise<Worktree> {
    const known = this.#store.getWorktree(params.worktreeId)
    if (known) await this.#reconcile(known.projectId)
    return this.#requireWorktree(params.worktreeId)
  }

  /**
   * Returns as soon as the record exists, in state 'creating'. The checkout is
   * built on a background task; `whenSettled` or an `events` subscription tells
   * you how it ended.
   */
  async createWorktree(params: ParamsOf<'worktree.create'>): Promise<Worktree> {
    const project = this.#requireProject(params.projectId)
    const name = params.name.trim()
    if (!name) throw new GitServiceError(ErrorCode.InvalidParams, 'worktree name must not be blank')

    const branch = await this.#chooseBranch(project, name, params.branch)
    const checkoutPath = await allocateCheckoutPath(
      this.#worktreesRoot,
      project.name,
      branch,
      new Set(this.#store.listWorktrees().map((worktree) => pathKey(worktree.path)))
    )

    const worktree: Worktree = {
      id: this.#createId(),
      projectId: project.id,
      name,
      branch,
      path: checkoutPath,
      startedFrom: params.startedFrom?.trim() || project.baseRef,
      state: 'creating',
      createdAt: this.#now()
    }
    this.#store.putWorktree(worktree)
    this.events.emit({ type: 'worktree.created', worktree })

    const controller = new AbortController()
    this.#creating.set(worktree.id, controller)
    const task = this.#buildCheckout(worktree.id, project, controller.signal)
    this.#settling.set(worktree.id, task)
    void task.catch(() => undefined)

    return worktree
  }

  /** Resolves with the record once creation has finished, however it finished. */
  async whenSettled(worktreeId: string): Promise<Worktree> {
    const pending = this.#settling.get(worktreeId)
    if (pending) return pending
    return this.#requireWorktree(worktreeId)
  }

  /** Kills the running `git worktree add` and cleans up what it left behind. */
  async cancelWorktreeCreate(worktreeId: string): Promise<Worktree | null> {
    const controller = this.#creating.get(worktreeId)
    if (!controller) return this.#store.getWorktree(worktreeId) ?? null
    const pending = this.#settling.get(worktreeId)
    controller.abort()
    const settled = await pending?.catch(() => undefined)
    return settled ?? this.#store.getWorktree(worktreeId) ?? null
  }

  async removeWorktree(params: ParamsOf<'worktree.remove'>): Promise<{ removed: true }> {
    const initial = this.#requireWorktree(params.worktreeId)
    if (initial.state === 'creating') await this.cancelWorktreeCreate(initial.id)

    const worktree = this.#requireWorktree(params.worktreeId)
    const project = this.#store.getProject(worktree.projectId)
    const force = params.force === true

    if (!project) {
      // The repo was untracked underneath us; the row is all that is left.
      this.#forget(worktree)
      return { removed: true }
    }

    // Judged before anything is destroyed: refusing after the checkout is gone
    // would leave the user worse off than refusing outright.
    let branchVerdict: BranchVerdict = 'skip'
    if (params.deleteBranch) branchVerdict = await this.#judgeBranchDeletion(project, worktree.branch, force)

    const previousState = worktree.state
    if (!this.#patch(worktree.id, { state: 'removing' })) return { removed: true }

    try {
      await this.#detachCheckout(project, worktree, force)
    } catch (error) {
      this.#patch(worktree.id, { state: previousState })
      throw error
    }

    this.#forget(worktree)
    if (branchVerdict !== 'skip') await this.#deleteBranch(project, worktree.branch, branchVerdict === 'force')
    return { removed: true }
  }

  async worktreeStatus(params: ParamsOf<'worktree.status'>): Promise<WorktreeStatus> {
    const worktree = this.#requireWorktree(params.worktreeId)
    if (worktree.state !== 'ready') {
      throw new GitServiceError(
        ErrorCode.Conflict,
        `worktree "${worktree.name}" is ${worktree.state}; status is only available once it is ready`
      )
    }
    const project = this.#store.getProject(worktree.projectId)
    return readWorktreeStatus(this.#runner, {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      fallbackBranch: worktree.branch,
      baseRef: project?.baseRef,
      now: this.#now
    })
  }

  /**
   * Every changed path in a worktree. The counters answer whether there is
   * anything to look at; this is the looking.
   */
  async worktreeChanges(params: ParamsOf<'worktree.changes'>): Promise<WorktreeChanges> {
    const worktree = this.#requireReadyWorktree(params.worktreeId, 'changes')
    return readWorktreeChanges(this.#runner, {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      ...(params.limit === undefined ? {} : { limit: params.limit }),
      now: this.#now
    })
  }

  /** The patch for a worktree, or for one path in it. */
  async worktreeDiff(params: ParamsOf<'worktree.diff'>): Promise<WorktreeDiff> {
    const worktree = this.#requireReadyWorktree(params.worktreeId, 'a diff')
    return readWorktreeDiff(this.#runner, {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      ...(params.path === undefined ? {} : { path: params.path }),
      ...(params.staged === undefined ? {} : { staged: params.staged }),
      ...(params.contextLines === undefined ? {} : { contextLines: params.contextLines }),
      ...(params.maxBytes === undefined ? {} : { maxBytes: params.maxBytes }),
      now: this.#now
    })
  }

  /**
   * Commits in a worktree. The first write this service makes to a repository,
   * and the only one; everything else here reads.
   */
  async worktreeCommit(params: ParamsOf<'worktree.commit'>): Promise<WorktreeCommit> {
    const worktree = this.#requireReadyWorktree(params.worktreeId, 'committing')
    return commitWorktree(this.#runner, {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      message: params.message,
      ...(params.paths === undefined ? {} : { paths: params.paths }),
      now: this.#now
    })
  }

  /**
   * Whether this worktree would merge into its project's base ref.
   *
   * Run from the primary checkout rather than the worktree: the merge is
   * hypothetical and belongs to the repository, not to either side of it.
   */
  async worktreeMergePreview(params: ParamsOf<'worktree.mergePreview'>): Promise<WorktreeMergePreview> {
    const worktree = this.#requireReadyWorktree(params.worktreeId, 'a merge preview')
    const project = this.#store.getProject(worktree.projectId)
    if (!project) {
      throw new GitServiceError(ErrorCode.NotFound, `worktree "${worktree.name}" has no project to merge into`)
    }
    return readMergePreview(this.#runner, {
      worktreeId: worktree.id,
      repoPath: project.path,
      baseRef: project.baseRef,
      branch: worktree.branch,
      now: this.#now
    })
  }

  /**
   * A worktree that can be read from. Anything not yet `ready` has no checkout
   * on disk, so the honest answer is a conflict rather than an empty result.
   */
  #requireReadyWorktree(worktreeId: string, what: string): Worktree {
    const worktree = this.#requireWorktree(worktreeId)
    if (worktree.state !== 'ready') {
      throw new GitServiceError(
        ErrorCode.Conflict,
        `worktree "${worktree.name}" is ${worktree.state}; ${what} is only available once it is ready`
      )
    }
    return worktree
  }

  // ------------------------------------------------------------- start points

  /**
   * What the create dialog can offer as a starting point: the base ref first,
   * then the current branch, then local branches, remote branches and tags,
   * each most-recent first. Capped, and the result says when it was capped.
   *
   * No method in the frozen contract exposes this, so it is reached on the
   * service the way `events.on` and `cancelWorktreeCreate` are. See handlers.ts.
   */
  async listStartPoints(projectId: string, options: { limit?: number } = {}): Promise<StartPointList> {
    const project = this.#requireProject(projectId)
    const limit = options.limit ?? this.#startPointLimit
    return listStartPoints(this.#runner, {
      root: project.path,
      baseRef: project.baseRef,
      ...(limit === undefined ? {} : { limit })
    })
  }

  /**
   * How a worktree's start point was read: which ref won, what it was, whether
   * a fetch was needed, and any same-named ref that was passed over. Present
   * only for worktrees this process created; `Worktree.startedFrom` carries the
   * durable part.
   */
  startPointFor(worktreeId: string): ResolvedStartPoint | undefined {
    return this.#startPoints.get(worktreeId)
  }

  /** Resolves a start point without creating anything, for a dialog's preview. */
  async describeStartPoint(projectId: string, startedFrom?: string): Promise<ResolvedStartPoint> {
    const project = this.#requireProject(projectId)
    return resolveStartPoint(this.#runner, {
      root: project.path,
      requested: startedFrom?.trim() || project.baseRef
    })
  }

  // -------------------------------------------------------------- persistence

  snapshot(): GitSnapshot {
    return { projects: this.#store.listProjects(), worktrees: this.#store.listWorktrees() }
  }

  /**
   * Restores records saved before a restart. Anything mid-flight then is dead
   * now: the process that owned the `git worktree add` is gone.
   */
  hydrate(snapshot: GitSnapshot): void {
    for (const project of snapshot.projects) this.#store.putProject(project)
    for (const worktree of snapshot.worktrees) this.#store.putWorktree(worktree)
    this.reviveRestoredRecords()
  }

  /**
   * Call once at startup when records came from a store that outlived the
   * process: whatever was mid-flight then has no owner now.
   */
  reviveRestoredRecords(): void {
    for (const worktree of this.#store.listWorktrees()) {
      if (worktree.state === 'creating') {
        this.#store.putWorktree({ ...worktree, state: 'failed', error: 'interrupted by a restart' })
      } else if (worktree.state === 'removing') {
        this.#store.putWorktree({ ...worktree, state: 'ready' })
      }
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    await Promise.all([...this.#creating.keys()].map((id) => this.cancelWorktreeCreate(id).catch(() => undefined)))
  }

  // ---------------------------------------------------------------- internals

  #requireProject(projectId: string): Project {
    const project = this.#store.getProject(projectId)
    if (!project) throw new GitServiceError(ErrorCode.NotFound, `no project with id "${projectId}"`)
    return project
  }

  #requireWorktree(worktreeId: string): Worktree {
    const worktree = this.#store.getWorktree(worktreeId)
    if (!worktree) throw new GitServiceError(ErrorCode.NotFound, `no worktree with id "${worktreeId}"`)
    return worktree
  }

  #patch(worktreeId: string, patch: Partial<Worktree> & { clearError?: boolean }): Worktree | null {
    const current = this.#store.getWorktree(worktreeId)
    if (!current) return null
    const { clearError, ...fields } = patch
    const next: Worktree = { ...current, ...fields }
    if (clearError) delete next.error
    this.#store.putWorktree(next)
    this.events.emit({ type: 'worktree.updated', worktree: next })
    return next
  }

  #forget(worktree: Worktree): void {
    this.#store.removeWorktree(worktree.id)
    this.#startPoints.delete(worktree.id)
    this.events.emit({ type: 'worktree.removed', worktreeId: worktree.id, projectId: worktree.projectId })
  }

  async #chooseBranch(project: Project, taskName: string, requested?: string): Promise<string> {
    // In-flight creates own branch names git has not heard of yet, so records
    // are merged into the taken set.
    const recorded = this.#store.listWorktrees(project.id).map((worktree) => worktree.branch)
    const fromGit = await listBranchNames(this.#runner, project.path).catch(() => [] as string[])
    const existing = [...fromGit, ...recorded]

    if (requested === undefined) return allocateBranchName(taskName, existing)

    const branch = requested.trim()
    if (!branch || BRANCH_FORBIDDEN.test(branch) || hasControlCharacter(branch)) {
      throw new GitServiceError(ErrorCode.InvalidParams, `"${requested}" is not a valid branch name`)
    }
    if (branchCollides(branch, new Set(existing.map((name) => name.toLowerCase())))) {
      throw new GitServiceError(ErrorCode.Conflict, `branch "${branch}" already exists`)
    }
    return branch
  }

  async #buildCheckout(worktreeId: string, project: Project, signal: AbortSignal): Promise<Worktree> {
    const worktree = this.#requireWorktree(worktreeId)
    try {
      const start = await resolveStartPoint(this.#runner, {
        root: project.path,
        requested: worktree.startedFrom,
        signal
      })
      await mkdir(path.dirname(worktree.path), { recursive: true })
      // The resolved sha, never the name: git's own DWIM must not get a second
      // vote after we have already decided what the name meant.
      await this.#runner.run({
        args: ['worktree', 'add', '-b', worktree.branch, worktree.path, start.sha],
        cwd: project.path,
        signal,
        timeoutMs: this.#createTimeoutMs
      })
      if (start.track) await this.#trackUpstream(project, worktree.branch, start.track)
      this.#startPoints.set(worktreeId, start)
      // What it branched from is now a fact, not a request: the name could move
      // or disappear, the sha cannot.
      return this.#patch(worktreeId, { state: 'ready', startedFrom: start.sha, clearError: true }) ?? worktree
    } catch (error) {
      await this.#discardPartialCheckout(project, worktree)
      const cancelled = error instanceof GitCommandError && error.cancelled
      return (
        this.#patch(worktreeId, {
          state: 'failed',
          error: cancelled ? 'creation cancelled' : describeError(error)
        }) ?? worktree
      )
    } finally {
      this.#creating.delete(worktreeId)
      this.#settling.delete(worktreeId)
    }
  }

  /**
   * Points the new branch at the remote-tracking ref it came from, so push,
   * pull and ahead/behind all work without the user configuring anything. Done
   * explicitly rather than by handing `worktree add` the ref name, because the
   * ref name would reopen the interpretation we just closed. Failure here is
   * not worth discarding a good checkout over; the branch simply has no
   * upstream, which the user can set later.
   */
  async #trackUpstream(project: Project, branch: string, upstream: string): Promise<void> {
    await this.#runner
      .tryRun({
        args: ['branch', `--set-upstream-to=${upstream}`, branch],
        cwd: project.path,
        timeoutMs: 60_000
      })
      .catch(() => undefined)
  }

  /** Best effort: a failed create must not leave a half-checkout or a stray branch. */
  async #discardPartialCheckout(project: Project, worktree: Worktree): Promise<void> {
    const quiet = async (args: string[]): Promise<void> => {
      await this.#runner.tryRun({ args, cwd: project.path, timeoutMs: 60_000 }).catch(() => undefined)
    }
    await quiet(['worktree', 'remove', '--force', worktree.path])
    await quiet(['worktree', 'prune'])
    // Only ever delete inside our own root; a user-chosen checkout path is theirs.
    if (isInside(this.#worktreesRoot, worktree.path)) {
      await rm(worktree.path, { recursive: true, force: true }).catch(() => undefined)
    }
    await quiet(['branch', '-D', worktree.branch])
  }

  async #detachCheckout(project: Project, worktree: Worktree, force: boolean): Promise<void> {
    const inventory = await readWorktreeInventory(this.#runner, project.path).catch(() => [])
    const registered = inventory.some((entry) => samePath(entry.path, worktree.path))
    if (!registered) {
      // Already gone as far as git is concerned; drop any stale bookkeeping.
      await this.#runner.tryRun({ args: ['worktree', 'prune'], cwd: project.path }).catch(() => undefined)
      return
    }

    const args = ['worktree', 'remove']
    if (force) args.push('--force')
    args.push(worktree.path)
    const result = await this.#runner.tryRun({ args, cwd: project.path, timeoutMs: 120_000 })
    if (result.exitCode === 0) return

    // Fallback for the one case `git worktree remove` refuses outright on our
    // 2.25 floor: the checkout directory is gone but its metadata is not.
    if (/is not a working tree|does not exist|No such file/i.test(result.stderr)) {
      await this.#runner.tryRun({ args: ['worktree', 'prune'], cwd: project.path }).catch(() => undefined)
      return
    }
    if (!force && /contains modified or untracked files|is dirty/i.test(result.stderr)) {
      throw new GitServiceError(
        ErrorCode.Conflict,
        `worktree "${worktree.name}" has uncommitted changes; remove with force to discard them`
      )
    }
    throw new GitCommandError({ args, cwd: project.path, exitCode: result.exitCode, stderr: result.stderr })
  }

  async #judgeBranchDeletion(project: Project, branch: string, force: boolean): Promise<BranchVerdict> {
    if (force) return 'force'
    const target = project.baseRef
    const merged = await this.#runner.tryRun({
      args: ['merge-base', '--is-ancestor', branch, target],
      cwd: project.path,
      readOnly: true
    })
    if (merged.exitCode === 0) return 'safe'
    if (merged.exitCode === 1) {
      throw new GitServiceError(
        ErrorCode.Conflict,
        `branch "${branch}" has commits that are not in ${target}; remove with force to delete it anyway`
      )
    }
    // Base ref unreadable (no remote, unborn branch). Let `git branch -d` judge.
    return 'safe'
  }

  async #deleteBranch(project: Project, branch: string, force: boolean): Promise<void> {
    const args = ['branch', force ? '-D' : '-d', branch]
    const result = await this.#runner.tryRun({ args, cwd: project.path, timeoutMs: 60_000 })
    if (result.exitCode === 0) return
    if (/not found/i.test(result.stderr)) return
    if (/not fully merged/i.test(result.stderr)) {
      throw new GitServiceError(
        ErrorCode.Conflict,
        `branch "${branch}" has unmerged commits; remove with force to delete it anyway`
      )
    }
    throw new GitCommandError({ args, cwd: project.path, exitCode: result.exitCode, stderr: result.stderr })
  }

  /** Drops ready records whose checkout git no longer lists. */
  async #reconcile(projectId?: string): Promise<void> {
    if (this.#disposed) return
    const projects = projectId ? [this.#store.getProject(projectId)].filter(isProject) : this.#store.listProjects()

    for (const project of projects) {
      const inventory = await readWorktreeInventory(this.#runner, project.path).catch(() => null)
      if (!inventory) continue // repo temporarily unreadable: keep what we have
      const live = new Set(inventory.map((entry) => pathKey(entry.path)))
      for (const worktree of this.#store.listWorktrees(project.id)) {
        if (worktree.state !== 'ready') continue
        if (live.has(pathKey(worktree.path))) continue
        this.#forget(worktree)
      }
    }
  }
}

/** Checked outside the ref regex so the regex stays free of control literals. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function isProject(project: Project | undefined): project is Project {
  return project !== undefined
}
