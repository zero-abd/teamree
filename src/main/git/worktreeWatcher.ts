// Watching a worktree's files so git status stops going stale. Two watches per
// worktree: the checkout, and its git directory (a linked worktree's `.git` is a
// file pointing elsewhere). Emits one coarse `worktrees` invalidation, nothing finer.

import { readFileSync, statSync, watch as fsWatch } from 'node:fs'
import path from 'node:path'
import type { Worktree } from '../../shared/entities'

/** A quiet period long enough to swallow a save, short enough to feel live. */
export const DEFAULT_SETTLE_MS = 250

/** The floor between two reports; every report costs a `git status` per ready worktree. */
export const DEFAULT_MIN_INTERVAL_MS = 1_000

/**
 * Retry timing after a working-tree watch is lost. The usual cause is the 128
 * inotify-instance ceiling, which passes as soon as one editor or runner exits.
 */
export const DEFAULT_RETRY_FROM_MS = 2_000
export const DEFAULT_RETRY_UNTIL_MS = 60_000

const RETRY_BACKOFF = 4

/**
 * Directory names never worth a status read. Kept short: `dist`, `build`, `target`
 * are tracked in some repositories, and missing their changes is worse than a refetch.
 */
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules'])

/** Editor and tool droppings that are never part of a repository's status. */
function isTransientFile(name: string): boolean {
  return (
    name.endsWith('~') ||
    name.endsWith('.swp') ||
    name.endsWith('.swx') ||
    name.startsWith('.#') ||
    name === '.DS_Store' ||
    // vim's writability probe, created and removed in the same breath.
    name === '4913'
  )
}

/**
 * Whether a path reported under a checkout can be ignored outright. `relative` is
 * in the platform's separator, and null (the OS named nothing) counts as a change.
 */
export function ignoresCheckoutChange(relative: string | null): boolean {
  if (relative === null || relative === '') return false
  const segments = relative.split(/[\\/]/)
  const fileName = segments[segments.length - 1] as string
  if (segments.some((segment) => IGNORED_DIRECTORIES.has(segment))) return true
  return isTransientFile(fileName)
}

/**
 * The same for the git directory, the other way round: only entries that move a
 * status are let through, or `objects/` alone fires on every blob write.
 */
export function ignoresGitDirChange(relative: string | null): boolean {
  if (relative === null || relative === '') return false
  const segments = relative.split(/[\\/]/)
  const head = segments[0] as string
  // git renames `index.lock` over `index`; the rename is reported too, so the lock is noise.
  if (relative.endsWith('.lock')) return true
  if (head === 'refs' || head === 'logs') return false
  return !GIT_DIR_FILES.has(head)
}

const GIT_DIR_FILES = new Set([
  'index',
  'HEAD',
  'ORIG_HEAD',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'REBASE_HEAD',
  'packed-refs'
])

export type WatchHandle = { close: () => void }

/**
 * The seam every test drives instead of the filesystem. `recursive` is a request:
 * an implementation that cannot honour it reports an error, reaching degraded mode.
 */
export type WatchFn = (options: {
  target: string
  recursive: boolean
  onChange: (relative: string | null) => void
  onError: (error: unknown) => void
}) => WatchHandle

/**
 * A worktree that has dropped to watching its git directory alone, and why. Not
 * an error: commits still show, but edits no longer move anything until committed.
 */
export type WatchDegraded = {
  worktreeId: string
  checkoutPath: string
  error: unknown
}

export type WorktreeWatcherOptions = {
  /** Called once per settled burst. Always the same coarse invalidation. */
  onChange: () => void
  watch?: WatchFn
  settleMs?: number
  minIntervalMs?: number
  /** Reported, never thrown: a watch that cannot be set up degrades instead. */
  onError?: (error: unknown) => void
  /** Called once per worktree that loses its working-tree watch. Defaults to reporting, never silence. */
  onDegraded?: (event: WatchDegraded) => void
  now?: () => number
  schedule?: (run: () => void, delayMs: number) => () => void
  /** The retry timer, kept apart from `schedule` so a test can drive each independently. */
  retry?: (run: () => void, delayMs: number) => () => void
  retryFromMs?: number
  retryUntilMs?: number
  /** Overridable so a test need not lay down a real `.git` file. */
  resolveGitDir?: (checkoutPath: string) => string | undefined
}

/** What a lost working-tree watch means, in terms somebody could act on. */
export function degradedWatchReport(event: WatchDegraded): string {
  const code = (event.error as NodeJS.ErrnoException | null)?.code
  const cause =
    // inotify_init reports the instance ceiling as EMFILE and the watch ceiling as ENOSPC.
    code === 'EMFILE' || code === 'ENOSPC'
      ? `this machine has no filesystem watches left to give (${code})`
      : `the filesystem refused a recursive watch${code ? ` (${code})` : ''}`
  return (
    `live status for ${event.checkoutPath} is degraded: ${cause}. ` +
    'Commits and staged changes still show; edits will not, until something commits.'
  )
}

type WatchedWorktree = {
  path: string
  handles: WatchHandle[]
  /** False when the recursive watch failed and only the git dir is covered. */
  watchesWorkingTree: boolean
}

/**
 * Keeps one set of filesystem watches in step with the set of ready worktrees.
 * `sync` takes the whole list and works out the difference; nothing is incremental.
 */
export class WorktreeWatcher {
  readonly #watched = new Map<string, WatchedWorktree>()
  readonly #onChange: () => void
  readonly #watch: WatchFn
  readonly #settleMs: number
  readonly #minIntervalMs: number
  readonly #onError: (error: unknown) => void
  readonly #onDegraded: (event: WatchDegraded) => void
  readonly #now: () => number
  readonly #schedule: (run: () => void, delayMs: number) => () => void
  readonly #resolveGitDir: (checkoutPath: string) => string | undefined
  readonly #retry: (run: () => void, delayMs: number) => () => void
  readonly #retryFromMs: number
  readonly #retryUntilMs: number
  /** Worktrees already reported degraded; the retries behind it are not worth a line each. */
  readonly #reported = new Set<string>()

  #cancelRetry: (() => void) | undefined
  #retryDelayMs: number
  #cancelPending: (() => void) | undefined
  /** Undefined until the first report, so the very first change is not held. */
  #lastReportAt: number | undefined
  #closed = false

  constructor(options: WorktreeWatcherOptions) {
    this.#onChange = options.onChange
    this.#watch = options.watch ?? nodeWatch
    this.#settleMs = options.settleMs ?? DEFAULT_SETTLE_MS
    this.#minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
    this.#onError = options.onError ?? ((error) => console.warn('[worktrees]', error))
    this.#onDegraded = options.onDegraded ?? ((event) => console.warn('[worktrees]', degradedWatchReport(event)))
    this.#now = options.now ?? Date.now
    this.#schedule = options.schedule ?? scheduleWithTimeout
    this.#resolveGitDir = options.resolveGitDir ?? resolveGitDir
    this.#retry = options.retry ?? scheduleWithTimeout
    this.#retryFromMs = options.retryFromMs ?? DEFAULT_RETRY_FROM_MS
    this.#retryUntilMs = options.retryUntilMs ?? DEFAULT_RETRY_UNTIL_MS
    this.#retryDelayMs = this.#retryFromMs
  }

  /** Worktree ids currently covered, for tests and for the status line. */
  get watchedIds(): string[] {
    return [...this.#watched.keys()]
  }

  /** Those covered by their git directory alone, which is a weaker promise. */
  get degradedIds(): string[] {
    return [...this.#watched].filter(([, watched]) => !watched.watchesWorkingTree).map(([id]) => id)
  }

  /** True when this worktree's working tree is covered, not just its git dir. */
  watchesWorkingTree(worktreeId: string): boolean {
    return this.#watched.get(worktreeId)?.watchesWorkingTree ?? false
  }

  /** Brings the watch set in line with `worktrees`. Only `ready` ones have a checkout to watch. */
  sync(worktrees: readonly Worktree[]): void {
    if (this.#closed) return
    const wanted = new Map(
      worktrees.filter((worktree) => worktree.state === 'ready').map((worktree) => [worktree.id, worktree])
    )

    for (const [id, watched] of this.#watched) {
      const worktree = wanted.get(id)
      // A moved checkout is a different thing to watch under the same id.
      if (worktree && worktree.path === watched.path) continue
      this.#stopWatching(id)
    }

    for (const id of this.#reported) {
      if (!wanted.has(id)) this.#reported.delete(id)
    }

    for (const [id, worktree] of wanted) {
      const watched = this.#watched.get(id)
      if (watched === undefined) {
        this.#startWatching(id, worktree.path)
        continue
      }
      // `continue` on any entry was the bug: a worktree refused a recursive watch
      // once was never looked at again, long after the inotify instances came back.
      if (!watched.watchesWorkingTree) this.#attachWorkingTree(id, watched)
    }
    this.#armRetry(false)
  }

  /** Drops every watch and any pending report. */
  close(): void {
    this.#closed = true
    for (const id of [...this.#watched.keys()]) this.#stopWatching(id)
    this.#cancelPending?.()
    this.#cancelPending = undefined
    this.#cancelRetry?.()
    this.#cancelRetry = undefined
    this.#reported.clear()
  }

  #startWatching(id: string, checkoutPath: string): void {
    const watched: WatchedWorktree = { path: checkoutPath, handles: [], watchesWorkingTree: false }
    this.#attachWorkingTree(id, watched)

    const gitDir = this.#resolveGitDir(checkoutPath)
    if (gitDir !== undefined) {
      try {
        watched.handles.push(
          this.#watch({
            target: gitDir,
            recursive: true,
            onChange: (relative) => {
              if (!ignoresGitDirChange(relative)) this.#report()
            },
            onError: (error) => this.#onError(error)
          })
        )
      } catch (error) {
        this.#onError(error)
      }
    }

    // Nothing could be watched at all: record nothing, so a later sync retries.
    if (watched.handles.length === 0) return
    this.#watched.set(id, watched)
  }

  /**
   * Asks for the recursive working-tree watch. Additive: this runs on the retry
   * path too, and tearing the entry down first would drop the git directory watch.
   */
  #attachWorkingTree(id: string, watched: WatchedWorktree): void {
    try {
      watched.handles.push(
        this.#watch({
          target: watched.path,
          recursive: true,
          onChange: (relative) => {
            if (!ignoresCheckoutChange(relative)) this.#report()
          },
          // A recursive watch can fail well after setup (inotify runs out while the app runs).
          onError: (error) => this.#degrade(id, error)
        })
      )
      watched.watchesWorkingTree = true
      // Coming back from degraded is itself news: what is on screen is as old as the outage.
      if (this.#reported.delete(id)) this.#report()
    } catch (error) {
      // Recursive watching is unavailable on some filesystems and exhaustible on
      // any. The git directory alone still catches staged changes and commits.
      this.#reportDegraded({ worktreeId: id, checkoutPath: watched.path, error })
    }
  }

  #stopWatching(id: string): void {
    const watched = this.#watched.get(id)
    if (!watched) return
    this.#watched.delete(id)
    for (const handle of watched.handles) {
      try {
        handle.close()
      } catch {
        // Closing a watch whose directory has already gone is routine.
      }
    }
  }

  /** A recursive watch that died mid-flight leaves the rest of its watches up. */
  #degrade(id: string, error: unknown): void {
    const watched = this.#watched.get(id)
    // Said once: a dying inotify watch can report repeatedly.
    if (!watched || !watched.watchesWorkingTree) return
    watched.watchesWorkingTree = false
    this.#reportDegraded({ worktreeId: id, checkoutPath: watched.path, error })
    // Nothing else will call `sync` to arm a retry: the watch set moves on git events.
    this.#armRetry(true)
  }

  /** Said once per worktree, however many times the retry behind it fails. */
  #reportDegraded(event: WatchDegraded): void {
    if (this.#reported.has(event.worktreeId)) return
    this.#reported.add(event.worktreeId)
    this.#onDegraded(event)
  }

  /**
   * Puts the next recovery attempt on the clock while there is anything to recover.
   * `fromStart` resets the backoff when the degraded set has just changed.
   */
  #armRetry(fromStart: boolean): void {
    if (this.#closed) return
    if (this.degradedIds.length === 0) {
      this.#cancelRetry?.()
      this.#cancelRetry = undefined
      this.#retryDelayMs = this.#retryFromMs
      return
    }
    if (fromStart) this.#retryDelayMs = this.#retryFromMs
    else if (this.#cancelRetry) return
    this.#cancelRetry?.()
    this.#cancelRetry = this.#retry(
      () => {
        this.#cancelRetry = undefined
        this.#retryNow()
      },
      this.#retryDelayMs
    )
  }

  /** Asks again for every working-tree watch that is missing. */
  #retryNow(): void {
    if (this.#closed) return
    this.#retryDelayMs = Math.min(this.#retryDelayMs * RETRY_BACKOFF, this.#retryUntilMs)
    for (const [id, watched] of this.#watched) {
      if (watched.watchesWorkingTree) continue
      this.#attachWorkingTree(id, watched)
    }
    this.#armRetry(false)
  }

  /**
   * Collapses a burst into one report: the settle window, pushed out to respect
   * the minimum interval, so continuous change reports on a steady beat.
   */
  #report(): void {
    if (this.#closed || this.#cancelPending) return
    const delay =
      this.#lastReportAt === undefined
        ? this.#settleMs
        : Math.max(this.#settleMs, this.#lastReportAt + this.#minIntervalMs - this.#now())
    this.#cancelPending = this.#schedule(() => {
      this.#cancelPending = undefined
      this.#lastReportAt = this.#now()
      this.#onChange()
    }, delay)
  }
}

/** Where a checkout's git directory is; for a linked worktree `.git` is a pointer file. */
export function resolveGitDir(checkoutPath: string): string | undefined {
  const dotGit = path.join(checkoutPath, '.git')
  try {
    if (statSync(dotGit).isDirectory()) return dotGit
    const pointer = readFileSync(dotGit, 'utf8').trim()
    const match = /^gitdir:\s*(.+)$/.exec(pointer)
    if (!match) return undefined
    const target = (match[1] as string).trim()
    return path.isAbsolute(target) ? target : path.resolve(checkoutPath, target)
  } catch {
    return undefined
  }
}

function nodeWatch(options: Parameters<WatchFn>[0]): WatchHandle {
  if (options.recursive) assertRecursiveWatchIsPossible(options.target)
  const watcher = fsWatch(
    options.target,
    // Never the reason a process stays alive: quitting must not wait on a file watch.
    { recursive: options.recursive, persistent: false },
    (_event, fileName) => options.onChange(typeof fileName === 'string' ? fileName : null)
  )
  watcher.on('error', options.onError)
  return { close: () => watcher.close() }
}

/**
 * On Linux `recursive: true` is Node's own walker, and with no inotify instance
 * left it comes back looking healthy and never fires (measured at the 128 ceiling).
 * The same request non-recursively fails loudly with EMFILE, so it is asked first.
 */
function assertRecursiveWatchIsPossible(target: string): void {
  fsWatch(target, { persistent: false }, () => {}).close()
}

function scheduleWithTimeout(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}
