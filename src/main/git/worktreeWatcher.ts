// Watching a worktree's files so git status stops going stale.
//
// Status used to be re-read only when a shell started or exited, which covers
// command boundaries and nothing else: edit a file in an editor, or run a build
// that leaves artifacts, and the chips in the sidebar kept describing a repo
// that had moved on. Nothing corrected them until the shell ended, which during
// a long-running agent session is never.
//
// Two places are watched per worktree, because one is not enough:
//
//   - the checkout, recursively, which is where the working tree changes that
//     move `unstaged` and `untracked` happen;
//   - the worktree's git directory, where `index` and `HEAD` live, which is how
//     `git add`, `git commit` and a branch switch announce themselves. A linked
//     worktree's `.git` is a *file* pointing elsewhere, so the recursive watch
//     over the checkout never sees any of it.
//
// What comes back out is deliberately not "this file changed". It is one coarse
// `worktrees` invalidation, the same one every other producer emits, because a
// client that refetches cannot drift out of sync with the runtime. The value
// here is purely in the timing.

import { readFileSync, statSync, watch as fsWatch } from 'node:fs'
import path from 'node:path'
import type { Worktree } from '../../shared/entities'

/** A quiet period long enough to swallow a save, short enough to feel live. */
export const DEFAULT_SETTLE_MS = 250

/**
 * The floor between two reports, however busy the tree is. A build or an
 * `npm install` writes thousands of files, and every report costs a
 * `git status` per ready worktree; this is what keeps that bounded.
 */
export const DEFAULT_MIN_INTERVAL_MS = 1_000

/**
 * Directory names never worth a status read. Kept deliberately short: anything
 * on this list is invisible to the watcher, so a name that only *usually*
 * carries ignored files — `dist`, `build`, `target` — does not belong on it.
 * Those are tracked in some repositories, and silently missing their changes
 * would be worse than the refetch they cost.
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
 * Whether a path reported under a checkout can be ignored outright. `relative`
 * arrives in the platform's own separator, and can be null when the OS reports
 * a change without naming it — which has to count as a change, since the one
 * thing we know is that something happened.
 */
export function ignoresCheckoutChange(relative: string | null): boolean {
  if (relative === null || relative === '') return false
  const segments = relative.split(/[\\/]/)
  const fileName = segments[segments.length - 1] as string
  if (segments.some((segment) => IGNORED_DIRECTORIES.has(segment))) return true
  return isTransientFile(fileName)
}

/**
 * The same question for the git directory, answered the other way round: almost
 * everything in there is churn, so only the handful of entries that actually
 * move a status are let through. `objects/` alone would otherwise fire on every
 * write of every blob.
 */
export function ignoresGitDirChange(relative: string | null): boolean {
  if (relative === null || relative === '') return false
  const segments = relative.split(/[\\/]/)
  const head = segments[0] as string
  // git writes `index.lock` and renames it over `index`; the rename is reported
  // too, so the lock itself is noise.
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
 * The seam every test drives instead of the filesystem. `recursive` is a
 * request, not a guarantee: an implementation that cannot honour it says so by
 * reporting an error, which is how the degraded mode below is reached.
 */
export type WatchFn = (options: {
  target: string
  recursive: boolean
  onChange: (relative: string | null) => void
  onError: (error: unknown) => void
}) => WatchHandle

export type WorktreeWatcherOptions = {
  /** Called once per settled burst. Always the same coarse invalidation. */
  onChange: () => void
  watch?: WatchFn
  settleMs?: number
  minIntervalMs?: number
  /** Reported, never thrown: a watch that cannot be set up degrades instead. */
  onError?: (error: unknown) => void
  now?: () => number
  schedule?: (run: () => void, delayMs: number) => () => void
  /** Overridable so a test need not lay down a real `.git` file. */
  resolveGitDir?: (checkoutPath: string) => string | undefined
}

type WatchedWorktree = {
  path: string
  handles: WatchHandle[]
  /** False when the recursive watch failed and only the git dir is covered. */
  watchesWorkingTree: boolean
}

/**
 * Keeps one set of filesystem watches in step with the set of ready worktrees.
 *
 * Nothing here is incremental: `sync` is given the whole list and works out the
 * difference, because the list is short and a missed add is a feature that
 * silently stops working.
 */
export class WorktreeWatcher {
  readonly #watched = new Map<string, WatchedWorktree>()
  readonly #onChange: () => void
  readonly #watch: WatchFn
  readonly #settleMs: number
  readonly #minIntervalMs: number
  readonly #onError: (error: unknown) => void
  readonly #now: () => number
  readonly #schedule: (run: () => void, delayMs: number) => () => void
  readonly #resolveGitDir: (checkoutPath: string) => string | undefined

  #cancelPending: (() => void) | undefined
  /** Undefined until the first report, so the very first change is not held. */
  #lastReportAt: number | undefined
  #closed = false

  constructor(options: WorktreeWatcherOptions) {
    this.#onChange = options.onChange
    this.#watch = options.watch ?? nodeWatch
    this.#settleMs = options.settleMs ?? DEFAULT_SETTLE_MS
    this.#minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
    this.#onError = options.onError ?? (() => {})
    this.#now = options.now ?? Date.now
    this.#schedule = options.schedule ?? scheduleWithTimeout
    this.#resolveGitDir = options.resolveGitDir ?? resolveGitDir
  }

  /** Worktree ids currently covered, for tests and for the status line. */
  get watchedIds(): string[] {
    return [...this.#watched.keys()]
  }

  /** True when this worktree's working tree is covered, not just its git dir. */
  watchesWorkingTree(worktreeId: string): boolean {
    return this.#watched.get(worktreeId)?.watchesWorkingTree ?? false
  }

  /**
   * Brings the watch set in line with `worktrees`. Only `ready` ones are
   * watched: a checkout still being created has no files to speak of, and a
   * failed one has no checkout at all.
   */
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

    for (const [id, worktree] of wanted) {
      if (this.#watched.has(id)) continue
      this.#startWatching(id, worktree.path)
    }
  }

  /** Drops every watch and any pending report. */
  close(): void {
    this.#closed = true
    for (const id of [...this.#watched.keys()]) this.#stopWatching(id)
    this.#cancelPending?.()
    this.#cancelPending = undefined
  }

  #startWatching(id: string, checkoutPath: string): void {
    const handles: WatchHandle[] = []
    let watchesWorkingTree = false

    try {
      handles.push(
        this.#watch({
          target: checkoutPath,
          recursive: true,
          onChange: (relative) => {
            if (!ignoresCheckoutChange(relative)) this.#report()
          },
          // A recursive watch can fail well after it was set up — inotify runs
          // out of watches on a large tree — so this is not only a setup path.
          onError: (error) => this.#degrade(id, error)
        })
      )
      watchesWorkingTree = true
    } catch (error) {
      // Recursive watching is unavailable on some platforms and some
      // filesystems. The git directory alone still catches every staged
      // change, every commit and every branch switch, which is most of what
      // the chips show, so it is worth carrying on without.
      this.#onError(error)
    }

    const gitDir = this.#resolveGitDir(checkoutPath)
    if (gitDir !== undefined) {
      try {
        handles.push(
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

    // Nothing could be watched at all: record nothing, so a later sync retries
    // rather than believing this worktree is covered.
    if (handles.length === 0) return
    this.#watched.set(id, { path: checkoutPath, handles, watchesWorkingTree })
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
    if (watched) watched.watchesWorkingTree = false
    this.#onError(error)
  }

  /**
   * Collapses a burst into one report. The delay is the settle window, pushed
   * out far enough to respect the minimum interval — so a tree under continuous
   * change reports on a steady beat instead of once per write.
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

/**
 * Where a checkout's git directory actually is. For a linked worktree — which
 * is every worktree this app creates — `.git` is a file holding a pointer, so
 * the answer is never simply `<checkout>/.git`.
 */
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
  const watcher = fsWatch(
    options.target,
    // Never the reason a process stays alive: the app quitting must not wait on
    // a file watch, and neither must a test.
    { recursive: options.recursive, persistent: false },
    (_event, fileName) => options.onChange(typeof fileName === 'string' ? fileName : null)
  )
  watcher.on('error', options.onError)
  return { close: () => watcher.close() }
}

function scheduleWithTimeout(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}
