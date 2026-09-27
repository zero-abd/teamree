// Keeps each project's base ref current, so `behind` and the merge preview are about
// the remote as it is now: one branch fetched on a timer and on window focus.

import type { BaseFetchFailure, BaseFetchState, Project, Worktree } from '../../shared/entities'
import { GitCommandError } from './errors'
import type { GitRunner } from './gitProcess'
import { assertRefShape } from './repository'
import { pushFailureKind } from './worktreePush'

/** `timeout`: git was killed at the limit, most likely a credential helper waiting on a dialog. */
export type BaseFetchOutcome = 'moved' | 'unchanged' | 'skipped' | BaseFetchFailure

export type BaseFetchProject = { id: string; path: string; baseRef: string }

const FETCH_TIMEOUT_MS = 60_000
export const DEFAULT_INTERVAL_MS = 5 * 60_000
/** Focusing the window twice in a minute is not news from the remote. */
export const DEFAULT_FOCUS_FLOOR_MS = 60_000
const FIRST_FETCH_DELAY_MS = 5_000
const AUTH_BACKOFF_FROM_MS = 30 * 60_000
const AUTH_BACKOFF_UNTIL_MS = 60 * 60_000
/** How often `online` is read for the network coming back. */
export const ONLINE_POLL_MS = 10_000
/** After the network comes back, time for DNS and the VPN to settle before fetching. */
export const RECONNECT_DELAY_MS = 3_000

const OFFLINE =
  /could not resolve host|network is unreachable|no route to host|connection (timed out|refused)|operation timed out|failed to connect to|name resolution/i

// Before sign-in: a local path that is gone also says "Could not read from remote repository".
const NOT_FOUND = /couldn't find remote ref|does not appear to be a git repository/i

/** Why a fetch failed. */
export function classifyFetchFailure(stderr: string): 'auth' | 'offline' | 'not-found' | 'failed' {
  if (OFFLINE.test(stderr)) return 'offline'
  if (NOT_FOUND.test(stderr)) return 'not-found'
  const kind = pushFailureKind(stderr)
  return kind === 'auth' || kind === 'host-key' ? 'auth' : 'failed'
}

/**
 * Fetches the one branch `baseRef` names from its remote. Never prompts: a credential
 * git would have to ask for fails the fetch instead.
 */
export async function fetchBase(
  runner: GitRunner,
  options: { repoPath: string; baseRef: string; signal?: AbortSignal }
): Promise<BaseFetchOutcome> {
  const { repoPath, baseRef, signal } = options
  const slash = baseRef.indexOf('/')
  if (slash <= 0 || !usableRef(baseRef)) return 'skipped'
  const remote = baseRef.slice(0, slash)
  const branch = baseRef.slice(slash + 1)
  const remotes = await runner.tryRun({ args: ['remote'], cwd: repoPath, readOnly: true, signal })
  if (remotes.exitCode !== 0 || !remotes.stdout.split('\n').includes(remote)) return 'skipped'

  const before = await revParse(runner, repoPath, baseRef, signal)
  let fetched
  try {
    fetched = await runner.tryRun({
      args: ['fetch', '--no-tags', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
      cwd: repoPath,
      timeoutMs: FETCH_TIMEOUT_MS,
      // The runner already disables the terminal prompt; an inherited askpass would still open a window.
      env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' },
      signal
    })
  } catch (error) {
    if (error instanceof GitCommandError && error.timedOut) return 'timeout'
    throw error
  }
  if (fetched.exitCode !== 0) return classifyFetchFailure(fetched.stderr)
  return (await revParse(runner, repoPath, baseRef, signal)) === before ? 'unchanged' : 'moved'
}

function usableRef(ref: string): boolean {
  try {
    assertRefShape(ref, 'base ref')
    return true
  } catch {
    return false
  }
}

async function revParse(runner: GitRunner, cwd: string, ref: string, signal?: AbortSignal): Promise<string> {
  const result = await runner.tryRun({
    args: ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
    cwd,
    readOnly: true,
    signal
  })
  return result.exitCode === 0 ? result.stdout.trim() : ''
}

/** Projects with a ready worktree to be behind, less those with background fetching turned off. */
export function backgroundFetchProjects(snapshot: {
  projects: readonly Project[]
  worktrees: readonly Pick<Worktree, 'projectId' | 'state'>[]
}): BaseFetchProject[] {
  const working = new Set(snapshot.worktrees.filter((w) => w.state === 'ready').map((w) => w.projectId))
  return snapshot.projects
    .filter((project) => working.has(project.id) && project.fetchInBackground !== false)
    .map((project) => ({ id: project.id, path: project.path, baseRef: project.baseRef }))
}

export type BaseFetcherOptions = {
  runner: GitRunner
  /** The projects worth fetching for: those with a worktree to be behind. */
  projects: () => readonly BaseFetchProject[]
  onMoved: (projectId: string) => void
  /** What one fetch of a project is; `fetchBase` by default. */
  fetch?: (project: BaseFetchProject, signal: AbortSignal) => Promise<BaseFetchOutcome>
  /** False skips the cycle; `net.isOnline` in the app. */
  online?: () => boolean
  /** Read before each wait, so a changed setting takes effect with `reschedule`. */
  intervalMs?: number | (() => number)
  focusFloorMs?: number
  now?: () => number
  schedule?: (run: () => void, delayMs: number) => () => void
  onError?: (error: unknown) => void
  /** Hears each project's state after every attempt. */
  onState?: (projectId: string, state: BaseFetchState) => void
  /** A fetch before this launch, asked once a failure has none to show; when the base ref last moved, by default. */
  lastFetchedAt?: (project: BaseFetchProject) => Promise<number | undefined>
}

type ProjectState = {
  lastAttemptAt: number
  retryAfter: number
  authBackoffMs: number
  fetchedAt?: number
  failure?: BaseFetchFailure
  asked?: boolean
}

/** One fetch of each project's base at a time, on a timer, on focus and when the network returns; a refused sign-in waits up to an hour. */
export class BaseFetcher {
  readonly #options: BaseFetcherOptions
  readonly #now: () => number
  readonly #state = new Map<string, ProjectState>()
  #running: Promise<void> | null = null
  #tail: Promise<unknown> = Promise.resolve()
  #cancelTimer: (() => void) | undefined
  #tick: (() => void) | undefined
  #waitingMs: number | undefined
  #cancelWatch: (() => void) | undefined
  #cancelReconnect: (() => void) | undefined
  #wasOffline = false
  #stopped = false
  readonly #controller = new AbortController()

  constructor(options: BaseFetcherOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
  }

  /** Arms the timer; nothing reaches the network before this. */
  start(): void {
    if (this.#stopped || this.#cancelTimer) return
    const schedule = this.#options.schedule ?? scheduleWithTimeout
    const tick = (): void => {
      this.#wait(tick)
      void this.fetchNow()
    }
    this.#tick = tick
    // Soon after launch as well: the window may open in the background and never be focused.
    this.#cancelTimer = schedule(tick, FIRST_FETCH_DELAY_MS)
    const online = this.#options.online
    if (online === undefined) return
    // `net` has no event for it, so the network coming back is noticed by asking.
    const watch = (): void => {
      this.#cancelWatch = schedule(watch, ONLINE_POLL_MS)
      const up = online()
      if (up && this.#wasOffline) this.#cancelReconnect = schedule(() => this.#reconnected(), RECONNECT_DELAY_MS)
      this.#wasOffline = !up
    }
    this.#cancelWatch = schedule(watch, ONLINE_POLL_MS)
  }

  /** Starts the next timed wait again when the interval has changed since it began. */
  reschedule(): void {
    if (this.#stopped || this.#tick === undefined || this.#waitingMs === undefined) return
    if (this.#interval() === this.#waitingMs) return
    this.#cancelTimer?.()
    this.#wait(this.#tick)
  }

  #interval(): number {
    const interval = this.#options.intervalMs
    return typeof interval === 'function' ? interval() : (interval ?? DEFAULT_INTERVAL_MS)
  }

  #wait(tick: () => void): void {
    this.#waitingMs = this.#interval()
    this.#cancelTimer = (this.#options.schedule ?? scheduleWithTimeout)(tick, this.#waitingMs)
  }

  stop(): void {
    this.#stopped = true
    for (const cancel of [this.#cancelTimer, this.#cancelWatch, this.#cancelReconnect]) cancel?.()
    this.#cancelTimer = undefined
    this.#controller.abort()
  }

  /** True between `start()` and `stop()`. */
  get armed(): boolean {
    return this.#cancelTimer !== undefined
  }

  /** Window focus: fetches the projects not tried in the last minute. */
  nudge(): Promise<void> {
    return this.#run(this.#options.focusFloorMs ?? DEFAULT_FOCUS_FLOOR_MS)
  }

  fetchNow(): Promise<void> {
    return this.#run(0)
  }

  /** Fetch Now for one project: at once, through any back-off, whether or not the timer covers it. */
  fetchProject(project: BaseFetchProject): Promise<BaseFetchState> {
    return this.#serial(async () => {
      const state = this.#stateOf(project.id)
      state.authBackoffMs = 0
      state.retryAfter = 0
      await this.#attempt(project, state)
      return this.#public(state)
    })
  }

  /** Resolves once the fetches in flight, if any, are done. */
  async idle(): Promise<void> {
    await this.#tail
  }

  #run(floorMs: number): Promise<void> {
    if (this.#stopped) return Promise.resolve()
    if (this.#running) return this.#running
    this.#running = this.#serial(() => this.#cycle(floorMs))
      .catch((error: unknown) => (this.#options.onError ?? console.warn)(error))
      .finally(() => {
        this.#running = null
      })
    return this.#running
  }

  // Fetch Now and the timer take turns: two fetches of one ref race for its lock.
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(work, work)
    this.#tail = run.catch(() => undefined)
    return run
  }

  #stateOf(projectId: string): ProjectState {
    let state = this.#state.get(projectId)
    if (state === undefined) {
      state = { lastAttemptAt: -Infinity, retryAfter: 0, authBackoffMs: 0 }
      this.#state.set(projectId, state)
    }
    return state
  }

  async #cycle(floorMs: number): Promise<void> {
    const projects = this.#options.projects()
    const live = new Set(projects.map((project) => project.id))
    for (const id of this.#state.keys()) if (!live.has(id)) this.#state.delete(id)

    if (this.#options.online?.() === false) {
      // Said now, rather than an hour on when the last fetch starts to look old.
      for (const project of projects) {
        const state = this.#stateOf(project.id)
        if (state.failure === 'offline') continue
        state.failure = 'offline'
        await this.#report(project, state)
      }
      return
    }

    for (const project of projects) {
      if (this.#stopped) return
      const state = this.#stateOf(project.id)
      const now = this.#now()
      if (now < state.retryAfter || now - state.lastAttemptAt < floorMs) continue
      await this.#attempt(project, state)
    }
  }

  async #attempt(project: BaseFetchProject, state: ProjectState): Promise<void> {
    const now = this.#now()
    state.lastAttemptAt = now
    const signal = this.#controller.signal
    const fetch =
      this.#options.fetch ??
      ((): Promise<BaseFetchOutcome> =>
        fetchBase(this.#options.runner, { repoPath: project.path, baseRef: project.baseRef, signal }))
    const outcome = await fetch(project, signal).catch(() => 'failed' as const)
    if (outcome === 'skipped') return
    if (outcome === 'moved' || outcome === 'unchanged') {
      state.authBackoffMs = 0
      state.fetchedAt = this.#now()
      delete state.failure
    } else {
      state.failure = outcome
      if (outcome === 'auth' || outcome === 'timeout') {
        state.authBackoffMs = Math.min(
          state.authBackoffMs === 0 ? AUTH_BACKOFF_FROM_MS : state.authBackoffMs * 2,
          AUTH_BACKOFF_UNTIL_MS
        )
        state.retryAfter = now + state.authBackoffMs
      }
    }
    await this.#report(project, state)
    if (outcome === 'moved' && !this.#stopped) this.#options.onMoved(project.id)
  }

  async #report(project: BaseFetchProject, state: ProjectState): Promise<void> {
    const onState = this.#options.onState
    if (onState === undefined) return
    if (state.failure !== undefined && state.fetchedAt === undefined && state.asked !== true) {
      state.asked = true
      const ask = this.#options.lastFetchedAt ?? ((target) => lastMoved(this.#options.runner, target))
      const at = await ask(project).catch(() => undefined)
      if (at !== undefined && state.fetchedAt === undefined) state.fetchedAt = at
    }
    onState(project.id, this.#public(state))
  }

  #public(state: ProjectState): BaseFetchState {
    return {
      ...(state.fetchedAt === undefined ? {} : { fetchedAt: state.fetchedAt }),
      ...(state.failure === undefined ? {} : { failure: state.failure }),
      ...(state.retryAfter > this.#now() ? { retryAt: state.retryAfter } : {})
    }
  }

  // Back online: what failed for want of a network is tried now, not at the next tick.
  #reconnected(): void {
    for (const state of this.#state.values()) {
      if (state.failure === 'offline' || state.failure === 'timeout') state.retryAfter = 0
    }
    void this.fetchNow()
  }
}

// From the ref's reflog, never FETCH_HEAD: a fetch that fails rewrites that too. Never later than the last fetch.
async function lastMoved(runner: GitRunner, project: BaseFetchProject): Promise<number | undefined> {
  const log = await runner.tryRun({
    // `%gd` is the entry's own time; `%ct` would be the commit's.
    args: ['log', '-g', '-n', '1', '--date=unix', '--format=%gd', `refs/remotes/${project.baseRef}`, '--'],
    cwd: project.path,
    readOnly: true
  })
  const seconds = Number(/@\{(\d+)\}/.exec(log.stdout)?.[1])
  return log.exitCode === 0 && seconds > 0 ? seconds * 1000 : undefined
}

function scheduleWithTimeout(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}
