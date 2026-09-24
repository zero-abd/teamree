// The stateful half of the git layer: which repos are tracked, which worktrees
// exist, and what is happening to them. Create returns 'creating' and finishes on
// a background task; records are a cache, so every list/get reconciles against git.

import { randomUUID } from 'node:crypto'
import { mkdir, rm, rmdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  CloneProgress,
  Project,
  Worktree,
  WorktreeChanges,
  WorktreeCommit,
  WorktreeCommitPatch,
  WorktreeCompare,
  WorktreeDiff,
  WorktreeDiscard,
  WorktreeFileMatches,
  WorktreeFiles,
  WorktreeHunkStage,
  WorktreeUnstage,
  WorktreeLog,
  WorktreeMergePreview,
  WorktreePush,
  WorktreeStatus
} from '../../shared/entities'
import type { ParamsOf } from '../../shared/methods'
import { checkTransport } from '../../shared/origin'
import { ErrorCode } from '../../shared/protocol'
import { cloneDestination, cloneFailureCode, cloneFailureLine, runClone } from './clone'
import { describeError, GitCommandError, GitServiceError, isTransient } from './errors'
import { createGitRunner, type GitRunner } from './gitProcess'
import { createVersionProbe } from './gitVersion'
import { isInside, pathKey, samePath } from './pathIdentity'
import { createMemoryRecordStore, type GitRecordStore } from './recordStore'
import { detectBaseRef, initializeRepository, inspectRepository, listBranchNames } from './repository'
import { listStartPoints, resolveStartPoint, type ResolvedStartPoint, type StartPointList } from './startPoint'
import { readWorktreeInventory } from './worktreeInventory'
import { allocateBranchName, allocateCheckoutPath, branchCollides } from './worktreeNaming'
import { readMergePreview } from './mergePreview'
import { readWorktreeLog } from './worktreeLog'
import { readCommit } from './worktreeShowCommit'
import { readCompare } from './worktreeCompare'
import { commitWorktree } from './worktreeCommit'
import { applyHunk, unstagePath } from './worktreeHunk'
import { discardHunk, discardPath, type Trash } from './worktreeDiscard'
import { pushWorktree } from './worktreePush'
import { readWorktreeChanges, readWorktreeDiff } from './worktreeChanges'
import { findWorktreeFiles, readWorktreeFiles } from './worktreeFiles'
import { readIgnoredEntries, readWorktreeStatus, type IgnoredEntries } from './worktreeStatus'
import { normalizePreparedPaths, prepareWorktree, type PreparedPaths } from './worktreePreparation'
import { normalizeSetupCommand } from './worktreeSetup'

export type GitEvent =
  | { type: 'project.added'; project: Project }
  | { type: 'project.updated'; project: Project }
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
  /**
   * Runs a project's setup command in the just-built worktree and answers with the
   * pane id. Handed in because opening a pane needs the terminal service.
   */
  startSetup?: (input: { worktree: Worktree; project: Project; command: string }) => string | undefined
  /** `shell.trashItem`. Absent, discarding an untracked file is refused. */
  trash?: Trash
}

/** What the runtime persists between launches. */
export type GitSnapshot = { projects: Project[]; worktrees: Worktree[] }

/**
 * What `--delete-branch` was judged to deserve, before anything was destroyed.
 * 'merged' is a proof the commits are in the base ref; 'unjudged' is the absence of one.
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
  readonly #startSetup: GitServiceOptions['startSetup']
  readonly #trash: Trash | undefined
  readonly #ensureVersion: (cwd: string) => Promise<unknown>

  readonly #store: GitRecordStore
  readonly #startPointLimit: number | undefined
  readonly #creating = new Map<string, AbortController>()
  readonly #settling = new Map<string, Promise<Worktree>>()
  // One chain per project, so two creates never both read a store neither has
  // written to yet. See `createWorktree`.
  readonly #reservations = new Map<string, Promise<void>>()
  // How each start point was interpreted; session-scoped, `startedFrom` holds the sha.
  readonly #startPoints = new Map<string, ResolvedStartPoint>()
  // Running clones by URL, the key the window already holds when it asks.
  readonly #clones = new Map<string, { progress: CloneProgress; controller: AbortController }>()
  #disposed = false

  constructor(options: GitServiceOptions = {}) {
    this.#runner = options.runner ?? createGitRunner(options.gitBinary)
    this.#store = options.store ?? createMemoryRecordStore()
    this.#worktreesRoot = options.worktreesRoot ?? path.join(os.homedir(), '.teamree', 'worktrees')
    this.#createTimeoutMs = options.createTimeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS
    this.#startPointLimit = options.startPointLimit
    this.#now = options.now ?? Date.now
    this.#createId = options.createId ?? randomUUID
    this.#startSetup = options.startSetup
    this.#trash = options.trash
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
    if (params.init) await initializeRepository(this.#runner, params.path)
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

  /** Clones, then adds the checkout. Failures are one line each; see `cloneFailureLine`. */
  async cloneProject(params: ParamsOf<'project.clone'>): Promise<Project> {
    const url = params.url.trim()
    const transport = checkTransport(url)
    if (!transport.ok) throw new GitServiceError(ErrorCode.InvalidParams, transport.reason)
    const into = cloneDestination(url, params.path)
    if (this.#clones.has(url)) throw new GitServiceError(ErrorCode.Conflict, 'Already cloning')

    const controller = new AbortController()
    const progress: CloneProgress = { url, path: into, line: '', startedAt: this.#now(), cancelling: false }
    this.#clones.set(url, { progress, controller })
    try {
      await this.#ensureVersion(process.cwd())
      const existed = await stat(into).then(
        () => true,
        () => false
      )
      const result = await runClone(this.#runner, {
        origin: url,
        into,
        cwd: os.homedir(),
        signal: controller.signal,
        onProgress: (line) => {
          progress.line = line
        }
      })
      if (!result.ok) {
        // git cleans up after itself on SIGTERM, but not after the SIGKILL that follows a stuck one.
        if (!existed && (result.kind === 'cancelled' || result.kind === 'timeout')) {
          await rm(into, { recursive: true, force: true }).catch(() => undefined)
        }
        throw new GitServiceError(cloneFailureCode(result.kind), cloneFailureLine(result.kind, result.stderr))
      }
    } finally {
      this.#clones.delete(url)
    }
    return this.addProject({ path: into, ...(params.name ? { name: params.name } : {}) })
  }

  cloneProgress(params: ParamsOf<'project.cloneProgress'>): CloneProgress | null {
    const running = this.#clones.get(params.url.trim())
    return running ? { ...running.progress, cancelling: running.controller.signal.aborted } : null
  }

  cancelClone(params: ParamsOf<'project.cancelClone'>): { cancelled: boolean } {
    const running = this.#clones.get(params.url.trim())
    if (!running) return { cancelled: false }
    running.controller.abort()
    return { cancelled: true }
  }

  /** Untracks the repo and forgets its worktrees. Nothing on disk is touched. */
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

  /**
   * Sets what a new worktree carries over from the primary checkout and the command
   * it runs once it has. Paths are only shape-checked; `prepareWorktree` asks the repo.
   */
  async setProjectPaths(params: ParamsOf<'project.setPaths'>): Promise<Project> {
    const project = this.#requireProject(params.projectId)
    const next: Project = { ...project }
    for (const field of ['linkedPaths', 'copiedPaths'] as const) {
      const given = params[field]
      if (given === undefined) continue
      const paths = normalizePreparedPaths(given)
      // Absent rather than empty: `[]` and "never configured" are the same instruction.
      if (paths.length === 0) delete next[field]
      else next[field] = paths
    }
    if (params.setupCommand !== undefined) {
      // Absent rather than empty, for the reason the lists are.
      const command = normalizeSetupCommand(params.setupCommand)
      if (command === undefined) delete next.setupCommand
      else next.setupCommand = command
    }
    this.#store.putProject(next)
    this.events.emit({ type: 'project.updated', project: next })
    return next
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

  /** Renames the record only: branch, path and task are left alone, in any state. */
  async renameWorktree(params: ParamsOf<'worktree.rename'>): Promise<Worktree> {
    const current = this.#requireWorktree(params.worktreeId)
    const name = params.name.trim()
    if (!name) throw new GitServiceError(ErrorCode.InvalidParams, 'worktree name must not be blank')
    if (name === current.name) return current
    return this.#patch(current.id, { name }) ?? current
  }

  /**
   * Returns as soon as the record exists, in state 'creating'; `whenSettled` or an
   * `events` subscription tells you how it ended.
   */
  async createWorktree(params: ParamsOf<'worktree.create'>): Promise<Worktree> {
    const project = this.#requireProject(params.projectId)
    const name = params.name.trim()
    if (!name) throw new GitServiceError(ErrorCode.InvalidParams, 'worktree name must not be blank')

    // Serialised per project: choosing branch and path reads the store, and two
    // creates overlapping in that gap agree on one slug and two records name one
    // checkout path — the losing add then cleans up over the winner's checkout.
    return this.#reserve(project.id, () => this.#openWorktreeRecord(project, name, params))
  }

  /** Runs `reserve` after every earlier reservation for this project has finished. */
  #reserve(projectId: string, reserve: () => Promise<Worktree>): Promise<Worktree> {
    const previous = this.#reservations.get(projectId) ?? Promise.resolve()
    const reserved = previous.then(reserve, reserve)
    // The tail swallows the outcome; an unhandled rejection here would take the process.
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

    const told = params.task?.trim()
    const worktree: Worktree = {
      id: this.#createId(),
      projectId: project.id,
      name,
      branch,
      path: checkoutPath,
      startedFrom: params.startedFrom?.trim() || project.baseRef,
      state: 'creating',
      createdAt: this.#now(),
      ...(told ? { task: told } : {})
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
      // The repo was untracked underneath us; nothing here deletes files, so say where they went.
      this.#forget(worktree)
      const survived = await this.#surviving(worktree)
      return { removed: true, ...survived }
    }

    // Judged before anything is destroyed: refusing after the checkout is gone is worse.
    let branchVerdict: BranchVerdict = 'skip'
    if (params.deleteBranch) branchVerdict = await this.#judgeBranchDeletion(project, worktree.branch, force)

    const previousState = worktree.state
    // Somebody else dropped the record while this was starting; nothing was destroyed.
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
    // 'merged' is a proof from `merge-base --is-ancestor`. `git branch -d` asks a
    // different question (merged into HEAD or upstream) and says "no" for a branch
    // plainly in the base, so `-d` only judges the case with no proof to have.
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
    // Checked here too: a vanished cwd fails the spawn with ENOENT, which the
    // runner can only report as "git executable not found".
    if (!(await isDirectory(worktree.path))) {
      return {
        worktreeId: worktree.id,
        branch: worktree.branch,
        missing: true,
        ahead: 0,
        behind: 0,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicted: 0,
        readAt: this.#now()
      }
    }
    const project = this.#store.getProject(worktree.projectId)
    return readWorktreeStatus(this.#runner, {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      fallbackBranch: worktree.branch,
      baseRef: project?.baseRef,
      prepared: this.#preparedPaths(worktree.projectId),
      now: this.#now
    })
  }

  /** What this project puts in every worktree. Read fresh: the lists are editable. */
  #preparedPaths(projectId: string): PreparedPaths {
    const project = this.#store.getProject(projectId)
    return {
      ...(project?.linkedPaths === undefined ? {} : { linkedPaths: project.linkedPaths }),
      ...(project?.copiedPaths === undefined ? {} : { copiedPaths: project.copiedPaths })
    }
  }

  /** Every changed path in a worktree. */
  async worktreeChanges(params: ParamsOf<'worktree.changes'>): Promise<WorktreeChanges> {
    const worktree = this.#requireReadyWorktree(params.worktreeId, 'changes')
    return readWorktreeChanges(this.#runner, {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      ...(params.path === undefined ? {} : { path: params.path }),
      ...(params.limit === undefined ? {} : { limit: params.limit }),
      prepared: this.#preparedPaths(worktree.projectId),
      now: this.#now
    })
  }

  /** One directory of a worktree — names and kinds, never contents. */
  async worktreeFiles(params: ParamsOf<'worktree.files'>): Promise<WorktreeFiles> {
    const worktree = this.#requireReadyWorktree(params.worktreeId, 'a file listing')
    return readWorktreeFiles(this.#runner, {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      ...(params.path === undefined ? {} : { path: params.path }),
      ...(params.limit === undefined ? {} : { limit: params.limit }),
      now: this.#now
    })
  }

  /** The paths in a worktree whose path contains a query. */
  async worktreeFindFiles(params: ParamsOf<'worktree.findFiles'>): Promise<WorktreeFileMatches> {
    const worktree = this.#requireReadyWorktree(params.worktreeId, 'a file search')
    return findWorktreeFiles(this.#runner, {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      query: params.query,
      ...(params.limit === undefined ? {} : { limit: params.limit }),
      ...(params.fuzzy === undefined ? {} : { fuzzy: params.fuzzy }),
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
      prepared: this.#preparedPaths(worktree.projectId),
      now: this.#now
    })
  }

  /** Commits in a worktree. */
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
   * Puts one hunk of the working-tree patch into the index. Never touches the
   * working tree; see `worktreeHunk.ts`.
   */
  async worktreeStageHunk(params: ParamsOf<'worktree.stageHunk'>): Promise<WorktreeHunkStage> {
    return this.#applyHunk(params, true)
  }

  /** The same in reverse: takes one hunk of the staged patch back out. */
  async worktreeUnstageHunk(params: ParamsOf<'worktree.unstageHunk'>): Promise<WorktreeHunkStage> {
    return this.#applyHunk(params, false)
  }

  /** Takes a whole path out of the index; the working tree is never written. */
  async worktreeUnstagePath(params: ParamsOf<'worktree.unstagePath'>): Promise<WorktreeUnstage> {
    const worktree = this.#requireReadyWorktree(params.worktreeId, 'unstaging')
    return unstagePath(this.#runner, {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      path: params.path,
      now: this.#now
    })
  }

  async #applyHunk(params: ParamsOf<'worktree.stageHunk'>, staged: boolean): Promise<WorktreeHunkStage> {
    const worktree = this.#requireReadyWorktree(params.worktreeId, staged ? 'staging' : 'unstaging')
    return applyHunk(this.#runner, {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      path: params.path,
      hunk: params.hunk,
      staged,
      now: this.#now
    })
  }

  /** Throws away a path's unstaged change; see `worktreeDiscard.ts`. Never writes the index. */
  async worktreeDiscardPath(params: ParamsOf<'worktree.discardPath'>): Promise<WorktreeDiscard> {
    const worktree = this.#requireReadyWorktree(params.worktreeId, 'discarding')
    return discardPath(this.#runner, {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      path: params.path,
      ...(this.#trash === undefined ? {} : { trash: this.#trash }),
      now: this.#now
    })
  }

  /** Reverses one unstaged hunk out of the file on disk. Never writes the index. */
  async worktreeDiscardHunk(params: ParamsOf<'worktree.discardHunk'>): Promise<WorktreeDiscard> {
    const worktree = this.#requireReadyWorktree(params.worktreeId, 'discarding')
    return discardHunk(this.#runner, {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      path: params.path,
      hunk: params.hunk,
      now: this.#now
    })
  }

  /**
   * What this worktree has committed that its base has not. Read from the
   * worktree, so the branch resolves against the HEAD the user is looking at.
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

  /** One commit's patch, read from the worktree, which shares the repository's objects. */
  async worktreeShowCommit(params: ParamsOf<'worktree.showCommit'>): Promise<WorktreeCommitPatch> {
    const worktree = this.#requireReadyWorktree(params.worktreeId, 'a commit')
    return readCommit(this.#runner, {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      sha: params.sha,
      ...(params.contextLines === undefined ? {} : { contextLines: params.contextLines }),
      ...(params.maxBytes === undefined ? {} : { maxBytes: params.maxBytes }),
      now: this.#now
    })
  }

  /** Two worktrees of one project, each against the commit both started from. */
  async worktreeCompare(params: ParamsOf<'worktree.compare'>): Promise<WorktreeCompare> {
    const left = this.#requireReadyWorktree(params.worktreeId, 'a compare')
    const right = this.#requireReadyWorktree(params.otherId, 'a compare')
    if (left.projectId !== right.projectId) {
      throw new GitServiceError(ErrorCode.InvalidParams, 'only worktrees of one project can be compared')
    }
    return readCompare(this.#runner, {
      left: { worktreeId: left.id, worktreePath: left.path },
      right: { worktreeId: right.id, worktreePath: right.path },
      ...(params.contextLines === undefined ? {} : { contextLines: params.contextLines }),
      ...(params.maxBytes === undefined ? {} : { maxBytes: params.maxBytes }),
      prepared: this.#preparedPaths(left.projectId),
      now: this.#now
    })
  }

  /** Sends a worktree's branch to its remote. */
  async worktreePush(params: ParamsOf<'worktree.push'>): Promise<WorktreePush> {
    const worktree = this.#requireReadyWorktree(params.worktreeId, 'pushing')
    // The base ref belongs to the project. A worktree whose project is gone still
    // pushes; only the review link cannot be named.
    const project = this.#store.getProject(worktree.projectId)
    return pushWorktree(this.#runner, {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      branch: worktree.branch,
      ...(project === undefined ? {} : { baseRef: project.baseRef }),
      ...(params.remote === undefined ? {} : { remote: params.remote }),
      now: this.#now
    })
  }

  /**
   * Whether this worktree would merge into its project's base ref. Run from the
   * primary checkout: the merge is hypothetical and belongs to the repository.
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

  /** A worktree that can be read from; anything not yet `ready` has no checkout on disk. */
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
   * What the create dialog can offer as a starting point, capped; the result says
   * when it was capped. Not in the frozen contract, so reached on the service. See handlers.ts.
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

  /** How a worktree's start point was read. Present only for worktrees this process created. */
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

  /** Restores records saved before a restart. */
  hydrate(snapshot: GitSnapshot): void {
    for (const project of snapshot.projects) this.#store.putProject(project)
    for (const worktree of snapshot.worktrees) this.#store.putWorktree(worktree)
    this.reviveRestoredRecords()
  }

  /** Call once at startup: whatever was mid-flight then has no owner now. */
  reviveRestoredRecords(): void {
    for (const worktree of this.#store.listWorktrees()) {
      if (worktree.state === 'creating') {
        this.#store.putWorktree({ ...worktree, state: 'failed', error: 'interrupted by a restart', retryable: true })
      } else if (worktree.state === 'removing') {
        this.#store.putWorktree({ ...worktree, state: 'ready' })
      }
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    for (const { controller } of this.#clones.values()) controller.abort()
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

  #patch(
    worktreeId: string,
    patch: Partial<Worktree> & { clearError?: boolean; clearMissing?: boolean }
  ): Worktree | null {
    const current = this.#store.getWorktree(worktreeId)
    if (!current) return null
    const { clearError, clearMissing, ...fields } = patch
    const next: Worktree = { ...current, ...fields }
    if (clearError) {
      delete next.error
      delete next.retryable
    }
    if (clearMissing) delete next.missing
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
    // In-flight creates own branch names git has not heard of yet.
    const recorded = this.#store.listWorktrees(project.id).map((worktree) => worktree.branch)
    // Deliberately not caught: an empty list says "free" about every name there is.
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
    // Set only once this create could have made the branch, so cleanup never
    // deletes one it did not create.
    let ourBranch: { branch: string; sha: string } | null = null
    // Same for the path: false until `worktree add` was asked for, since the path
    // may already be somebody else's checkout.
    let ourCheckout = false
    try {
      const start = await resolveStartPoint(this.#runner, {
        root: project.path,
        requested: worktree.startedFrom,
        signal
      })
      // Asked again: the #chooseBranch listing is as old as the start point took
      // to resolve, and a pane or a CLI can claim a name inside that.
      if (await this.#branchTip(project, worktree.branch)) {
        throw new GitServiceError(ErrorCode.Conflict, `branch "${worktree.branch}" already exists`)
      }
      ourBranch = { branch: worktree.branch, sha: start.sha }
      await mkdir(path.dirname(worktree.path), { recursive: true })
      ourCheckout = true
      // The resolved sha, never the name: git's DWIM must not get a second vote.
      // `--no-track`: a branch cut from origin/main that inherits it as upstream
      // reports a commit still to push after the push that sent it. Explicit
      // because `branch.autoSetupMerge=always` sets tracking from a local branch too.
      await this.#runner.run({
        args: ['worktree', 'add', '--no-track', '-b', worktree.branch, worktree.path, start.sha],
        cwd: project.path,
        signal,
        timeoutMs: this.#createTimeoutMs
      })
      // Before 'ready', deliberately: a pane opens on the transition, and `npm test`
      // in a checkout still being linked fails for a reason that stops being true.
      // Read from the store: the lists may have changed during a long add.
      const settings = this.#store.getProject(project.id) ?? project
      await prepareWorktree(this.#runner, {
        repoPath: project.path,
        worktreePath: worktree.path,
        ...(settings.linkedPaths === undefined ? {} : { linkedPaths: settings.linkedPaths }),
        ...(settings.copiedPaths === undefined ? {} : { copiedPaths: settings.copiedPaths }),
        signal
      })
      this.#startPoints.set(worktreeId, start)
      // In the same breath as the flip to 'ready': one write, one event, nothing
      // in between for a client to read a half-answer out of.
      const setupTerminalId = this.#runSetup(worktree, settings)
      // What it branched from is now a fact: the name could move, the sha cannot.
      return (
        this.#patch(worktreeId, {
          state: 'ready',
          startedFrom: start.sha,
          clearError: true,
          ...(setupTerminalId === undefined ? {} : { setupTerminalId })
        }) ?? worktree
      )
    } catch (error) {
      await this.#discardPartialCheckout(project, worktree, ourBranch, ourCheckout)
      const cancelled = error instanceof GitCommandError && error.cancelled
      return (
        this.#patch(worktreeId, {
          state: 'failed',
          error: cancelled ? 'creation cancelled' : describeError(error),
          ...(isTransient(error) ? { retryable: true } : {})
        }) ?? worktree
      )
    } finally {
      this.#creating.delete(worktreeId)
      this.#settling.delete(worktreeId)
    }
  }

  /**
   * Starts the project's setup command in the finished checkout, if any. Never a
   * reason to fail a create: throwing here would discard a correct checkout.
   */
  #runSetup(worktree: Worktree, project: Project): string | undefined {
    const command = project.setupCommand
    if (command === undefined || this.#startSetup === undefined) return undefined
    try {
      return this.#startSetup({ worktree, project, command })
    } catch (error) {
      console.error(`[git] could not run the setup command for worktree ${worktree.id}`, error)
      return undefined
    }
  }

  /**
   * Best effort: a failed create must not leave a half-checkout or a stray branch.
   * `ourBranch` is the only ref this may delete; any other name holds someone else's work.
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
    // Gated like the branch below: run unconditionally, this `rm -rf`ed a path
    // that a second record held as a ready checkout with an agent working in it.
    if (ourCheckout && !this.#pathHeldByAnotherRecord(worktree)) {
      await quiet(['worktree', 'remove', '--force', worktree.path])
      await quiet(['worktree', 'prune'])
      // Only ever delete inside our own root; a user-chosen checkout path is theirs.
      if (isInside(this.#worktreesRoot, worktree.path)) {
        await rm(worktree.path, { recursive: true, force: true }).catch(() => undefined)
        await this.#dropEmptyProjectDir(worktree.path)
      }
    }
    if (!ourBranch) return
    // The add creates the branch at the resolved start point; a ref anywhere
    // else is somebody else's, and a failed read is not a "mine".
    const tip = await this.#branchTip(project, ourBranch.branch).catch(() => null)
    if (tip === ourBranch.sha) await quiet(['branch', '-D', ourBranch.branch])
  }

  /**
   * Takes away `<worktreesRoot>/<project>` once the last checkout in it has gone.
   * Only straight under the root, and only by a plain `rmdir`, so anything in it makes that fail.
   */
  async #dropEmptyProjectDir(checkoutPath: string): Promise<void> {
    const projectDir = path.dirname(checkoutPath)
    if (!samePath(path.dirname(projectDir), this.#worktreesRoot)) return
    await rmdir(projectDir).catch(() => undefined)
  }

  /** Whether some other record names this checkout path; if so, the directory is that record's. */
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

  /** Takes the checkout away from git and reports whether the directory survived. */
  async #detachCheckout(project: Project, worktree: Worktree, force: boolean): Promise<{ checkoutLeftAt?: string }> {
    // Deliberately not caught: reading the failure as "git has never heard of this
    // checkout" let a removal report success and leave every file on disk.
    const inventory = await readWorktreeInventory(this.#runner, project.path)
    const registered = inventory.some((entry) => samePath(entry.path, worktree.path))
    if (!registered) {
      // Already gone as far as git is concerned; drop any stale bookkeeping.
      await this.#runner.tryRun({ args: ['worktree', 'prune'], cwd: project.path }).catch(() => undefined)
      return this.#surviving(worktree)
    }

    if (!force) await this.#refuseIfIgnoredFilesWouldGo(worktree)

    // `status.showUntrackedFiles` pinned: an unforced removal relies on `git worktree
    // remove` refusing a dirty checkout, which obeys that setting, and people set it
    // to `no` in ~/.gitconfig — the difference between a refusal and a silent delete.
    const args = ['-c', 'status.showUntrackedFiles=normal', 'worktree', 'remove']
    if (force) args.push('--force')
    args.push(worktree.path)
    const result = await this.#runner.tryRun({ args, cwd: project.path, timeoutMs: 120_000 })
    if (result.exitCode === 0) {
      await this.#dropEmptyProjectDir(worktree.path)
      return this.#surviving(worktree)
    }

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
   * Stops a removal that would take ignored files with it: dirty to git means
   * modified-or-untracked, and ignored files are the ones nothing else has a copy of.
   */
  async #refuseIfIgnoredFilesWouldGo(worktree: Worktree): Promise<void> {
    if (!(await isDirectory(worktree.path))) return // nothing on disk to lose

    let ignored: IgnoredEntries
    try {
      ignored = await readIgnoredEntries(this.#runner, { worktreePath: worktree.path })
    } catch (error) {
      // A checkout git will not read is one `worktree remove` will not delete
      // either; any other failure is an open question, and that is not a yes.
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
    // Base ref unreadable (no remote, unborn branch): nothing proved, `-d` judges.
    return 'unjudged'
  }

  async #deleteBranch(project: Project, branch: string, force: boolean): Promise<void> {
    const args = ['branch', force ? '-D' : '-d', branch]
    const result = await this.#runner.tryRun({ args, cwd: project.path, timeoutMs: 60_000 })
    if (result.exitCode === 0) return
    if (/not found/i.test(result.stderr)) return
    if (/not fully merged/i.test(result.stderr)) {
      // Only reachable from 'unjudged', by which time the checkout is gone;
      // "remove with force" would point at a worktree that no longer exists.
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
        if (!live.has(pathKey(worktree.path))) {
          this.#forget(worktree)
          continue
        }
        // Still in git's inventory, but an `rm -rf` leaves the metadata behind.
        // Patch only when the answer changes, so a quiet list says nothing.
        const missing = !(await isDirectory(worktree.path))
        if (missing && worktree.missing !== true) this.#patch(worktree.id, { missing: true })
        else if (!missing && worktree.missing === true) this.#patch(worktree.id, { clearMissing: true })
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
