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
// AND WHY A SWEEP AS WELL. An event is the fast path, not the guarantee.
//
// This file's tests fail on the macOS runner and have never failed on Linux,
// always as silence — `nothing was reported` — and landing on whichever of the
// real-filesystem tests the timing catches. Three fixes before this one were
// guesses at what macOS puts in an event's `filename`; the filter stopped
// reading that string two commits ago and the silence outlived it, so the
// remaining explanation is that the event does not arrive, or arrives far too
// late.
//
// What libuv's `fs.watch` does on darwin makes that easy to believe. There is
// no non-recursive directory watch on that platform, so every handle is a path
// added to one process-wide FSEvents stream — and adding or removing any handle
// tears that stream down and builds a new one, subscribed from *now*. The work
// happens on libuv's CoreFoundation thread, after `fs.watch` has already
// returned. So a watch is not listening when it is created, it is listening
// some unmeasured time later, and every other watch in the process goes deaf
// for the same window each time a new one is attached. Anything that happens in
// that window is not delivered late; it is never delivered. `sync` attaches
// three watches back to back and the test writes immediately afterwards, which
// is precisely that window.
//
// That reading is from libuv's source, not from a machine anyone here can run,
// which is why the fix does not depend on it being right. The sweep below is
// the floor under every explanation: the same three `stat`s the checkout-root
// filter already does, on a timer that starts short after a watch is attached —
// the moment the platform is most likely blind — and backs off to once every
// thirty seconds while nothing is happening. Not a poll standing in for the
// watch: on Linux the event arrives in single-digit milliseconds and the sweep
// never has anything to say. What it changes is the worst case. A dropped event
// used to mean a roster that had quietly stopped following its file for the life
// of the process, which is the exact failure this whole area exists to prevent.
// Now it means noticing late.
//
// What comes out is the same coarse invalidation every other producer emits.
// The value here is entirely in the timing.

import { existsSync, statSync, watch as fsWatch } from 'node:fs'
import { join } from 'node:path'
import { UNWATCHED_TEAMREE_LAG } from '../../shared/entities'
import { MEMBERS_DIR_SEGMENTS } from './memberFile'
import { RELAY_FILE_SEGMENTS } from './peer/relayUrl'

/** Long enough to swallow a checkout writing several files, short enough to feel live. */
export const DEFAULT_SETTLE_MS = 200

/**
 * How soon after a watch is attached the set is checked by hand anyway.
 *
 * Short, because attaching is when the platform is least likely to be
 * listening — see the note above on what darwin does with a new handle — and
 * because a report this late is still twenty-five times inside the budget the
 * tests give a `git pull`.
 */
export const DEFAULT_SWEEP_FROM_MS = 200

/** And the longest the sweep ever waits, once nothing has happened for a while. */
export const DEFAULT_SWEEP_UNTIL_MS = 30_000

/** Steep, so the cost decays in four steps rather than fifty. */
const SWEEP_BACKOFF = 4

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

/**
 * What the two team-wide facts looked like last time an event made us check.
 *
 * Three numbers, not one, and the third is why: a key arriving does not touch
 * `.teamree`'s own mtime — it changes the mtime of `members/`, the directory it
 * lands in — and the relay file changes neither, since editing a file leaves
 * its parent alone. A mark of `.teamree` by itself answers "did teamwork
 * appear or go", which is only one of the three things this watch is for.
 *
 * `undefined` for a path means it is not there at all, which is a state worth
 * telling apart from every other: a project nobody has set teamwork up on is
 * the case the checkout-root watch exists for.
 */
type TeamreeMark = readonly (number | undefined)[]

function mtimeOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

function markOf(projectPath: string): TeamreeMark {
  return [
    mtimeOf(join(projectPath, TEAMREE_DIR)),
    mtimeOf(join(projectPath, ...MEMBERS_DIR_SEGMENTS)),
    mtimeOf(join(projectPath, ...RELAY_FILE_SEGMENTS))
  ]
}

function sameMark(a: TeamreeMark | undefined, b: TeamreeMark): boolean {
  return a !== undefined && a.length === b.length && a.every((each, index) => each === b[index])
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
  return `${event.path} is not being watched: ${cause}. ${UNWATCHED_TEAMREE_LAG}`
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
  /**
   * The sweep's timer, kept apart from `schedule` so a test driving the debounce
   * by hand is not also driving the safety net, and the other way about.
   */
  sweep?: (run: () => void, delayMs: number) => () => void
  sweepFromMs?: number
  sweepUntilMs?: number
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
  /** What `.teamree` looked like when this project last reported. */
  readonly #marks = new Map<string, TeamreeMark>()
  readonly #onChange: () => void
  readonly #watch: WatchFn
  readonly #settleMs: number
  readonly #onDegraded: (event: TeamreeWatchDegraded) => void
  readonly #schedule: (run: () => void, delayMs: number) => () => void
  readonly #sweep: (run: () => void, delayMs: number) => () => void
  readonly #sweepFromMs: number
  readonly #sweepUntilMs: number

  #cancelPending: (() => void) | undefined
  #cancelSweep: (() => void) | undefined
  #sweepDelayMs: number
  #closed = false

  constructor(options: TeamreeWatcherOptions) {
    this.#onChange = options.onChange
    this.#watch = options.watch ?? nodeWatch
    this.#settleMs = options.settleMs ?? DEFAULT_SETTLE_MS
    this.#onDegraded = options.onDegraded ?? ((event) => console.warn('[teamwork]', degradedTeamreeWatchReport(event)))
    this.#schedule = options.schedule ?? scheduleWithTimeout
    this.#sweep = options.sweep ?? scheduleWithTimeout
    this.#sweepFromMs = options.sweepFromMs ?? DEFAULT_SWEEP_FROM_MS
    this.#sweepUntilMs = options.sweepUntilMs ?? DEFAULT_SWEEP_UNTIL_MS
    this.#sweepDelayMs = this.#sweepFromMs
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
    // `#attach` has already asked for a soon one if it attached anything. This
    // is for the project it could not attach a single watch to, which is the
    // one that needs the floor most.
    this.#armSweep(false)
  }

  close(): void {
    this.#closed = true
    for (const id of [...this.#watched.keys()]) this.#stopWatching(id)
    this.#cancelPending?.()
    this.#cancelPending = undefined
    this.#cancelSweep?.()
    this.#cancelSweep = undefined
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
    // The baseline for the checkout-root filter below. Taken here rather than
    // on the first event, so that a build writing into the checkout is still
    // free: without it the first write after attaching would always look like a
    // change, because nothing had been recorded to compare it against.
    if (!this.#marks.has(projectId)) this.#marks.set(projectId, markOf(projectPath))

    const teamreeDir = join(projectPath, TEAMREE_DIR)
    const membersDir = join(projectPath, ...MEMBERS_DIR_SEGMENTS)
    const had = watched.handles.size

    // The root is watched for one entry only. A checkout is where a build
    // writes and an agent works, and a report per file written there would cost
    // a roster read for every one of them.
    this.#attachOne(watched, projectId, projectPath, {
      // Asked of the filesystem, not of the event's filename.
      //
      // This used to compare the reported name against `.teamree`, which is a
      // statement about how a platform spells its events and not about what
      // happened. Three fixes were spent guessing at that string, and two of the
      // guesses came with a story about macOS that libuv's `src/unix/fsevents.c`
      // does not support: it resolves the watched path with `realpath` before
      // matching, so a symlinked checkout is not spelled differently, and it
      // drops any event whose path has a `/` left in it after the watched
      // prefix, so a non-recursive watch there hears about its direct children
      // and nothing below them — the same shape inotify gives on Linux.
      //
      // So the string is no longer load-bearing, and neither is the story. Any
      // event on the checkout root costs one `stat` of `.teamree`, and only a
      // real change to it — appearing, going, or being written — reports. That
      // is cheaper than the roster read this filter exists to avoid, and it is
      // the same answer on every platform because it is not an opinion about
      // the platform.
      interesting: () => this.#teamreeChanged(projectId, projectPath),
      // The checkout itself is the one directory that has to be there: it is
      // what notices `.teamree` appearing, so a project whose path has gone is
      // a project nothing can be heard about.
      required: true
    })
    this.#attachOne(watched, projectId, teamreeDir)
    this.#attachOne(watched, projectId, membersDir)

    // Degraded is a state to recover from, not a verdict.
    //
    // `#lose` sets it when a watch dies, and a watch dying is exactly what a
    // branch switch does: checking out a branch without `.teamree` takes the
    // directory and its watches with it. Without this, the project stayed
    // marked unwatched for the life of the process — including after the branch
    // came back, the directory returned, and every watch was successfully
    // re-attached a few lines above.
    //
    // That is the failure of this area pointed the other way. A roster that has
    // silently stopped following its file is the thing worth warning about; a
    // warning left standing over a roster that is being followed perfectly well
    // is how somebody learns to ignore the warning.
    watched.covered =
      watched.handles.has(projectPath) &&
      // A directory that is not there needs no watch — a project nobody has set
      // teamwork up on is covered by the watch on its checkout. One that is
      // there and has no watch is the case this flag exists for.
      (!existsSync(teamreeDir) || watched.handles.has(teamreeDir)) &&
      (!existsSync(membersDir) || watched.handles.has(membersDir))

    // A handle appearing is the moment the set is least trustworthy: on darwin
    // it rebuilds the stream every other watch in this process is listening on,
    // and until the new one is listening this project has nothing following it
    // at all. Sweep soon, then back off again.
    if (watched.handles.size > had) this.#armSweep(true)
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
    // A project that comes back is a project nobody has looked at since, so its
    // remembered `.teamree` would be a claim about a checkout this watcher is
    // no longer following.
    this.#marks.delete(id)
    for (const handle of watched.handles.values()) {
      try {
        handle.close()
      } catch {
        // Closing a watch whose directory has already gone is routine.
      }
    }
  }

  /** Collapses a burst — a pull writes several files — into one report. */
  /**
   * Whether `.teamree` itself has changed since the last event said it had.
   *
   * Remembered per project so a build writing into the checkout — which is what
   * a checkout is for — costs one `stat` and no report.
   */
  #teamreeChanged(projectId: string, projectPath: string): boolean {
    const mark = markOf(projectPath)
    const changed = !sameMark(this.#marks.get(projectId), mark)
    this.#marks.set(projectId, mark)
    return changed
  }

  /**
   * Puts the next sweep on the clock.
   *
   * `fromStart` is for the moments a watch has just been attached or the
   * project list has just been set, which are the moments an event is most
   * likely to be lost; everything else lets the backoff carry on.
   */
  #armSweep(fromStart: boolean): void {
    if (this.#closed || this.#watched.size === 0) return
    if (fromStart) this.#sweepDelayMs = this.#sweepFromMs
    else if (this.#cancelSweep) return
    this.#cancelSweep?.()
    this.#cancelSweep = this.#sweep(
      () => {
        this.#cancelSweep = undefined
        this.#sweepNow()
      },
      this.#sweepDelayMs
    )
  }

  /**
   * Three `stat`s per project, and a report if any of them moved without an
   * event to say so.
   *
   * The same comparison the checkout-root filter makes, which is what keeps this
   * honest: a sweep that finds nothing costs three `stat`s and says nothing, and
   * one that finds something is indistinguishable from the event that should
   * have arrived.
   */
  #sweepNow(): void {
    if (this.#closed) return
    let changed = false
    for (const [id, watched] of this.#watched) {
      if (this.#teamreeChanged(id, watched.path)) changed = true
    }
    this.#sweepDelayMs = Math.min(this.#sweepDelayMs * SWEEP_BACKOFF, this.#sweepUntilMs)
    this.#armSweep(false)
    if (changed) this.#report()
  }

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
