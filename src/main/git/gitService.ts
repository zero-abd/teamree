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
import { mkdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  Project,
  Worktree,
  WorktreeChanges,
  WorktreeCommit,
  WorktreeDiff,
  WorktreeLog,
  WorktreeMergePreview,
  WorktreePush,
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
import { readWorktreeLog } from './worktreeLog'
import { commitWorktree } from './worktreeCommit'
import { pushWorktree } from './worktreePush'
import { readWorktreeChanges, readWorktreeDiff } from './worktreeChanges'
import { readIgnoredEntries, readWorktreeStatus, type IgnoredEntries } from './worktreeStatus'

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

/**
 * What `--delete-branch` was judged to deserve, before anything was destroyed.
 *
 * 'merged' and 'unjudged' both used to be 'safe', and they are not the same
 * thing: one is a proof that the commits are in the base ref, the other is the
 * absence of one. Telling them apart is what lets the proof be acted on.
 */
type BranchVerdict = 'skip' | 'merged' | 'unjudged' | 'force'

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
  // One chain per project, so two creates never both read a store neither has
  // written to yet. See `createWorktree`.
  readonly #reservations = new Map<string, Promise<void>>()
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

    // Serialised per project, and this is a data-loss fix rather than tidiness.
    // Choosing the branch and the path reads the store; the record that claims
    // them is written afterwards. Two creates overlapping in that gap both read
    // a store neither has written to, agree on the same slug, and end up with
    // two records naming one checkout path — after which whichever `worktree
    // add` loses cleans up over the winner's checkout, and an agent's afternoon
    // goes with it. Only the reservation is serialised: `#buildCheckout` still
    // runs concurrently, so the slow part (a fetch, then the add) is unaffected.
    return this.#reserve(project.id, () => this.#openWorktreeRecord(project, name, params))
  }

  /** Runs `reserve` after every earlier reservation for this project has finished. */
  #reserve(projectId: string, reserve: () => Promise<Worktree>): Promise<Worktree> {
    const previous = this.#reservations.get(projectId) ?? Promise.resolve()
    const reserved = previous.then(reserve, reserve)
    // The tail swallows the outcome: one caller's failure is not the next
    // caller's, and an unhandled rejection here would take the process with it.
    const tail = reserved.then(
      () => undefined,
      () => undefined
    )
    this.#reservations.set(projectId, tail)
    void tail.then(() => {
      if (this.#reservations.get(projectId) === tail) this.#reservations.delete(projectId)
    })
    return reserved
  }

  /** Claims a branch name and a checkout path, and starts building into them. */
  async #openWorktreeRecord(project: Project, name: string, params: ParamsOf<'worktree.create'>): Promise<Worktree> {
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

  async removeWorktree(params: ParamsOf<'worktree.remove'>): Promise<{ removed: true; checkoutLeftAt?: string }> {
    const initial = this.#requireWorktree(params.worktreeId)
    if (initial.state === 'creating') await this.cancelWorktreeCreate(initial.id)

    const worktree = this.#requireWorktree(params.worktreeId)
    const project = this.#store.getProject(worktree.projectId)
    const force = params.force === true

    if (!project) {
      // The repo was untracked underneath us; the row is all that is left. The
      // files are not: nothing here deletes them, so say where they went.
      this.#forget(worktree)
      const survived = await this.#surviving(worktree)
      return { removed: true, ...survived }
    }

    // Judged before anything is destroyed: refusing after the checkout is gone
    // would leave the user worse off than refusing outright.
    let branchVerdict: BranchVerdict = 'skip'
    if (params.deleteBranch) branchVerdict = await this.#judgeBranchDeletion(project, worktree.branch, force)

    const previousState = worktree.state
    // Somebody else dropped the record while this was starting. Nothing was
    // destroyed, so the files are wherever they were.
    if (!this.#patch(worktree.id, { state: 'removing' })) {
      return { removed: true, ...(await this.#surviving(worktree)) }
    }

    let detached: { checkoutLeftAt?: string }
    try {
      detached = await this.#detachCheckout(project, worktree, force)
    } catch (error) {
      this.#patch(worktree.id, { state: previousState })
      throw error
    }

    this.#forget(worktree)
    // 'merged' is a proof, not a guess: `merge-base --is-ancestor` has already
    // shown every commit on this branch is in the base ref, which is the whole
    // reason the verdict is taken before anything is destroyed. `git branch -d`
    // asks a different question — merged into HEAD or upstream — and answers it
    // "no" for a branch that is plainly in the base, after the checkout is gone.
    // So the proof is acted on, and `-d` is left to judge only the case where
    // there was no proof to have.
    if (branchVerdict !== 'skip') {
      await this.#deleteBranch(project, worktree.branch, branchVerdict !== 'unjudged')
    }
    return { removed: true, ...detached }
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
   * What this worktree has committed that its base has not.
   *
   * Read from the worktree rather than the primary checkout, so the branch
   * resolves against the HEAD the user is actually looking at.
   */
  async worktreeLog(params: ParamsOf<'worktree.log'>): Promise<WorktreeLog> {
    const worktree = this.#requireReadyWorktree(params.worktreeId, 'a log')
    const project = this.#store.getProject(worktree.projectId)
    return readWorktreeLog(this.#runner, {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      baseRef: project?.baseRef ?? 'HEAD',
      branch: worktree.branch,
      ...(params.limit === undefined ? {} : { limit: params.limit }),
      now: this.#now
    })
  }

  /**
   * Sends a worktree's branch to its remote. The only call in this service that
   * leaves the machine, and the only one that cannot be undone from here.
   */
  async worktreePush(params: ParamsOf<'worktree.push'>): Promise<WorktreePush> {
    const worktree = this.#requireReadyWorktree(params.worktreeId, 'pushing')
    return pushWorktree(this.#runner, {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      branch: worktree.branch,
      ...(params.remote === undefined ? {} : { remote: params.remote }),
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
    // Deliberately not caught into an empty list: a collision check with
    // nothing to check against says "that name is free" about every name there
    // is, and the caller cannot tell that answer from a real one.
    const fromGit = await listBranchNames(this.#runner, project.path)
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
    // Set only once this create is the one thing that could have made the
    // branch, so the cleanup below never deletes one it did not create.
    let ourBranch: { branch: string; sha: string } | null = null
    // The same rule applied to the checkout path. False until `worktree add`
    // has been asked for, because before that this create has put nothing at
    // that path — and the path may already be somebody else's checkout.
    let ourCheckout = false
    try {
      const start = await resolveStartPoint(this.#runner, {
        root: project.path,
        requested: worktree.startedFrom,
        signal
      })
      // Asked again here rather than trusted from #chooseBranch: that listing
      // is as old as the start point took to resolve — network time when the
      // ref needed fetching — and a pane or a CLI can claim a name inside it.
      if (await this.#branchTip(project, worktree.branch)) {
        throw new GitServiceError(ErrorCode.Conflict, `branch "${worktree.branch}" already exists`)
      }
      ourBranch = { branch: worktree.branch, sha: start.sha }
      await mkdir(path.dirname(worktree.path), { recursive: true })
      ourCheckout = true
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
      await this.#discardPartialCheckout(project, worktree, ourBranch, ourCheckout)
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

  /**
   * Best effort: a failed create must not leave a half-checkout or a stray
   * branch. `ourBranch` names the ref this create made, and is the only ref
   * this may delete — a name that was already taken, or that somebody else
   * claimed while the add was running, holds work this create knows nothing
   * about.
   */
  async #discardPartialCheckout(
    project: Project,
    worktree: Worktree,
    ourBranch: { branch: string; sha: string } | null,
    ourCheckout: boolean
  ): Promise<void> {
    const quiet = async (args: string[]): Promise<void> => {
      await this.#runner.tryRun({ args, cwd: project.path, timeoutMs: 60_000 }).catch(() => undefined)
    }
    // Gated the way the branch below is gated, and for the same reason. This
    // used to run unconditionally, which meant a create that failed before it
    // ever reached `worktree add` still ran `remove --force` and then `rm -rf`
    // over its recorded path — and when a second record held that same path,
    // that path was a ready checkout with an agent working in it.
    if (ourCheckout && !this.#pathHeldByAnotherRecord(worktree)) {
      await quiet(['worktree', 'remove', '--force', worktree.path])
      await quiet(['worktree', 'prune'])
      // Only ever delete inside our own root; a user-chosen checkout path is theirs.
      if (isInside(this.#worktreesRoot, worktree.path)) {
        await rm(worktree.path, { recursive: true, force: true }).catch(() => undefined)
      }
    }
    if (!ourBranch) return
    // The add is what creates the branch, and it creates it at the start point
    // already resolved. A ref sitting anywhere else is somebody else's, and a
    // read that fails leaves the question open rather than answering it "mine".
    const tip = await this.#branchTip(project, ourBranch.branch).catch(() => null)
    if (tip === ourBranch.sha) await quiet(['branch', '-D', ourBranch.branch])
  }

  /**
   * Whether some other record names this checkout path. If one does, the
   * directory is that record's, whatever this one believes — and a record is
   * the only thing that knows where a running agent's files are.
   */
  #pathHeldByAnotherRecord(worktree: Worktree): boolean {
    const key = pathKey(worktree.path)
    return this.#store.listWorktrees().some((other) => other.id !== worktree.id && pathKey(other.path) === key)
  }

  /** The commit a local branch points at, or null when there is no such branch. */
  async #branchTip(project: Project, branch: string): Promise<string | null> {
    const wanted = `refs/heads/${branch}`
    const { stdout } = await this.#runner.run({
      args: ['for-each-ref', '--format=%(refname) %(objectname)', wanted],
      cwd: project.path,
      readOnly: true,
      timeoutMs: 60_000
    })
    for (const line of stdout.split('\n')) {
      // The argument is read as a pattern, and `refs/heads/x` matches
      // `refs/heads/x/y` too; only the exact ref is this branch.
      const [name, sha] = line.trim().split(' ')
      if (name === wanted && sha) return sha
    }
    return null
  }

  /**
   * Takes the checkout away from git, and reports whether the directory itself
   * survived. Three of the paths below drop the record with every file still
   * on disk, and a caller told only "removed" has no way left to find them.
   */
  async #detachCheckout(project: Project, worktree: Worktree, force: boolean): Promise<{ checkoutLeftAt?: string }> {
    // Deliberately not caught: a repository git cannot be asked about is not a
    // repository with nothing in it. Reading the failure as "git has never
    // heard of this checkout" is what let a removal report success, forget
    // which project the row belonged to, and leave every file on disk.
    const inventory = await readWorktreeInventory(this.#runner, project.path)
    const registered = inventory.some((entry) => samePath(entry.path, worktree.path))
    if (!registered) {
      // Already gone as far as git is concerned; drop any stale bookkeeping.
      await this.#runner.tryRun({ args: ['worktree', 'prune'], cwd: project.path }).catch(() => undefined)
      return this.#surviving(worktree)
    }

    if (!force) await this.#refuseIfIgnoredFilesWouldGo(worktree)

    // `status.showUntrackedFiles` is pinned for the same reason it is pinned
    // wherever else this app asks git what has changed — but here it is the
    // difference between a refusal and a silent delete. An unforced removal
    // has no safety check of its own for modified or untracked files: it
    // relies entirely on `git worktree remove` refusing a dirty checkout, and
    // git decides dirty with its own `git status`, which obeys that setting.
    // People set it to `no` in ~/.gitconfig to make status usable on a large
    // repository, where it then covers every repository they own — and an
    // uncommitted file is exactly the kind nothing else has a copy of.
    const args = ['-c', 'status.showUntrackedFiles=normal', 'worktree', 'remove']
    if (force) args.push('--force')
    args.push(worktree.path)
    const result = await this.#runner.tryRun({ args, cwd: project.path, timeoutMs: 120_000 })
    if (result.exitCode === 0) return this.#surviving(worktree)

    // Fallback for the one case `git worktree remove` refuses outright on our
    // 2.25 floor: the checkout directory is gone but its metadata is not.
    if (isNotAWorkingTree(result.stderr)) {
      await this.#runner.tryRun({ args: ['worktree', 'prune'], cwd: project.path }).catch(() => undefined)
      return this.#surviving(worktree)
    }
    if (!force && /contains modified or untracked files|is dirty/i.test(result.stderr)) {
      throw new GitServiceError(
        ErrorCode.Conflict,
        `worktree "${worktree.name}" has uncommitted changes; remove with force to discard them`
      )
    }
    throw new GitCommandError({ args, cwd: project.path, exitCode: result.exitCode, stderr: result.stderr })
  }

  /** Where the checkout still is, when forgetting the record did not move it. */
  async #surviving(worktree: Worktree): Promise<{ checkoutLeftAt?: string }> {
    return (await isDirectory(worktree.path)) ? { checkoutLeftAt: worktree.path } : {}
  }

  /**
   * Stops a removal that would take ignored files with it.
   *
   * `git worktree remove` refuses a dirty checkout, and dirty to git means
   * modified-or-untracked — everything except the files an ignore rule covers.
   * Those are exactly the files nothing else has: no branch holds them, no
   * remote has a copy. This app cannot tell a rebuildable node_modules from
   * the only .env that ever existed, so it says what is there and leaves the
   * judgement to the person whose files they are.
   */
  async #refuseIfIgnoredFilesWouldGo(worktree: Worktree): Promise<void> {
    if (!(await isDirectory(worktree.path))) return // nothing on disk to lose

    let ignored: IgnoredEntries
    try {
      ignored = await readIgnoredEntries(this.#runner, { worktreePath: worktree.path })
    } catch (error) {
      // A checkout git will not read is one `worktree remove` will not delete
      // either — it refuses and the prune below takes the record instead,
      // leaving whatever is on disk exactly where it is. Any other failure is
      // a question left open, and an open question is not a yes.
      if (error instanceof GitCommandError && isNotAWorkingTree(error.stderr)) return
      throw error
    }
    if (ignored.count === 0) return

    const rest = ignored.count - ignored.names.length
    const named = rest > 0 ? `${ignored.names.join(', ')} and ${rest} more` : ignored.names.join(', ')
    const noun = ignored.count === 1 ? 'file or folder' : 'files and folders'
    throw new GitServiceError(
      ErrorCode.Conflict,
      `worktree "${worktree.name}" holds ${ignored.count} ignored ${noun} that git would delete ` +
        `without a word (${named}); remove with force to discard them`
    )
  }

  async #judgeBranchDeletion(project: Project, branch: string, force: boolean): Promise<BranchVerdict> {
    if (force) return 'force'
    const target = project.baseRef
    const merged = await this.#runner.tryRun({
      args: ['merge-base', '--is-ancestor', branch, target],
      cwd: project.path,
      readOnly: true
    })
    if (merged.exitCode === 0) return 'merged'
    if (merged.exitCode === 1) {
      throw new GitServiceError(
        ErrorCode.Conflict,
        `branch "${branch}" has commits that are not in ${target}; remove with force to delete it anyway`
      )
    }
    // Base ref unreadable (no remote, unborn branch). Nothing was proved here,
    // so `git branch -d` is left to judge on its own terms.
    return 'unjudged'
  }

  async #deleteBranch(project: Project, branch: string, force: boolean): Promise<void> {
    const args = ['branch', force ? '-D' : '-d', branch]
    const result = await this.#runner.tryRun({ args, cwd: project.path, timeoutMs: 60_000 })
    if (result.exitCode === 0) return
    if (/not found/i.test(result.stderr)) return
    if (/not fully merged/i.test(result.stderr)) {
      // Only reachable from the 'unjudged' verdict, and by then the checkout is
      // gone and the record with it. Telling the user to "remove with force"
      // would send them back to a worktree that no longer exists, so the
      // sentence says what actually happened and what is left to do.
      throw new GitServiceError(
        ErrorCode.Conflict,
        `the worktree was removed, but branch "${branch}" has commits that are not merged anywhere ` +
          `this app can see; delete it yourself with: git branch -D ${branch}`
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

/** Git's several ways of saying there is no checkout at that path. */
function isNotAWorkingTree(stderr: string): boolean {
  return /is not a working tree|does not exist|No such file|not a git repository/i.test(stderr)
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}

function isProject(project: Project | undefined): project is Project {
  return project !== undefined
}
