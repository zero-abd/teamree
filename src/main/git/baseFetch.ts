// Keeps each project's base ref current, so `behind` and the merge preview are about
// the remote as it is now: one branch fetched on a timer and on window focus.

import type { GitRunner } from './gitProcess'
import { assertRefShape } from './repository'
import { pushFailureKind } from './worktreePush'

export type BaseFetchOutcome = 'moved' | 'unchanged' | 'skipped' | 'offline' | 'auth' | 'failed'

export type BaseFetchProject = { id: string; path: string; baseRef: string }

const FETCH_TIMEOUT_MS = 60_000
export const DEFAULT_INTERVAL_MS = 5 * 60_000
/** Focusing the window twice in a minute is not news from the remote. */
export const DEFAULT_FOCUS_FLOOR_MS = 60_000
const FIRST_FETCH_DELAY_MS = 5_000
const AUTH_BACKOFF_FROM_MS = 30 * 60_000
const AUTH_BACKOFF_UNTIL_MS = 8 * 60 * 60_000

const OFFLINE =
  /could not resolve host|network is unreachable|no route to host|connection (timed out|refused)|operation timed out|failed to connect to|name resolution/i

/** Why a fetch failed, as far as backing off is concerned. */
export function classifyFetchFailure(stderr: string): 'auth' | 'offline' | 'failed' {
  if (OFFLINE.test(stderr)) return 'offline'
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
  const fetched = await runner.tryRun({
    args: ['fetch', '--no-tags', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
    cwd: repoPath,
    timeoutMs: FETCH_TIMEOUT_MS,
    // The runner already disables the terminal prompt; an inherited askpass would still open a window.
    env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' },
    signal
  })
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

export type BaseFetcherOptions = {
  runner: GitRunner
  /** The projects worth fetching for: those with a worktree to be behind. */
  projects: () => readonly BaseFetchProject[]
  onMoved: (projectId: string) => void
  /** False skips the cycle; `net.isOnline` in the app. */
  online?: () => boolean
  intervalMs?: number
  focusFloorMs?: number
  now?: () => number
  schedule?: (run: () => void, delayMs: number) => () => void
  onError?: (error: unknown) => void
}

type ProjectState = { lastAttemptAt: number; retryAfter: number; authBackoffMs: number }

/** One fetch of each project's base at a time, on a timer and on focus; a refused sign-in waits hours, not minutes. */
export class BaseFetcher {
  readonly #options: BaseFetcherOptions
  readonly #now: () => number
  readonly #state = new Map<string, ProjectState>()
  #running: Promise<void> | null = null
  #cancelTimer: (() => void) | undefined
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
      this.#cancelTimer = schedule(tick, this.#options.intervalMs ?? DEFAULT_INTERVAL_MS)
      void this.fetchNow()
    }
    // Soon after launch as well: the window may open in the background and never be focused.
    this.#cancelTimer = schedule(tick, FIRST_FETCH_DELAY_MS)
  }

  stop(): void {
    this.#stopped = true
    this.#cancelTimer?.()
    this.#cancelTimer = undefined
    this.#controller.abort()
  }

  /** Window focus: fetches the projects not tried in the last minute. */
  nudge(): Promise<void> {
    return this.#run(this.#options.focusFloorMs ?? DEFAULT_FOCUS_FLOOR_MS)
  }

  fetchNow(): Promise<void> {
    return this.#run(0)
  }

  /** Resolves once the fetch in flight, if any, is done. */
  async idle(): Promise<void> {
    await this.#running
  }

  #run(floorMs: number): Promise<void> {
    if (this.#stopped) return Promise.resolve()
    if (this.#running) return this.#running
    this.#running = this.#cycle(floorMs)
      .catch((error: unknown) => (this.#options.onError ?? console.warn)(error))
      .finally(() => {
        this.#running = null
      })
    return this.#running
  }

  async #cycle(floorMs: number): Promise<void> {
    if (this.#options.online?.() === false) return
    const projects = this.#options.projects()
    const live = new Set(projects.map((project) => project.id))
    for (const id of this.#state.keys()) if (!live.has(id)) this.#state.delete(id)

    for (const project of projects) {
      if (this.#stopped) return
      const now = this.#now()
      const state = this.#state.get(project.id) ?? { lastAttemptAt: -Infinity, retryAfter: 0, authBackoffMs: 0 }
      if (now < state.retryAfter || now - state.lastAttemptAt < floorMs) continue
      state.lastAttemptAt = now
      this.#state.set(project.id, state)

      const outcome = await fetchBase(this.#options.runner, {
        repoPath: project.path,
        baseRef: project.baseRef,
        signal: this.#controller.signal
      }).catch(() => 'failed' as const)
      if (outcome === 'auth') {
        state.authBackoffMs = Math.min(
          state.authBackoffMs === 0 ? AUTH_BACKOFF_FROM_MS : state.authBackoffMs * 2,
          AUTH_BACKOFF_UNTIL_MS
        )
        state.retryAfter = now + state.authBackoffMs
        continue
      }
      if (outcome === 'moved' || outcome === 'unchanged') state.authBackoffMs = 0
      if (outcome === 'moved' && !this.#stopped) this.#options.onMoved(project.id)
    }
  }
}

function scheduleWithTimeout(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}
