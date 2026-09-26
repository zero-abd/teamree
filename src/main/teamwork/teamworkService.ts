// Identity and membership for a project: a keypair per installation, the public
// half committed to the repository, push access as membership. Joining and
// setting the relay write a file and stop; `publish` is the commit, on a button.

import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  MemberIdentity,
  MemberList,
  Project,
  RelaySetting,
  TeamworkOrigin,
  TeamworkPublish,
  TeamworkPublishPlan,
  TeamworkPublishProgress,
  TeamworkPull
} from '../../shared/entities'
import type { ParamsOf } from '../../shared/methods'
import { checkOrigin } from '../../shared/origin'
import { classifyFetchFailure, type BaseFetchOutcome, type BaseFetchProject } from '../git/baseFetch'
import { createGitRunner, type GitRunner } from '../git/gitProcess'
import { ErrorCode } from '../../shared/protocol'
import { notFound } from '../runtime/runtimeError'
import { badHandle, badOriginUrl, badRelayUrl, rosterConflict, TeamworkError } from './errors'
import { publish, readPublishPlan, sshCommand, type PublishPhase } from './publish'
import { shippedRelayCommand } from './relayCommand'
import { resolveHandle } from './handle'
import { loadIdentity } from './identity'
import { formatMemberFile, MEMBER_FILE_SUFFIX, MEMBERS_DIR_SEGMENTS } from './memberFile'
import {
  parseRelayUrl,
  readRelayFile,
  RELAY_FILE_NAME,
  RELAY_URL_ENV,
  relayOverride,
  writeRelayFile
} from './peer/relayUrl'
import { memberFileName, memberFilePath, readRoster, type Roster } from './roster'
import { catchUp, type CatchUp } from './sync'

const membersDirectoryName = MEMBERS_DIR_SEGMENTS.join('/')

/** How often origin is fetched while you are the only one on a roster. */
export const WAITING_FETCH_MS = 30_000

/** Only the sliver of the workspace store this needs, so a test can hand it one project. */
export type ProjectSource = { getProject: (projectId: string) => Project | undefined }

/** One publish, and the handle on it that makes stopping it possible. */
type PublishRun = { controller: AbortController; progress: TeamworkPublishProgress }

/**
 * How much of git's chatter is worth keeping: enough for the panel's last few
 * lines, far short of the hundreds of redraws a meter emits.
 */
const MAX_PUBLISH_OUTPUT_LINES = 40

export type TeamworkServiceOptions = {
  store: ProjectSource
  /** The app's own data directory, where the private key goes: passed in so nothing here puts a secret beside a repository. */
  dataDir: string
  runner?: GitRunner
  now?: () => number
  /** The environment the relay override is read from, passed in so a test can say what this process sees. */
  env?: NodeJS.ProcessEnv
  /** Whether this project's `.teamree` is being watched. Absent means nothing is watching. */
  watching?: (projectId: string) => boolean
  /** Called once what is in `.teamree` has changed, so the workspace stream can say so. */
  onRosterChange?: () => void
  /** Where the relay project this build carries is; the default reads a packaged app's resources and the checkout. */
  relayDeploy?: () => RelaySetting['deploy']
  /** Called when a read finds only you on a roster, so origin is fetched for whoever joins next. */
  onAlone?: () => void
}

export class TeamworkService {
  readonly #store: ProjectSource
  readonly #dataDir: string
  readonly #runner: GitRunner
  readonly #now: () => number
  readonly #env: NodeJS.ProcessEnv
  readonly #watching: (projectId: string) => boolean
  readonly #onRosterChange: (() => void) | undefined
  readonly #relayDeploy: () => RelaySetting['deploy']
  readonly #onAlone: (() => void) | undefined
  /** Projects whose last roster read held only this installation's key. */
  readonly #alone = new Set<string>()
  /**
   * The roster as this service last read it, per project, so *any* read can be
   * the thing that notices a change. Only ever compared, never served.
   */
  readonly #lastRoster = new Map<string, string>()

  /**
   * The publish running for each project and what it has said, kept so a window
   * can ask while the call is still blocked and `cancelPublish` has something to
   * abort. A finished run stays until the next one for that project replaces it.
   */
  readonly #publishRuns = new Map<string, PublishRun>()

  constructor(options: TeamworkServiceOptions) {
    this.#store = options.store
    this.#dataDir = options.dataDir
    this.#runner = options.runner ?? createGitRunner()
    this.#now = options.now ?? Date.now
    this.#env = options.env ?? process.env
    this.#watching = options.watching ?? ((): boolean => false)
    this.#onRosterChange = options.onRosterChange
    this.#onAlone = options.onAlone
    this.#relayDeploy =
      options.relayDeploy ??
      ((): RelaySetting['deploy'] => shippedRelayCommand({ resourcesPath: process.resourcesPath, cwd: process.cwd() }))
  }

  async listMembers(params: ParamsOf<'members.list'>): Promise<MemberList> {
    const project = this.#project(params.projectId)
    const roster = await readRoster(project.path)
    // Belt and braces beside the watch on `.teamree`. Only a *change* is
    // announced, so the re-read this causes elsewhere finds the same roster and stops.
    this.#noteRoster(project.id, roster)
    const list = await this.#describe(project, roster)
    if (this.#alone.has(project.id)) this.#onAlone?.()
    const incoming = await this.#incoming(project.path, roster)
    return incoming.length === 0 ? list : { ...list, incoming }
  }

  /** The projects to fetch often: set up, and nobody else on the roster yet. */
  waitingProjects(): BaseFetchProject[] {
    return [...this.#alone]
      .map((projectId) => this.#store.getProject(projectId))
      .filter((project): project is Project => project !== undefined && project.fetchInBackground !== false)
      .map((project) => ({ id: project.id, path: project.path, baseRef: project.baseRef }))
  }

  /**
   * Fetches origin and fast-forwards the checkout when only `.teamree` changed, so a
   * teammate's key arrives without a pull. `moved` covers the remote ref moving too.
   */
  async refresh(projectId: string, options: { fetch?: boolean; signal?: AbortSignal } = {}): Promise<BaseFetchOutcome> {
    const project = this.#store.getProject(projectId)
    if (project === undefined || !(await this.#enrolled(project.path))) return 'skipped'
    const branch = await this.#branch(project.path)
    if (branch === null) return 'skipped'
    const remoteRef = `refs/remotes/origin/${branch}`
    const before = await this.#revParse(project.path, remoteRef)
    const caught = await this.#catchUp(project, branch, { incoming: 'teamree', replay: 'none' }, options)
    if (!caught.ok && caught.why === 'fetch') {
      return /no such remote|does not appear to be a git repository/i.test(caught.detail)
        ? 'skipped'
        : classifyFetchFailure(caught.detail)
    }
    const moved = (caught.ok && caught.moved) || (await this.#revParse(project.path, remoteRef)) !== before
    if (moved) this.#onRosterChange?.()
    return moved ? 'moved' : 'unchanged'
  }

  /** Brings the checkout's branch up to origin, rebuilding any unpushed commits on top. Never touches uncommitted work. */
  async pull(params: ParamsOf<'teamwork.pull'>): Promise<TeamworkPull> {
    const project = this.#project(params.projectId)
    const branch = await this.#branch(project.path)
    const answer = (fields: Omit<TeamworkPull, 'projectId'>): TeamworkPull => ({ projectId: project.id, ...fields })
    if (branch === null) return answer({ ok: false, moved: false, problem: 'Not on a branch', detail: null })
    const caught = await this.#catchUp(project, branch, { incoming: 'any', replay: 'all' })
    if (caught.ok) {
      if (caught.moved) this.#onRosterChange?.()
      return answer({ ok: true, moved: caught.moved, problem: null, detail: null })
    }
    return answer({ ok: false, moved: false, problem: pullProblem(caught, branch), detail: caught.detail || null })
  }

  async joinProject(params: ParamsOf<'members.join'>): Promise<MemberList> {
    const project = this.#project(params.projectId)
    const identity = await loadIdentity(this.#dataDir)
    const roster = await readRoster(project.path)

    // Already in, possibly under a handle chosen on another machine. Joining
    // twice is ordinary, and a second file for one key is the duplicate the reader refuses.
    if (roster.entries.some((entry) => entry.publicKey === identity.publicKey)) {
      return this.#describe(project, roster, identity)
    }

    const handle = resolveHandle({ override: params.handle, gitEmail: await this.#gitEmail(project.path) })
    if (handle === undefined) {
      throw badHandle(
        params.handle === undefined
          ? `git has no user.email configured in ${project.path}, so there is no name to file your key under; choose a handle`
          : `"${params.handle}" has nothing usable as a file name in it; choose another handle`
      )
    }

    const taken = roster.entries.find((entry) => entry.handle === handle)
    if (taken) {
      throw rosterConflict(`${taken.file} is already somebody else's key; choose another handle`)
    }

    await this.#writeMemberFile(project.path, {
      handle,
      publicKey: identity.publicKey,
      addedAt: isoDate(this.#now())
    })

    // Re-read rather than spliced in, so the caller gets what the next reader sees.
    const written = await readRoster(project.path)
    // Recorded and then announced unconditionally: a join is this app writing the file.
    this.#lastRoster.set(project.id, fingerprint(written))
    this.#onRosterChange?.()
    return this.#describe(project, written, identity)
  }

  /** Where this project's relay is recorded, and what each of the two places said. */
  async readRelay(params: ParamsOf<'teamwork.relay'>): Promise<RelaySetting> {
    return this.#describeRelay(this.#project(params.projectId))
  }

  /**
   * Writes the relay into the repository, beside the member keys. The same
   * bargain as joining: the app writes the file and stops.
   */
  async setRelay(params: ParamsOf<'teamwork.setRelay'>): Promise<RelaySetting> {
    const project = this.#project(params.projectId)
    const parsed = parseRelayUrl(params.url)
    if (!parsed.ok) throw badRelayUrl(`that is not a relay URL: ${parsed.reason}`)

    await writeRelayFile(project.path, parsed.url)
    // Said rather than left to the watch: the watch may be degraded, and the
    // links have to be rebuilt against a relay that moved either way.
    this.#onRosterChange?.()
    return this.#describeRelay(project)
  }

  /**
   * Points this checkout's `origin` at the remote everybody shares. A path is
   * stored normalised, so `git remote -v` and the hashed string are the same
   * characters. An existing remote is replaced rather than refused, and the
   * replacement is reported.
   */
  async setOrigin(params: ParamsOf<'teamwork.setOrigin'>): Promise<TeamworkOrigin> {
    const project = this.#project(params.projectId)
    const checked = checkOrigin(params.url)
    if (!checked.ok) throw badOriginUrl(`that is not an origin teamree can use: ${checked.reason}`)

    const existing = await this.#runner.tryRun({
      args: ['remote', 'get-url', 'origin'],
      cwd: project.path,
      readOnly: true
    })
    const replaced = existing.exitCode === 0
    const result = await this.#runner.tryRun({
      // `--` because an origin beginning with `-` is an option to git.
      // `checkOrigin` refuses that shape three calls away, which holds only
      // until somebody relaxes it. Both `remote add` and `remote set-url`
      // accept the separator (git 2.50.1).
      args: ['remote', replaced ? 'set-url' : 'add', '--', 'origin', checked.remote],
      cwd: project.path
    })
    if (result.exitCode !== 0) {
      // git's own words: every one of them names something only git knows.
      throw new TeamworkError(ErrorCode.GitFailed, result.stderr.trim() || `git exited ${result.exitCode}`)
    }

    // The status is cached against a stamp of git's config file, and this just
    // moved it; saying so is what makes the step go green without a restart.
    this.#onRosterChange?.()
    return { projectId: project.id, remote: 'origin', url: checked.remote, replaced }
  }

  /** What `publish` would do, so the button can say it before it does it. */
  async publishPlan(params: ParamsOf<'teamwork.publishPlan'>): Promise<TeamworkPublishPlan> {
    const project = this.#project(params.projectId)
    return readPublishPlan(this.#runner, await this.#publishTarget(project))
  }

  /** Stages the two files, commits them, and pushes. Never more than those files. */
  async publish(params: ParamsOf<'teamwork.publish'>): Promise<TeamworkPublish> {
    const project = this.#project(params.projectId)
    // Two at once would be two gits fighting over one index, and the second's
    // progress overwriting the first's in the record above.
    const running = this.#publishRuns.get(project.id)
    if (running !== undefined && running.progress.finishedAt === null) {
      throw new TeamworkError(ErrorCode.Conflict, 'a push is already running for this project')
    }

    const target = await this.#publishTarget(project)
    const run = this.#startRun(project.id)
    try {
      const result = await publish(this.#runner, {
        ...target,
        ...(params.message === undefined ? {} : { message: params.message }),
        signal: run.controller.signal,
        onPhase: (phase) => this.#notePhase(run, phase),
        onOutput: (line) => this.#noteOutput(run, line)
      })
      // The roster did not change, but what the repository holds did, and the
      // links are rebuilt against a relay that has just become the team's.
      this.#onRosterChange?.()
      return result
    } finally {
      run.progress.phase = 'finished'
      run.progress.finishedAt = this.#now()
      run.progress.cancelling = false
    }
  }

  /**
   * What the running publish is doing, or the last one did; null when this
   * project has never had one. A read rather than a stream: it lives ten seconds.
   */
  async publishProgress(params: ParamsOf<'teamwork.publishProgress'>): Promise<TeamworkPublishProgress | null> {
    const project = this.#project(params.projectId)
    const run = this.#publishRuns.get(project.id)
    if (run === undefined) return null
    return { ...run.progress, output: [...run.progress.output], readAt: this.#now() }
  }

  /**
   * Stops the publish that is running, if one is. The abort kills whichever git
   * is in front of it; a commit that landed stays, because throwing away
   * somebody's commit is the worse surprise.
   */
  async cancelPublish(params: ParamsOf<'teamwork.cancelPublish'>): Promise<{ cancelled: boolean }> {
    const project = this.#project(params.projectId)
    const run = this.#publishRuns.get(project.id)
    if (run === undefined || run.progress.finishedAt !== null) return { cancelled: false }
    run.progress.cancelling = true
    run.controller.abort()
    return { cancelled: true }
  }

  #startRun(projectId: string): PublishRun {
    const startedAt = this.#now()
    const run: PublishRun = {
      controller: new AbortController(),
      progress: {
        projectId,
        phase: 'staging',
        startedAt,
        lastOutputAt: startedAt,
        finishedAt: null,
        output: [],
        cancelling: false,
        readAt: startedAt
      }
    }
    this.#publishRuns.set(projectId, run)
    return run
  }

  #notePhase(run: PublishRun, phase: PublishPhase): void {
    run.progress.phase = phase
  }

  /** One line git printed. Only the tail is kept: a push prints its meter hundreds of times. */
  #noteOutput(run: PublishRun, line: string): void {
    run.progress.lastOutputAt = this.#now()
    run.progress.output.push(line)
    if (run.progress.output.length > MAX_PUBLISH_OUTPUT_LINES) {
      run.progress.output.splice(0, run.progress.output.length - MAX_PUBLISH_OUTPUT_LINES)
    }
  }

  /**
   * The two files teamwork writes, and the message that carries them. Named from
   * what is on disk: a pulled-in key is already committed, an environment relay is not a file.
   */
  async #publishTarget(project: Project): Promise<{
    projectId: string
    projectPath: string
    files: string[]
    message: string
  }> {
    const roster = await readRoster(project.path)
    const identity = await loadIdentity(this.#dataDir)
    const mine = roster.entries.find((entry) => entry.publicKey === identity.publicKey)?.file ?? null
    const relay = await readRelayFile(project.path)
    const theirs = relay.ok ? RELAY_FILE_NAME : null
    const files = [mine, theirs].filter((file): file is string => file !== null)
    return {
      projectId: project.id,
      projectPath: project.path,
      files,
      message: mine === null ? 'Meet on our relay' : theirs === null ? 'Add my key to the team' : 'Set up teamwork'
    }
  }

  #catchUp(
    project: Project,
    branch: string,
    scope: Parameters<typeof catchUp>[1]['scope'],
    options: { fetch?: boolean; signal?: AbortSignal } = {}
  ): Promise<CatchUp> {
    return sshCommand(this.#runner, project.path).then((ssh) =>
      catchUp(this.#runner, {
        cwd: project.path,
        remote: 'origin',
        branch,
        scope,
        env: { GIT_SSH_COMMAND: ssh },
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.signal === undefined ? {} : { signal: options.signal })
      })
    )
  }

  /** Member handles on origin's copy of this branch that the checkout has not pulled yet. */
  async #incoming(projectPath: string, roster: Roster): Promise<string[]> {
    const branch = await this.#branch(projectPath)
    if (branch === null) return []
    const ref = `refs/remotes/origin/${branch}`
    if ((await this.#revParse(projectPath, ref)) === null) return []
    const merged = await this.#runner.tryRun({
      args: ['merge-base', '--is-ancestor', ref, 'HEAD'],
      cwd: projectPath,
      readOnly: true
    })
    if (merged.exitCode === 0) return []
    const listed = await this.#runner.tryRun({
      args: ['ls-tree', '--name-only', ref, '--', `${membersDirectoryName}/`],
      cwd: projectPath,
      readOnly: true
    })
    if (listed.exitCode !== 0) return []
    const here = new Set([
      ...roster.entries.map((entry) => entry.file),
      ...roster.problems.map((problem) => problem.file)
    ])
    return listed.stdout
      .split('\n')
      .filter((file) => file.endsWith(MEMBER_FILE_SUFFIX) && !here.has(file))
      .map((file) => file.slice(membersDirectoryName.length + 1, -MEMBER_FILE_SUFFIX.length))
      .sort()
  }

  /** Only a checkout this installation has joined is ever moved in the background. */
  async #enrolled(projectPath: string): Promise<boolean> {
    const roster = await readRoster(projectPath)
    if (roster.entries.length === 0) return false
    const identity = await loadIdentity(this.#dataDir)
    return roster.entries.some((entry) => entry.publicKey === identity.publicKey)
  }

  async #branch(cwd: string): Promise<string | null> {
    const { exitCode, stdout } = await this.#runner.tryRun({
      args: ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      cwd,
      readOnly: true
    })
    return exitCode === 0 && stdout.trim() !== '' ? stdout.trim() : null
  }

  async #revParse(cwd: string, ref: string): Promise<string | null> {
    const { exitCode, stdout } = await this.#runner.tryRun({
      args: ['rev-parse', '--verify', '--quiet', ref],
      cwd,
      readOnly: true
    })
    return exitCode === 0 ? stdout.trim() : null
  }

  #project(projectId: string): Project {
    const project = this.#store.getProject(projectId)
    if (!project) throw notFound(`no project with id ${projectId}`)
    return project
  }

  /** Announces a roster that is not the one this service last saw, and only that. */
  #noteRoster(projectId: string, roster: Roster): void {
    const seen = this.#lastRoster.get(projectId)
    const now = fingerprint(roster)
    this.#lastRoster.set(projectId, now)
    if (seen === undefined || seen === now) return
    this.#onRosterChange?.()
  }

  async #describeRelay(project: Project): Promise<RelaySetting> {
    const file = await readRelayFile(project.path)
    const override = relayOverride(this.#env)
    const onDisk = { url: file.ok ? file.url : null, problem: file.ok ? null : file.reason }

    const effective = ((): Pick<RelaySetting, 'url' | 'source' | 'problem'> => {
      if (override === null) {
        return file.ok
          ? { url: file.url, source: 'repository', problem: null }
          : { url: null, source: null, problem: file.reason }
      }
      const parsed = parseRelayUrl(override)
      return parsed.ok
        ? { url: parsed.url, source: 'environment', problem: null }
        : { url: null, source: null, problem: `${RELAY_URL_ENV} is not a relay URL: ${parsed.reason}` }
    })()

    return {
      projectId: project.id,
      file: RELAY_FILE_NAME,
      ...effective,
      onDisk,
      override: { name: RELAY_URL_ENV, value: override },
      deploy: this.#relayDeploy(),
      readAt: this.#now()
    }
  }

  async #describe(project: Project, roster: Roster, known?: { publicKey: string }): Promise<MemberList> {
    const identity = known ?? (await loadIdentity(this.#dataDir))
    const mine = roster.entries.find((entry) => entry.publicKey === identity.publicKey)
    // The handle the roster already files this key under wins: a member who
    // renamed their file did so on purpose.
    const handle = mine?.handle ?? resolveHandle({ gitEmail: await this.#gitEmail(project.path) }) ?? null

    const self: MemberIdentity = { handle, publicKey: identity.publicKey }
    if (roster.entries.length === 1 && mine !== undefined) this.#alone.add(project.id)
    else this.#alone.delete(project.id)
    return {
      projectId: project.id,
      members: roster.entries.map((entry) => ({
        handle: entry.handle,
        publicKey: entry.publicKey,
        addedAt: entry.addedAt,
        file: entry.file,
        isSelf: entry.publicKey === identity.publicKey
      })),
      problems: roster.problems,
      self,
      selfFile: handle === null ? null : memberFileName(handle),
      enrolled: mine !== undefined,
      watched: this.#watching(project.id),
      readAt: this.#now()
    }
  }

  /** Exclusive, so a join can never overwrite a key already in the repository. */
  async #writeMemberFile(projectPath: string, content: Parameters<typeof formatMemberFile>[0]): Promise<void> {
    const target = memberFilePath(projectPath, content.handle)
    await mkdir(dirname(target), { recursive: true })
    try {
      const file = await open(target, 'wx')
      try {
        await file.writeFile(formatMemberFile(content), 'utf8')
      } finally {
        await file.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // The roster read said this key is not listed, yet the file is there: one
      // teamree cannot read, and rewriting it would throw away whatever it is.
      throw rosterConflict(
        `${memberFileName(content.handle)} already exists but teamree could not read it as a member; look at it before replacing it`
      )
    }
  }

  /** Undefined when git has no answer, which is ordinary on a fresh machine. */
  async #gitEmail(cwd: string): Promise<string | undefined> {
    try {
      const { exitCode, stdout } = await this.#runner.tryRun({
        args: ['config', '--get', 'user.email'],
        cwd,
        readOnly: true
      })
      if (exitCode !== 0) return undefined
      return stdout.trim() || undefined
    } catch {
      return undefined
    }
  }
}

/**
 * Enough of a roster to tell two reads of it apart. Problems included: a file
 * that stopped being readable is a member who has left the list.
 */
function fingerprint(roster: Roster): string {
  return JSON.stringify([
    roster.entries.map((entry) => [entry.file, entry.publicKey, entry.addedAt]),
    roster.problems.map((problem) => [problem.file, problem.reason])
  ])
}

/** A failed pull in one line; git's words go in `detail`. */
function pullProblem(caught: Extract<CatchUp, { ok: false }>, branch: string): string {
  const named = caught.paths.slice(0, 2).join(', ') + (caught.paths.length > 2 ? ` +${caught.paths.length - 2}` : '')
  switch (caught.why) {
    case 'conflict':
      return named === '' ? 'Conflict' : `Conflict in ${named}`
    case 'local':
      return named === '' ? 'Local changes are in the way' : `Local changes to ${named} are in the way`
    case 'fetch':
      return 'Fetch failed'
    case 'scope':
      return `${branch} has a merge origin does not · pull in Terminal`
  }
}

/** UTC, so two members added on the same day agree about which day that was. */
function isoDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10)
}
