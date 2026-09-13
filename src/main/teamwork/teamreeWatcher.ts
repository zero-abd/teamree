// Watching `.teamree` in the primary checkout, so a `git pull` is not a
// restart.
//
// The two team-wide facts — who is on the roster and which relay they meet on —
// are files in the repository, and that is the whole point of the design: they
// arrive the way every other decision about a project arrives, in a commit. But
// arriving in a commit means arriving without this app doing anything, and
// until now nothing here noticed. The peer service re-read those files when the
// project list changed or when *this* app wrote a member file, and a pull that
// brings in a teammate's key is neither: both machines sat on the roster from
// before the pull, with nothing on screen to suggest a stale read. "Quit and
// reopen teamree" was a numbered step in the runbook because of this file's
// absence.
//
// WHAT IS WATCHED, AND WHY IT IS THREE THINGS. Each project gets a
// non-recursive watch on the checkout root, on `.teamree`, and on
// `.teamree/members`. The root is watched only for the `.teamree` entry itself,
// because a project that has never had teamwork set up on it gets the directory
// created by somebody else's commit; `.teamree` covers the relay file and the
// appearance of `members/`; `members/` covers the keys. Each layer is what
// notices the next one being created — or deleted and recreated, which is what
// a checkout of a branch without it and back again does — so the set repairs
// itself instead of holding a watch on an inode nobody writes to any more.
//
// WHY NOT ONE RECURSIVE WATCH. `src/main/git/worktreeWatcher.ts` found this out
// the hard way: on Linux `recursive: true` is Node's own directory walker, and
// with no inotify instance left to give it the watcher comes back looking
// healthy and then never fires — nothing throws and nothing reaches the error
// event. `.teamree` is two directories deep and holds a handful of small files,
// so asking recursively buys nothing and costs that failure mode. A
// non-recursive watch that cannot be set up fails loudly with EMFILE, which is
// what makes the degraded report below trustworthy.
//
// What comes out is the same coarse invalidation every other producer emits.
// The value here is entirely in the timing.

import { watch as fsWatch } from 'node:fs'
import { join } from 'node:path'
import { MEMBERS_DIR_SEGMENTS } from './memberFile'

/** Long enough to swallow a checkout writing several files, short enough to feel live. */
export const DEFAULT_SETTLE_MS = 200

/** The directory both team-wide facts live in, under the checkout root. */
const TEAMREE_DIR = MEMBERS_DIR_SEGMENTS[0]

export type WatchHandle = { close: () => void }

/**
 * The filesystem seam, so the tests for the watch set drive a fake and the one
 * test that matters drives a real checkout. Never recursive: see above.
 */
export type WatchFn = (options: {
  target: string
  onChange: (relative: string | null) => void
  onError: (error: unknown) => void
}) => WatchHandle

/**
 * A project whose `.teamree` is not being watched, and why.
 *
 * Not an error, which is exactly why it has to be said: everything goes on
 * working, and what changes is only what the app is able to *know*. A roster
 * that is silently no longer following the file would have somebody reading a
 * membership list from before their last pull and believing it, which is the
 * failure this whole area exists to avoid.
 */
export type TeamreeWatchDegraded = {
  projectId: string
  /** The directory that could not be watched. */
  path: string
  error: unknown
}

/** What a lost watch means, in terms somebody could act on. */
export function degradedTeamreeWatchReport(event: TeamreeWatchDegraded): string {
  const code = (event.error as NodeJS.ErrnoException | null)?.code
  const cause =
    // inotify_init reports the per-user instance ceiling as EMFILE and the
    // per-user watch ceiling as ENOSPC; neither is about this repository.
    code === 'EMFILE' || code === 'ENOSPC'
      ? `this machine has no filesystem watches left to give (${code})`
      : `the filesystem refused a watch${code ? ` (${code})` : ''}`
  return (
    `${event.path} is not being watched: ${cause}. ` +
    'A teammate’s key or a relay arriving by git pull will not be noticed until something else re-reads it.'
  )
}

/** All this needs of a project: where its checkout is. */
export type WatchedProject = { id: string; path: string }

export type TeamreeWatcherOptions = {
  /** Called once per settled burst, for any project. Always coarse. */
  onChange: () => void
  watch?: WatchFn
  settleMs?: number
  /**
   * Called once per project that is not fully covered. Defaults to reporting,
   * never to silence.
   */
  onDegraded?: (event: TeamreeWatchDegraded) => void
  schedule?: (run: () => void, delayMs: number) => () => void
}

type WatchedTeamree = {
  path: string
  handles: Map<string, WatchHandle>
  /** False once any directory that exists could not be watched. */
  covered: boolean
}

/**
 * Keeps one set of filesystem watches in step with the set of projects.
 *
 * `sync` takes the whole list and works out the difference, for the same reason
 * the worktree watcher does: the list is short, and a missed add is a feature
 * that silently stops working.
 */
export class TeamreeWatcher {
  readonly #watched = new Map<string, WatchedTeamree>()
  readonly #onChange: () => void
  readonly #watch: WatchFn
  readonly #settleMs: number
  readonly #onDegraded: (event: TeamreeWatchDegraded) => void
  readonly #schedule: (run: () => void, delayMs: number) => () => void

  #cancelPending: (() => void) | undefined
  #closed = false

  constructor(options: TeamreeWatcherOptions) {
    this.#onChange = options.onChange
    this.#watch = options.watch ?? nodeWatch
    this.#settleMs = options.settleMs ?? DEFAULT_SETTLE_MS
    this.#onDegraded = options.onDegraded ?? ((event) => console.warn('[teamwork]', degradedTeamreeWatchReport(event)))
    this.#schedule = options.schedule ?? scheduleWithTimeout
  }

  /** Project ids with at least one watch, for tests and for the dialog. */
  get watchedIds(): string[] {
    return [...this.#watched.keys()]
  }

  /**
   * True when everything that exists under this project's `.teamree` is
   * watched, so a change git brings in is noticed without being asked. False is
   * never "broken" — it is "this list is only as fresh as the last read", which
   * is a different sentence and has to stay one.
   */
  watches(projectId: string): boolean {
    return this.#watched.get(projectId)?.covered ?? false
  }

  sync(projects: readonly WatchedProject[]): void {
    if (this.#closed) return
    const wanted = new Map(projects.map((project) => [project.id, project]))

    for (const [id, watched] of this.#watched) {
      const project = wanted.get(id)
      // A project that moved is a different thing to watch under the same id.
      if (project && project.path === watched.path) continue
      this.#stopWatching(id)
    }

    for (const [id, project] of wanted) this.#attach(id, project.path)
  }

  close(): void {
    this.#closed = true
    for (const id of [...this.#watched.keys()]) this.#stopWatching(id)
    this.#cancelPending?.()
    this.#cancelPending = undefined
  }

  /**
   * Attaches whatever is missing for one project, and says so when something
   * that exists could not be attached.
   *
   * Idempotent, and run again after every report: the directories appear one
   * inside the next, and the watch on the outer one is what says the inner one
   * now exists.
   */
  #attach(projectId: string, projectPath: string): void {
    const watched = this.#watched.get(projectId) ?? { path: projectPath, handles: new Map(), covered: true }
    this.#watched.set(projectId, watched)

    const teamreeDir = join(projectPath, TEAMREE_DIR)
    const membersDir = join(projectPath, ...MEMBERS_DIR_SEGMENTS)

    // The root is watched for one entry only. A checkout is where a build
    // writes and an agent works, and a report per file written there would cost
    // a roster read for every one of them.
    this.#attachOne(watched, projectId, projectPath, {
      interesting: (relative) => relative === null || relative === TEAMREE_DIR,
      // The checkout itself is the one directory that has to be there: it is
      // what notices `.teamree` appearing, so a project whose path has gone is
      // a project nothing can be heard about.
      required: true
    })
    this.#attachOne(watched, projectId, teamreeDir)
    this.#attachOne(watched, projectId, membersDir)
  }

  #attachOne(
    watched: WatchedTeamree,
    projectId: string,
    target: string,
    options: { interesting?: (relative: string | null) => boolean; required?: boolean } = {}
  ): void {
    const interesting = options.interesting ?? ((): boolean => true)
    if (watched.handles.has(target)) return
    try {
      watched.handles.set(
        target,
        this.#watch({
          target,
          onChange: (relative) => {
            if (interesting(relative)) this.#report()
          },
          // A watch can die long after it was set up — the directory is removed
          // by a branch switch, or inotify runs out while the app is running —
          // so this is not only a setup path. The handle is dropped so the next
          // report re-attaches it.
          onError: (error) => this.#lose(projectId, target, error)
        })
      )
    } catch (error) {
      // A directory that does not exist yet is not a fault: this is the
      // ordinary state of a project nobody has set teamwork up on, and the
      // watch on its parent is what will say it has appeared.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && options.required !== true) return
      this.#lose(projectId, target, error)
    }
  }

  #lose(projectId: string, target: string, error: unknown): void {
    const watched = this.#watched.get(projectId)
    if (!watched) return
    watched.handles.delete(target)
    // Said once per project. A dying watch can report repeatedly, and the app
    // has already stopped following the file after the first one.
    if (!watched.covered) return
    watched.covered = false
    this.#onDegraded({ projectId, path: target, error })
  }

  #stopWatching(id: string): void {
    const watched = this.#watched.get(id)
    if (!watched) return
    this.#watched.delete(id)
    for (const handle of watched.handles.values()) {
      try {
        handle.close()
      } catch {
        // Closing a watch whose directory has already gone is routine.
      }
    }
  }

  /** Collapses a burst — a pull writes several files — into one report. */
  #report(): void {
    if (this.#closed || this.#cancelPending) return
    this.#cancelPending = this.#schedule(
      () => {
        this.#cancelPending = undefined
        // Before the report, so a `.teamree` that has just been created is
        // already covered by the time anything re-reads it.
        for (const [id, watched] of [...this.#watched]) this.#attach(id, watched.path)
        this.#onChange()
      },
      this.#settleMs
    )
  }
}

function nodeWatch(options: Parameters<WatchFn>[0]): WatchHandle {
  const watcher = fsWatch(
    options.target,
    // Never the reason a process stays alive: quitting must not wait on a file
    // watch, and neither must a test.
    { persistent: false },
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
