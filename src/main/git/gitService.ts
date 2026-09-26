// The stateful half of the git layer: which repos are tracked, which worktrees
// exist, and what is happening to them. Create returns 'creating' and finishes on
// a background task; records are a cache, so every list/get reconciles against git.

import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rm, rmdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  BranchList,
  CloneProgress,
  Project,
  RemovedWorktree,
  PullRequestList,
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
  WorktreeKeep,
  WorktreeLanding,
  WorktreeUnstage,
  WorktreeLog,
  WorktreeMerge,
  WorktreeMergePreview,
  WorktreePullRequest,
  WorktreePush,
  WorktreeStatus,
  WorktreeUpdate,
  WorktreeUpdateAbort
} from '../../shared/entities'
import type { ParamsOf, ResultOf } from '../../shared/methods'
import { checkTransport } from '../../shared/origin'
import { isValidBranchName } from '../../shared/branchName'
import { siblingRuns } from '../../shared/runCompare'
import { effectiveProjectSettings } from '../../shared/projectSettings'
import { readProjectFile, writeProjectFile, type ProjectFileRead } from '../teamwork/projectFile'
import { ErrorCode } from '../../shared/protocol'
import { MAX_CHILD_DEPTH, MAX_OPEN_CHILDREN } from '../../shared/tasks'
import { descendantsOf } from '../../shared/taskTree'
import { nestRefusal, type WorktreeNest } from '../../shared/nesting'
import { cloneDestination, cloneFailureCode, cloneFailureLine, runClone } from './clone'
import { describeError, GitCommandError, GitServiceError, isTransient } from './errors'
import { createGitRunner, type GitRunner } from './gitProcess'
import { createVersionProbe } from './gitVersion'
import { isInside, pathKey, samePath } from './pathIdentity'
import { createMemoryRecordStore, type GitRecordStore } from './recordStore'
import { assertRefShape, detectBaseRef, initializeRepository, inspectRepository, listBranchNames } from './repository'
import { listStartPoints, resolveStartPoint, type ResolvedStartPoint, type StartPointList } from './startPoint'
import { readWorktreeInventory } from './worktreeInventory'
import { branchForCheckout, listOpenableBranches, listPullRequests } from './openBranch'
import {
  allocateBranchName,
  allocateCheckoutPath,
  allocateChildBranchName,
  branchCollides,
  childCheckoutDirName
} from './worktreeNaming'
import { readMergePreview } from './mergePreview'
import { readWorktreeLog } from './worktreeLog'
import { readCommit } from './worktreeShowCommit'
import { readCompare } from './worktreeCompare'
import { commitWorktree } from './worktreeCommit'
import { applyHunk, unstagePath } from './worktreeHunk'
import { discardHunk, discardPath, type Trash } from './worktreeDiscard'
import {
  dropTrash,
  listTrash,
  pruneTrash,
  readTrash,
  removedWorktree,
  restoreTrash,
  snapshotWorktree,
  type TrashNote
} from './worktreeTrash'
import { pushWorktree } from './worktreePush'
import { abortWorktreeUpdate, updateWorktree } from './worktreeUpdate'
import { createGhProbe, createPullRequest, mergeIntoBase, readLanding, type GhProbe } from './worktreeLanding'
import { keptName } from './worktreeKeep'
import { readBranchChanges, readWorktreeChanges, readWorktreeDiff } from './worktreeChanges'
import { findWorktreeFiles, readWorktreeFiles } from './worktreeFiles'
import { readIgnoredEntries, readWorktreeStatus, type IgnoredEntries } from './worktreeStatus'
import { normalizePreparedPaths, prepareWorktree, type PreparedPaths } from './worktreePreparation'
import { normalizeSetupCommand } from './worktreeSetup'
import {
  checkReplay,
  containsTip,
  forkPoint,
  hasLanded,
  inheritedCommits,
  nestError,
  replay,
  type ReplayPlan
} from './worktreeNest'

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
  /** Gives a checkout just made the agent CLIs' trust its main checkout has; a failure never fails the create. */
  trustCheckout?: (input: { projectPath: string; worktreePath: string }) => Promise<unknown>
  /** `shell.trashItem`. Absent, discarding an untracked file is refused. */
  trash?: Trash
  /** Where `gh` is, asked lazily; absent, pull requests open on the host's page instead. */
  ghBinary?: () => string | null
  /** Whether an agent in this worktree is mid-turn; `worktree.nest` will not rebase under one. */
  agentWorking?: (worktreeId: string) => boolean
}

/** What the runtime persists between launches. */
export type GitSnapshot = { projects: Project[]; worktrees: Worktree[] }

/**
 * What `--delete-branch` was judged to deserve, before anything was destroyed.
 * 'merged' is a proof the commits are in the base ref; 'unjudged' is the absence of one.
 */
type BranchVerdict = 'skip' | 'merged' | 'unjudged' | 'force'

const DEFAULT_CREATE_TIMEOUT_MS = 10 * 60_000

export class GitService {
  readonly events = new GitEventEmitter()

  readonly #runner: GitRunner
  readonly #worktreesRoot: string
  readonly #createTimeoutMs: number
  readonly #now: () => number
  readonly #createId: () => string
  readonly #startSetup: GitServiceOptions['startSetup']
  readonly #trustCheckout: GitServiceOptions['trustCheckout']
  readonly #trash: Trash | undefined
  readonly #gh: GhProbe | undefined
  readonly #locateGh: (() => string | null) | undefined
  readonly #agentWorking: (worktreeId: string) => boolean
  // What each project's `.teamree/project.json` said when last read; never persisted.
  readonly #projectFiles = new Map<string, ProjectFileRead>()
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
    this.#trustCheckout = options.trustCheckout
    this.#trash = options.trash
    this.#gh = options.ghBinary === undefined ? undefined : createGhProbe(options.ghBinary, this.#now)
    this.#locateGh = options.ghBinary
    this.#agentWorking = options.agentWorking ?? (() => false)
    this.#ensureVersion = createVersionProbe(this.#runner)
  }

  get worktreesRoot(): string {
    return this.#worktreesRoot
  }

  // ----------------------------------------------------------------- projects

  listProjects(): Project[] {
    return this.#store.listProjects().map((project) => this.#present(project))
  }

  /** Re-reads every project's `.teamree/project.json`, announcing the ones that changed. */
  async refreshProjectFiles(): Promise<void> {
    await Promise.all(this.#store.listProjects().map((project) => this.#refreshProjectFile(project.id)))
  }

  /**
   * Writes the setup as it applies here into `.teamree/project.json`, as an
   * uncommitted change in the primary checkout.
   */
  async saveProjectSettings(params: ParamsOf<'project.saveSettings'>): Promise<{ file: string; project: Project }> {
    const project = this.#present(this.#requireProject(params.projectId))
    const startFrom = params.startFrom ?? project.repository?.startFrom
    const file = await writeProjectFile(project.path, {
      ...effectiveProjectSettings(project),
      ...(startFrom === undefined ? {} : { startFrom })
    })
    await this.#refreshProjectFile(project.id)
    return { file, project: this.#present(this.#requireProject(project.id)) }
  }

  /** The stored project with what its repository file says beside it. */
  #present(project: Project): Project {
    const read = this.#projectFiles.get(project.id)
    return {
      ...project,
      ...(read?.settings === undefined ? {} : { repository: read.settings }),
      ...(read?.problem === undefined ? {} : { repositoryProblem: read.problem })
    }
  }

  async #refreshProjectFile(projectId: string): Promise<void> {
    const project = this.#store.getProject(projectId)
    if (!project) return
    const read = await readProjectFile(project.path)
    const before = JSON.stringify(this.#projectFiles.get(projectId) ?? {})
    this.#projectFiles.set(projectId, read)
    if (JSON.stringify(read) === before || !this.#store.getProject(projectId)) return
    this.events.emit({ type: 'project.updated', project: this.#present(project) })
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
    // Before the announcement, so a project arrives with its repository's setup already applied.
    this.#projectFiles.set(project.id, await readProjectFile(project.path))
    const presented = this.#present(project)
    this.events.emit({ type: 'project.added', project: presented })
    return presented
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
    this.#projectFiles.delete(project.id)
    this.events.emit({ type: 'project.removed', projectId: project.id })
    return { removed: true }
  }

  /** Counts what moving the project's folder to the Trash would lose. */
  async trashPreview(params: ParamsOf<'project.trashPreview'>): Promise<ResultOf<'project.trashPreview'>> {
    const project = this.#requireProject(params.projectId)
    const read = async (args: string[]): Promise<string> =>
      (await this.#runner.tryRun({ args, cwd: project.path, readOnly: true, timeoutMs: 60_000 })).stdout
    const [status, unpushed] = await Promise.all([
      read(['status', '--porcelain', '--untracked-files=all']),
      read(['rev-list', '--count', '--branches', '--not', '--remotes'])
    ])
    return {
      uncommitted: status.split('\n').filter((line) => line.trim() !== '').length,
      unpushed: Number.parseInt(unpushed.trim(), 10) || 0,
      worktrees: this.#store.listWorktrees(project.id).length
    }
  }

  /** Removes its worktrees (each copy kept in the repository), moves its folder to the Trash, then forgets it. */
  async trashProject(params: ParamsOf<'project.trash'>): Promise<ResultOf<'project.trash'>> {
    const project = this.#requireProject(params.projectId)
    await refuseToTrash(project.path)
    const trash = this.#trash
    if (trash === undefined) throw new GitServiceError(ErrorCode.Conflict, `no Trash here for ${project.path}`)
    for (const listed of this.#store.listWorktrees(project.id)) {
      // Gone already with the parent it was a child of.
      const worktree = this.#store.getWorktree(listed.id)
      if (worktree === undefined) continue
      // Only what this app made; a checkout adopted from elsewhere is the owner's own.
      if (!isInside(this.#worktreesRoot, worktree.path)) this.#forget(worktree)
      else await this.removeWorktree({ worktreeId: worktree.id, force: true, children: true })
    }
    await trash(project.path)
    await this.removeProject(params)
    return { trashed: true }
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
    if (params.fetchInBackground === true) delete next.fetchInBackground
    else if (params.fetchInBackground === false) next.fetchInBackground = false
    this.#store.putProject(next)
    const presented = this.#present(next)
    this.events.emit({ type: 'project.updated', project: presented })
    return presented
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
   * Answers the question a repository's unapproved setup command left on a worktree. Run approves
   * exactly that string for the project, then runs it; Skip leaves the worktree without setup.
   */
  async answerSetup(params: ParamsOf<'worktree.setup'>): Promise<Worktree> {
    const worktree = this.#requireWorktree(params.worktreeId)
    const command = worktree.setupAsk
    if (command === undefined) {
      throw new GitServiceError(ErrorCode.Conflict, `worktree "${worktree.name}" has no setup command waiting`)
    }
    if (!params.run) return this.#patch(worktree.id, { clearSetupAsk: true }) ?? worktree
    const project = this.#requireProject(worktree.projectId)
    const approved: Project = { ...project, approvedSetupCommand: command }
    this.#store.putProject(approved)
    this.events.emit({ type: 'project.updated', project: this.#present(approved) })
    const setupTerminalId = this.#runSetup(worktree, approved, command)
    return (
      this.#patch(worktree.id, {
        clearSetupAsk: true,
        ...(setupTerminalId === undefined ? {} : { setupTerminalId })
      }) ?? worktree
    )
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
  async createWorktree(params: ParamsOf<'worktree.create'>, options: { limited?: boolean } = {}): Promise<Worktree> {
    const project = this.#requireProject(params.projectId)
    const name = params.name.trim()
    if (!name) throw new GitServiceError(ErrorCode.InvalidParams, 'worktree name must not be blank')
    if (params.parentId !== undefined) this.#requireParent(project, params)

    // Serialised per project: choosing branch and path reads the store, and two
    // creates overlapping in that gap agree on one slug and two records name one
    // checkout path — the losing add then cleans up over the winner's checkout.
    // The limits are read inside for the same reason: two agents must not both see a fifth child.
    return this.#reserve(project.id, () => {
      const parent = params.parentId === undefined ? undefined : this.#requireParent(project, params)
      if (parent !== undefined && options.limited === true) this.#refuseOverLimit(parent)
      return this.#openWorktreeRecord(project, name, params, parent)
    })
  }

  /** The worktree a child task branches from: ready, in this project, and the only start point. */
  #requireParent(project: Project, params: ParamsOf<'worktree.create'>): Worktree {
    const parent = this.#store.getWorktree(params.parentId as string)
    if (parent === undefined || parent.projectId !== project.id) {
      throw new GitServiceError(ErrorCode.NotFound, `no worktree with id "${params.parentId}" in ${project.name}`)
    }
    if (params.checkout !== undefined || params.startedFrom !== undefined || params.base !== undefined) {
      throw new GitServiceError(ErrorCode.InvalidParams, "a child task starts from its parent's branch")
    }
    if (parent.state !== 'ready') {
      throw new GitServiceError(
        ErrorCode.Conflict,
        `worktree "${parent.name}" is ${parent.state}; a child needs it ready`
      )
    }
    return parent
  }

  #refuseOverLimit(parent: Worktree): void {
    const chain = this.#ancestry(parent)
    // The top-level task is depth 0, so the new child sits `chain.length` deep.
    if (chain.length > MAX_CHILD_DEPTH) {
      const top = chain[chain.length - 1] as Worktree
      throw new GitServiceError(ErrorCode.ChildLimit, `${MAX_CHILD_DEPTH} deep under ${top.name}`)
    }
    const open = this.#childrenOf(parent.id).length
    if (open >= MAX_OPEN_CHILDREN) {
      throw new GitServiceError(ErrorCode.ChildLimit, `${open} open children under ${parent.name}`)
    }
  }

  /** The worktree and its parents, nearest first. A cycle in a hand-edited file ends the walk. */
  #ancestry(worktree: Worktree): Worktree[] {
    const chain = [worktree]
    let at = worktree
    while (at.parentId !== undefined) {
      const up = this.#store.getWorktree(at.parentId)
      if (up === undefined || chain.includes(up)) break
      chain.push(up)
      at = up
    }
    return chain
  }

  #childrenOf(worktreeId: string): Worktree[] {
    return this.#store.listWorktrees().filter((worktree) => worktree.parentId === worktreeId)
  }

  /**
   * Moves a worktree under another, or to the top level with `parentId` null. A branch that
   * lacks the parent's tip is replayed onto it only with `rebase`; `dryRun` answers and changes nothing.
   */
  async nestWorktree(params: ParamsOf<'worktree.nest'>, options: { limited?: boolean } = {}): Promise<WorktreeNest> {
    if (params.dryRun === true) return (await this.#planNest(params, options)).answer
    const projectId = this.#store.getWorktree(params.worktreeId)?.projectId ?? ''
    // Serialised with creates, so the limits are read with nothing in flight.
    return this.#reserve(projectId, async () => {
      const { answer, replayed } = await this.#planNest(params, options)
      if (answer.change === 'none') return answer
      if (replayed !== undefined) await replay(this.#runner, replayed)
      const { worktree } = answer
      const nested = this.#patch(worktree.id, {
        ...(worktree.parentId === undefined ? { clearParent: true } : { parentId: worktree.parentId }),
        ...(worktree.baseRef === undefined ? { clearBaseRef: true } : { baseRef: worktree.baseRef }),
        startedFrom: worktree.startedFrom
      })
      if (nested === null) throw new GitServiceError(ErrorCode.NotFound, 'Removed')
      return { ...answer, worktree: nested }
    })
  }

  async #planNest(
    params: ParamsOf<'worktree.nest'>,
    options: { limited?: boolean }
  ): Promise<{ answer: WorktreeNest; replayed?: ReplayPlan }> {
    const dryRun = params.dryRun === true
    const refusal = nestRefusal(this.#store.listWorktrees(), params.worktreeId, params.parentId, options)
    const child = this.#store.getWorktree(params.worktreeId)
    if (refusal?.refusal === 'unchanged' && child !== undefined) {
      return { answer: { worktree: child, change: 'none', dryRun } }
    }
    if (refusal !== null || child === undefined) throw nestError(refusal ?? { refusal: 'missing', reason: 'Removed' })
    const project = this.#requireProject(child.projectId)
    const repo = { runner: this.#runner, cwd: project.path }
    const { parentId: _parent, baseRef: _base, ...rest } = child

    if (params.parentId === null) {
      const oldParent = child.parentId === undefined ? undefined : this.#store.getWorktree(child.parentId)
      const inherited =
        oldParent === undefined ? 0 : await inheritedCommits(repo, child.branch, oldParent.branch, project.baseRef)
      return { answer: { worktree: rest, change: 'unnest', dryRun, inherited } }
    }

    const parent = this.#requireWorktree(params.parentId)
    for (const worktree of [child, parent]) {
      if (await hasLanded(repo, worktree.branch, worktree.startedFrom, worktree.baseRef ?? project.baseRef)) {
        throw nestError({ refusal: 'landed', reason: `${worktree.name} has landed` })
      }
    }
    const nested: Worktree = { ...rest, parentId: parent.id, baseRef: parent.branch }
    if (await containsTip(repo, child.branch, parent.branch)) {
      return { answer: { worktree: nested, change: 'nest', dryRun } }
    }

    // Its children branched from commits a rebase would replace.
    const below = descendantsOf(this.#store.listWorktrees(), child.id).length
    if (below > 0) {
      throw nestError({ refusal: 'hasChildren', reason: `Has ${below} ${below === 1 ? 'child' : 'children'}` })
    }
    if (params.rebase !== true && !dryRun) {
      throw nestError({ refusal: 'needsRebase', reason: `Needs a rebase onto ${parent.branch}` })
    }
    const replayed: ReplayPlan = {
      worktreePath: child.path,
      branch: child.branch,
      onto: parent.branch,
      from: await forkPoint(repo, child.branch, child.baseRef ?? project.baseRef, child.startedFrom)
    }
    await checkReplay(this.#runner, replayed, this.#agentWorking(child.id))
    const tip = await this.#runner.run({ args: ['rev-parse', parent.branch], cwd: project.path, readOnly: true })
    return {
      answer: { worktree: { ...nested, startedFrom: tip.stdout.trim() }, change: 'rebase', dryRun },
      replayed
    }
  }

  /** Runs `reserve` after every earlier reservation for this project has finished. */
  #reserve<T>(projectId: string, reserve: () => Promise<T>): Promise<T> {
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
  async #openWorktreeRecord(
    project: Project,
    name: string,
    params: ParamsOf<'worktree.create'>,
    parent?: Worktree
  ): Promise<Worktree> {
    const checkout = params.checkout?.trim()
    const claim =
      checkout === undefined || checkout === ''
        ? { branch: await this.#chooseBranch(project, name, params.branch, parent) }
        : await this.#claimCheckout(project, checkout)
    const branch = claim.branch
    const checkoutPath =
      claim.adopt ??
      (await allocateCheckoutPath(
        this.#worktreesRoot,
        project.name,
        branch,
        new Set(this.#store.listWorktrees().map((worktree) => pathKey(worktree.path))),
        parent === undefined ? undefined : childCheckoutDirName(parent.path, parent.branch, branch)
      ))

    const told = params.task?.trim()
    const worktree: Worktree = {
      id: this.#createId(),
      projectId: project.id,
      name,
      branch,
      path: checkoutPath,
      startedFrom: parent?.branch ?? (params.base?.trim() || params.startedFrom?.trim() || project.baseRef),
      state: 'creating',
      createdAt: this.#now(),
      ...(told ? { task: told } : {}),
      ...(parent === undefined ? {} : { parentId: parent.id, baseRef: parent.branch }),
      ...(checkout ? { checkout } : {}),
      ...(checkout && params.base?.trim() ? { baseRef: params.base.trim() } : {})
    }
    if (claim.adopt !== undefined) {
      // Already built and set up: taken back as it is, nothing run in it.
      const adopted: Worktree = { ...worktree, state: 'ready' }
      adopted.startedFrom = await this.#forkPoint(project, adopted)
      this.#store.putWorktree(adopted)
      this.events.emit({ type: 'worktree.created', worktree: adopted })
      return adopted
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

  async removeWorktree(params: ParamsOf<'worktree.remove'>): Promise<ResultOf<'worktree.remove'>> {
    const initial = this.#requireWorktree(params.worktreeId)
    const children = this.#childrenOf(initial.id)
    if (children.length > 0) {
      if (params.children !== true) {
        const count = descendantsOf(this.#store.listWorktrees(), initial.id).length
        throw new GitServiceError(
          ErrorCode.Conflict,
          `worktree "${initial.name}" has ${count} ${
            count === 1 ? 'child' : 'children'
          }; remove with children to take them too`
        )
      }
      // Deepest first, each kept for restore as any removal is; a refusal stops before the parent.
      for (const child of children) await this.removeWorktree({ ...params, worktreeId: child.id })
    }
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
    if (params.deleteBranch) {
      branchVerdict = await this.#judgeBranchDeletion(
        project,
        worktree.branch,
        worktree.baseRef ?? project.baseRef,
        force
      )
    }

    const previousState = worktree.state
    // Before anything is destroyed, and a refusal if it cannot be kept.
    const trashId = previousState === 'ready' ? await this.#keepCopy(project, worktree, 'remove') : undefined
    const kept = trashId === undefined ? {} : { trashId }
    // Somebody else dropped the record while this was starting; nothing was destroyed.
    if (!this.#patch(worktree.id, { state: 'removing' })) {
      if (trashId !== undefined) await dropTrash(this.#runner, project.path, trashId)
      return { removed: true, ...(await this.#surviving(worktree)) }
    }

    let detached: { checkoutLeftAt?: string }
    try {
      detached = await this.#detachCheckout(project, worktree, force)
    } catch (error) {
      this.#patch(worktree.id, { state: previousState })
      if (trashId !== undefined) await dropTrash(this.#runner, project.path, trashId)
      throw error
    }

    this.#forget(worktree)
    // 'merged' is a proof from `merge-base --is-ancestor`. `git branch -d` asks a
    // different question (merged into HEAD or upstream) and says "no" for a branch
    // plainly in the base, so `-d` only judges the case with no proof to have.
    if (branchVerdict !== 'skip') {
      await this.#deleteBranch(project, worktree.branch, branchVerdict !== 'unjudged')
    }
    return { removed: true, ...detached, ...kept }
  }

  /** Forgets the record; the checkout and its branch stay, and Open Branch offers the branch again. */
  async forgetWorktree(params: ParamsOf<'worktree.forget'>): Promise<ResultOf<'worktree.forget'>> {
    const initial = this.#requireWorktree(params.worktreeId)
    if (initial.state === 'creating') await this.cancelWorktreeCreate(initial.id)
    const worktree = this.#store.getWorktree(params.worktreeId)
    if (worktree) await this.#forgetParent(worktree)
    return { forgotten: true, ...(await this.#surviving(worktree ?? initial)) }
  }

  /** Removed worktrees that can still be restored, newest first; ten unless asked. */
  async listRemovedWorktrees(params: ParamsOf<'worktree.removed'> = {}): Promise<RemovedWorktree[]> {
    const projects =
      params.projectId === undefined ? this.#store.listProjects() : [this.#requireProject(params.projectId)]
    const listed = await Promise.all(
      projects.map(async (project) =>
        (await listTrash(this.#runner, project.path).catch(() => []))
          .filter((entry) => entry.note.kind === 'remove' && !this.#store.getWorktree(entry.note.worktree.id))
          .map((entry) => removedWorktree(entry, project.id))
      )
    )
    return listed
      .flat()
      .sort((a, b) => b.removedAt - a.removedAt)
      .slice(0, params.limit ?? 10)
  }

  /** Checks a removed worktree out again on its branch, puts its copy back, and forgets the copy. */
  async restoreWorktree(params: ParamsOf<'worktree.restore'>): Promise<Worktree> {
    const project = this.#requireProject(params.projectId)
    const entry = await readTrash(this.#runner, project.path, params.removedId)
    const saved = entry.note.worktree
    if (entry.note.kind !== 'remove') {
      throw new GitServiceError(ErrorCode.InvalidParams, `"${params.removedId}" is not a removed worktree`)
    }
    if (this.#store.getWorktree(saved.id))
      throw new GitServiceError(ErrorCode.Conflict, `"${saved.name}" is back already`)
    const taken = this.#store.listWorktrees().some((other) => pathKey(other.path) === pathKey(saved.path))
    if (taken || (await isDirectory(saved.path))) {
      throw new GitServiceError(ErrorCode.Conflict, `${saved.path} is in use`)
    }

    // On its branch where the branch is still there; otherwise the branch comes back where it was.
    const tip = await this.#branchTip(project, saved.branch)
    if (tip === null && entry.note.head === null) {
      throw new GitServiceError(ErrorCode.Conflict, `branch "${saved.branch}" is gone`)
    }
    const add =
      tip === null
        ? ['worktree', 'add', '--no-track', '-b', saved.branch, saved.path, entry.note.head as string]
        : ['worktree', 'add', saved.path, saved.branch]
    await mkdir(path.dirname(saved.path), { recursive: true })
    await this.#runner.run({ args: add, cwd: project.path, timeoutMs: this.#createTimeoutMs })
    try {
      const settings = this.#store.getProject(project.id) ?? project
      await prepareWorktree(this.#runner, {
        repoPath: project.path,
        worktreePath: saved.path,
        ...(settings.linkedPaths === undefined ? {} : { linkedPaths: settings.linkedPaths }),
        ...(settings.copiedPaths === undefined ? {} : { copiedPaths: settings.copiedPaths })
      })
      await restoreTrash(this.#runner, { worktreePath: saved.path, entry, withIndex: true })
    } catch (error) {
      // The copy stays, so the restore can be asked for again.
      await this.#runner.tryRun({ args: ['worktree', 'remove', '--force', saved.path], cwd: project.path })
      if (tip === null) await this.#runner.tryRun({ args: ['branch', '-D', saved.branch], cwd: project.path })
      throw error
    }

    const { parentId, baseRef, ...rest } = saved
    const parentBack = typeof parentId === 'string' && this.#store.getWorktree(parentId)?.projectId === project.id
    const baseBack = typeof baseRef === 'string' && (parentBack || (await this.#refExists(project, baseRef)))
    const worktree: Worktree = {
      ...rest,
      projectId: project.id,
      state: 'ready',
      ...(parentBack ? { parentId } : {}),
      ...(baseBack ? { baseRef } : {})
    }
    this.#store.putWorktree(worktree)
    this.events.emit({ type: 'worktree.created', worktree })
    await dropTrash(this.#runner, project.path, entry.id)
    return worktree
  }

  /** Puts back the paths one discard threw away, from its copy, and forgets the copy. */
  async undoDiscard(params: ParamsOf<'worktree.undoDiscard'>): Promise<{ restored: true }> {
    const worktree = this.#requireReadyWorktree(params.worktreeId, 'undoing a discard')
    const project = this.#requireProject(worktree.projectId)
    const entry = await readTrash(this.#runner, project.path, params.trashId)
    if (entry.note.kind !== 'discard' || entry.note.worktree.id !== worktree.id) {
      throw new GitServiceError(ErrorCode.InvalidParams, `"${params.trashId}" is not a discard in this worktree`)
    }
    await restoreTrash(this.#runner, {
      worktreePath: worktree.path,
      entry,
      ...(entry.note.paths === undefined ? {} : { paths: entry.note.paths })
    })
    await dropTrash(this.#runner, project.path, entry.id)
    return { restored: true }
  }

  /** Drops kept copies past their fortnight, in every project; a repository that cannot be read keeps its own. */
  async pruneTrash(): Promise<number> {
    let pruned = 0
    for (const project of this.#store.listProjects()) {
      pruned += await pruneTrash(this.#runner, project.path, this.#now()).catch(() => 0)
    }
    return pruned
  }

  /**
   * Keeps a copy of the worktree's uncommitted work, or of `paths` in it, and answers its id.
   * A checkout git cannot read has nothing to keep; any other failure refuses the action.
   */
  async #keepCopy(
    project: Project,
    worktree: Worktree,
    kind: TrashNote['kind'],
    paths?: readonly string[]
  ): Promise<string | undefined> {
    if (!(await isDirectory(worktree.path))) return undefined
    try {
      const entry = await snapshotWorktree(this.#runner, {
        repoPath: project.path,
        worktreePath: worktree.path,
        worktree: {
          id: worktree.id,
          projectId: worktree.projectId,
          name: worktree.name,
          branch: worktree.branch,
          path: worktree.path,
          startedFrom: worktree.startedFrom,
          createdAt: worktree.createdAt,
          ...(worktree.task === undefined ? {} : { task: worktree.task }),
          ...(worktree.parentId === undefined ? {} : { parentId: worktree.parentId }),
          ...(worktree.baseRef === undefined ? {} : { baseRef: worktree.baseRef })
        },
        kind,
        ...(paths === undefined ? {} : { paths }),
        now: this.#now()
      })
      return entry.id
    } catch (error) {
      if (kind === 'remove' && error instanceof GitCommandError && isNotAWorkingTree(error.stderr)) return undefined
      throw new GitServiceError(
        ErrorCode.Conflict,
        `could not keep a copy first, so nothing was ${
          kind === 'remove' ? 'removed' : 'discarded'
        }: ${describeError(error)}`
      )
    }
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
      baseRef: worktree.baseRef ?? project?.baseRef,
      prepared: this.#preparedPaths(worktree.projectId),
      now: this.#now
    })
  }

  /** What this project puts in every worktree. Read fresh: the lists are editable. */
  #preparedPaths(projectId: string): PreparedPaths {
    const project = this.#store.getProject(projectId)
    const settings = project === undefined ? {} : effectiveProjectSettings(this.#present(project))
    return {
      ...(settings.linkedPaths === undefined ? {} : { linkedPaths: settings.linkedPaths }),
      ...(settings.copiedPaths === undefined ? {} : { copiedPaths: settings.copiedPaths })
    }
  }

  /** Every changed path in a worktree. */
  async worktreeChanges(params: ParamsOf<'worktree.changes'>): Promise<WorktreeChanges> {
    const worktree = this.#requireReadyWorktree(params.worktreeId, 'changes')
    const options = {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      ...(params.path === undefined ? {} : { path: params.path }),
      ...(params.limit === undefined ? {} : { limit: params.limit }),
      prepared: this.#preparedPaths(worktree.projectId),
      now: this.#now
    }
    if (params.base === true) {
      return readBranchChanges(this.#runner, { ...options, against: await this.#branchBase(worktree) })
    }
    return readWorktreeChanges(this.#runner, options)
  }

  /** The commit this worktree's branch left its base at: a child's parent branch, else the project's. */
  async #branchBase(worktree: Worktree): Promise<string> {
    const baseRef = worktree.baseRef ?? this.#store.getProject(worktree.projectId)?.baseRef
    if (baseRef === undefined) {
      throw new GitServiceError(ErrorCode.NotFound, `worktree "${worktree.name}" has no base to compare against`)
    }
    assertRefShape(baseRef, 'base ref')
    const found = await this.#runner.tryRun({
      args: ['merge-base', baseRef, 'HEAD'],
      cwd: worktree.path,
      readOnly: true,
      timeoutMs: 30_000
    })
    const sha = found.stdout.trim()
    if (found.exitCode !== 0 || sha === '') {
      throw new GitServiceError(ErrorCode.Conflict, `this branch has no commit in common with ${baseRef}`)
    }
    return sha
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
      ...(params.staged === true
        ? {}
        : params.base === true
          ? { against: await this.#branchBase(worktree) }
          : params.head === true
            ? { against: 'HEAD' }
            : {}),
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
      keep: () => this.#keepDiscard(worktree, params.path),
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
      keep: () => this.#keepDiscard(worktree, params.path),
      now: this.#now
    })
  }

  async #keepDiscard(worktree: Worktree, file: string): Promise<string> {
    const id = await this.#keepCopy(this.#requireProject(worktree.projectId), worktree, 'discard', [file])
    if (id === undefined) throw new GitServiceError(ErrorCode.Conflict, 'the checkout is not on disk')
    return id
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
      baseRef: worktree.baseRef ?? project?.baseRef ?? 'HEAD',
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
      ...(project === undefined ? {} : { baseRef: worktree.baseRef ?? project.baseRef }),
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
      baseRef: worktree.baseRef ?? project.baseRef,
      branch: worktree.branch,
      now: this.#now
    })
  }

  /** Brings the project's base ref into this worktree; a conflict leaves it mid-way. See worktreeUpdate.ts. */
  async worktreeUpdate(params: ParamsOf<'worktree.update'>): Promise<WorktreeUpdate> {
    const worktree = this.#requireReadyWorktree(params.worktreeId, 'updating')
    const project = this.#requireProject(worktree.projectId)
    return updateWorktree(this.#runner, {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      baseRef: project.baseRef,
      now: this.#now
    })
  }

  async worktreeAbortUpdate(params: ParamsOf<'worktree.abortUpdate'>): Promise<WorktreeUpdateAbort> {
    const worktree = this.#requireReadyWorktree(params.worktreeId, 'aborting an update')
    return abortWorktreeUpdate(this.#runner, { worktreeId: worktree.id, worktreePath: worktree.path })
  }

  /** Where this worktree's branch can land, and whether it already has. */
  async worktreeLanding(params: ParamsOf<'worktree.landing'>): Promise<WorktreeLanding> {
    return readLanding(this.#runner, this.#landingOptions(params.worktreeId, 'landing'))
  }

  /** A pull request for the worktree's published branch, or the host's page for one. */
  async worktreeCreatePullRequest(params: ParamsOf<'worktree.createPullRequest'>): Promise<WorktreePullRequest> {
    return createPullRequest(this.#runner, this.#landingOptions(params.worktreeId, 'a pull request'))
  }

  /** Merges the worktree's branch into the base branch in the project's own checkout. */
  async worktreeMergeIntoBase(params: ParamsOf<'worktree.mergeIntoBase'>): Promise<WorktreeMerge> {
    const worktree = this.#requireReadyWorktree(params.worktreeId, 'a merge')
    const project = this.#store.getProject(worktree.projectId)
    if (!project) {
      throw new GitServiceError(ErrorCode.NotFound, `worktree "${worktree.name}" has no project to merge into`)
    }
    return mergeIntoBase(this.#runner, {
      worktreeId: worktree.id,
      repoPath: project.path,
      branch: worktree.branch,
      baseRef: project.baseRef,
      ...(params.dryRun === undefined ? {} : { dryRun: params.dryRun })
    })
  }

  /**
   * Keeps one run of a task and removes the others, their branches left in place. Without `force`,
   * any run holding uncommitted or ignored files refuses the whole keep before anything goes.
   */
  async keepWorktree(params: ParamsOf<'worktree.keep'>): Promise<WorktreeKeep> {
    const kept = this.#requireReadyWorktree(params.worktreeId, 'keeping a run')
    const siblings = siblingRuns(kept, this.#store.listWorktrees())
    const force = params.force === true
    if (!force) {
      const holding: string[] = []
      for (const sibling of siblings) {
        const status = await this.worktreeStatus({ worktreeId: sibling.id }).catch(() => null)
        const files = status === null ? 0 : status.staged + status.unstaged + status.untracked + status.conflicted
        if (files > 0 || (status?.ignored ?? 0) > 0) holding.push(sibling.name)
      }
      if (holding.length > 0) {
        throw new GitServiceError(
          ErrorCode.Conflict,
          `${holding.join(', ')} ${
            holding.length === 1 ? 'has' : 'have'
          } uncommitted work; keep with force to remove it`
        )
      }
    }
    const removed: string[] = []
    for (const sibling of siblings) {
      await this.removeWorktree({ worktreeId: sibling.id, force })
      removed.push(sibling.id)
    }
    const name = keptName(kept, siblings)
    const worktree = name === null ? kept : await this.renameWorktree({ worktreeId: kept.id, name })
    return { worktree, removed }
  }

  #landingOptions(worktreeId: string, what: string): Parameters<typeof readLanding>[1] {
    const worktree = this.#requireReadyWorktree(worktreeId, what)
    const project = this.#store.getProject(worktree.projectId)
    if (!project) throw new GitServiceError(ErrorCode.NotFound, `worktree "${worktree.name}" has no project`)
    return {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      branch: worktree.branch,
      baseRef: project.baseRef,
      startedFrom: worktree.startedFrom,
      ...(this.#gh === undefined ? {} : { gh: this.#gh }),
      now: this.#now
    }
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

  /** Branches a worktree can be opened on as they are. */
  async listBranches(params: ParamsOf<'worktree.branches'>): Promise<BranchList> {
    const project = this.#requireProject(params.projectId)
    const branches = await listOpenableBranches(this.#runner, project.path)
    // In-flight creates hold branch names git has not checked out yet.
    const claimed = new Set(this.#store.listWorktrees(project.id).map((worktree) => worktree.branch))
    return {
      projectId: project.id,
      branches: branches.filter((branch) => !claimed.has(branch.name)),
      readAt: this.#now()
    }
  }

  async listPullRequests(params: ParamsOf<'worktree.pullRequests'>): Promise<PullRequestList> {
    const project = this.#requireProject(params.projectId)
    const read = await listPullRequests(this.#locateGh?.() ?? null, project.path)
    // As Open Branch: a head already checked out cannot be checked out twice.
    const inventory = await readWorktreeInventory(this.#runner, project.path)
    const taken = new Set([
      ...inventory.flatMap((entry) => (entry.branch === undefined ? [] : [entry.branch])),
      ...this.#store.listWorktrees(project.id).map((worktree) => worktree.branch)
    ])
    const pullRequests = read.pullRequests.filter((pull) => !taken.has(pull.branch))
    return { projectId: project.id, ...read, pullRequests, readAt: this.#now() }
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
    void this.refreshProjectFiles().catch(() => undefined)
  }

  /** Call once at startup: whatever was mid-flight then has no owner now. */
  reviveRestoredRecords(): void {
    const ids = new Set(this.#store.listWorktrees().map((worktree) => worktree.id))
    for (const listed of this.#store.listWorktrees()) {
      let worktree = listed
      if (worktree.state === 'creating') {
        worktree = { ...worktree, state: 'failed', error: 'interrupted by a restart', retryable: true }
      } else if (worktree.state === 'removing') {
        worktree = { ...worktree, state: 'ready' }
      }
      // A parent salvage could not read: the child stays, top-level, still measured against its branch.
      if (worktree.parentId !== undefined && !ids.has(worktree.parentId)) {
        const { parentId: _dropped, ...orphan } = worktree
        worktree = orphan
      }
      if (worktree !== listed) this.#store.putWorktree(worktree)
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
    patch: Partial<Worktree> & {
      clearError?: boolean
      clearMissing?: boolean
      clearSetupAsk?: boolean
      clearParent?: boolean
      clearBaseRef?: boolean
    }
  ): Worktree | null {
    const current = this.#store.getWorktree(worktreeId)
    if (!current) return null
    const { clearError, clearMissing, clearSetupAsk, clearParent, clearBaseRef, ...fields } = patch
    const next: Worktree = { ...current, ...fields }
    if (clearSetupAsk) delete next.setupAsk
    if (clearParent) delete next.parentId
    if (clearBaseRef) delete next.baseRef
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
    const children = this.#childrenOf(worktree.id)
    this.#store.removeWorktree(worktree.id)
    this.#startPoints.delete(worktree.id)
    this.events.emit({ type: 'worktree.removed', worktreeId: worktree.id, projectId: worktree.projectId })
    for (const child of children) this.#patch(child.id, { clearParent: true })
  }

  /** Forgets it; its children go top-level and keep measuring against its branch while that exists. */
  async #forgetParent(worktree: Worktree): Promise<void> {
    const children = this.#childrenOf(worktree.id)
    this.#forget(worktree)
    const project = this.#store.getProject(worktree.projectId)
    if (project === undefined) return
    for (const child of children) {
      if (child.baseRef !== worktree.branch || (await this.#refExists(project, worktree.branch))) continue
      this.#patch(child.id, { clearBaseRef: true })
    }
  }

  async #refExists(project: Project, ref: string): Promise<boolean> {
    const read = await this.#runner.tryRun({
      args: ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      cwd: project.path,
      readOnly: true
    })
    return read.exitCode === 0
  }

  /**
   * The branch an existing-branch checkout will be on. A linked checkout no record names is
   * `adopt`ed as it is; the primary checkout or one a record holds is refused.
   */
  async #claimCheckout(project: Project, checkout: string): Promise<{ branch: string; adopt?: string }> {
    const branch = branchForCheckout(checkout)
    if (!isValidBranchName(branch) || checkout.startsWith('-')) {
      throw new GitServiceError(ErrorCode.InvalidParams, `"${checkout}" is not a branch to check out`)
    }
    const inventory = await readWorktreeInventory(this.#runner, project.path)
    const recorded = this.#store.listWorktrees(project.id)
    const holder = inventory.find((entry) => entry.branch === branch)
    const adoptable =
      holder !== undefined &&
      holder !== inventory[0] &&
      !samePath(holder.path, project.path) &&
      !this.#store.listWorktrees().some((worktree) => samePath(worktree.path, holder.path)) &&
      (await isDirectory(holder.path))
    if ((holder !== undefined && !adoptable) || recorded.some((worktree) => worktree.branch === branch)) {
      throw new GitServiceError(ErrorCode.Conflict, `branch "${branch}" is already checked out`)
    }
    return holder === undefined ? { branch } : { branch, adopt: holder.path }
  }

  async #chooseBranch(project: Project, taskName: string, requested?: string, parent?: Worktree): Promise<string> {
    // In-flight creates own branch names git has not heard of yet.
    const recorded = this.#store.listWorktrees(project.id).map((worktree) => worktree.branch)
    // Deliberately not caught: an empty list says "free" about every name there is.
    const fromGit = await listBranchNames(this.#runner, project.path)
    const existing = [...fromGit, ...recorded]

    if (requested === undefined) {
      return parent === undefined
        ? allocateBranchName(taskName, existing)
        : allocateChildBranchName(parent.branch, taskName, existing)
    }

    const branch = requested.trim()
    if (!isValidBranchName(branch)) {
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
    const checkout = worktree.checkout
    try {
      let startedFrom: string
      let start: ResolvedStartPoint | undefined
      if (checkout === undefined) {
        start = await resolveStartPoint(this.#runner, {
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
        startedFrom = start.sha
      } else {
        ourBranch = await this.#checkOutExisting(project, worktree, checkout, signal, () => (ourCheckout = true))
        startedFrom = await this.#forkPoint(project, worktree)
      }
      // Before 'ready', deliberately: a pane opens on the transition, and `npm test`
      // in a checkout still being linked fails for a reason that stops being true.
      // Read from the store: the lists may have changed during a long add.
      await this.#refreshProjectFile(project.id)
      const settings = effectiveProjectSettings(this.#present(this.#store.getProject(project.id) ?? project))
      await prepareWorktree(this.#runner, {
        repoPath: project.path,
        worktreePath: worktree.path,
        ...(settings.linkedPaths === undefined ? {} : { linkedPaths: settings.linkedPaths }),
        ...(settings.copiedPaths === undefined ? {} : { copiedPaths: settings.copiedPaths }),
        signal
      })
      // Also before 'ready': the agent pane that opens on it reads its trust as it starts.
      await this.#trustCheckout?.({ projectPath: project.path, worktreePath: worktree.path }).catch(
        (error: unknown) => {
          console.error(`[git] could not record agent trust for worktree ${worktree.id}`, error)
        }
      )
      if (start !== undefined) this.#startPoints.set(worktreeId, start)
      // In the same breath as the flip to 'ready': one write, one event, nothing
      // in between for a client to read a half-answer out of.
      const stored = this.#store.getProject(project.id) ?? project
      const setupAsk = unapprovedSetup(stored, settings.setupCommand)
      const setupTerminalId =
        setupAsk === undefined ? this.#runSetup(worktree, stored, settings.setupCommand) : undefined
      // What it branched from is now a fact: the name could move, the sha cannot.
      return (
        this.#patch(worktreeId, {
          state: 'ready',
          startedFrom,
          clearError: true,
          ...(setupTerminalId === undefined ? {} : { setupTerminalId }),
          ...(setupAsk === undefined ? {} : { setupAsk })
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
   * `git worktree add` on a branch that exists, locally or on origin. Answers
   * with the branch when this call made it, the only one cleanup may delete.
   */
  async #checkOutExisting(
    project: Project,
    worktree: Worktree,
    checkout: string,
    signal: AbortSignal,
    claimed: () => void
  ): Promise<{ branch: string; sha: string } | null> {
    const run = (args: string[]): Promise<unknown> =>
      this.#runner.run({ args, cwd: project.path, signal, timeoutMs: this.#createTimeoutMs })
    const branch = worktree.branch
    let made: { branch: string; sha: string } | null = null
    if ((await this.#branchTip(project, branch)) === null) {
      const source = checkout.startsWith('pull/') ? `refs/${checkout}` : `refs/remotes/${checkout}`
      if (checkout.startsWith('pull/')) await run(['fetch', '--no-tags', 'origin', `${source}:refs/heads/${branch}`])
      else await run(['branch', '--track', branch, source])
      made = { branch, sha: (await this.#branchTip(project, branch)) ?? '' }
    }
    await mkdir(path.dirname(worktree.path), { recursive: true })
    claimed()
    await run(['worktree', 'add', worktree.path, branch])
    return made
  }

  /** Where the branch left its base, so Changes shows its own commits and no one else's. */
  async #forkPoint(project: Project, worktree: Worktree): Promise<string> {
    const base = await this.#runner.tryRun({
      args: ['merge-base', worktree.startedFrom, worktree.branch],
      cwd: project.path,
      readOnly: true
    })
    if (base.exitCode === 0 && base.stdout.trim() !== '') return base.stdout.trim()
    return (await this.#branchTip(project, worktree.branch)) ?? worktree.startedFrom
  }

  /**
   * Starts the project's setup command in the finished checkout, if any. Never a
   * reason to fail a create: throwing here would discard a correct checkout.
   */
  #runSetup(worktree: Worktree, project: Project, command: string | undefined): string | undefined {
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

  async #judgeBranchDeletion(project: Project, branch: string, target: string, force: boolean): Promise<BranchVerdict> {
    if (force) return 'force'
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
          await this.#forgetParent(worktree)
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

/**
 * The command to ask about before running: the repository's, when this Mac set none of its own
 * and has not approved this exact string. A teammate's commit must not run here unseen.
 */
function unapprovedSetup(project: Project, command: string | undefined): string | undefined {
  if (command === undefined || project.setupCommand !== undefined) return undefined
  return command === project.approvedSetupCommand ? undefined : command
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

/** Refuses the home folder, anything above it, a filesystem root, and anything not a directory. */
async function refuseToTrash(folder: string): Promise<void> {
  const refuse = (why: string): GitServiceError =>
    new GitServiceError(ErrorCode.InvalidParams, `will not move ${folder} to the Trash: ${why}`)
  const resolved = await realpath(folder).catch(() => null)
  if (resolved === null || !(await isDirectory(resolved))) throw refuse('not a folder')
  const home = await realpath(os.homedir()).catch(() => os.homedir())
  if (path.parse(resolved).root === resolved) throw refuse('a disk root')
  if (samePath(resolved, home) || isInside(resolved, home)) throw refuse('holds the home folder')
}
