// Watches `.teamree` in the primary checkout (root, `.teamree`, `members/`; each layer notices the next
// appearing), so a `git pull` is not a restart. Never recursive: on Linux `recursive: true` with no inotify
// instance left comes back healthy and never fires. A timed sweep is the floor: darwin routinely never delivers.

import { existsSync, statSync, watch as fsWatch } from 'node:fs'
import { join } from 'node:path'
import { UNWATCHED_TEAMREE_LAG } from '../../shared/entities'
import { MEMBERS_DIR_SEGMENTS } from './memberFile'
import { RELAY_FILE_SEGMENTS } from './peer/relayUrl'

/** Long enough to swallow a checkout writing several files, short enough to feel live. */
export const DEFAULT_SETTLE_MS = 200

/**
 * How soon after a watch is attached the set is checked by hand, and how close it keeps sampling while
 * anything moves. Short, because attaching is when darwin is least likely to be listening.
 */
export const DEFAULT_SWEEP_FROM_MS = 200

/** And the longest the sweep ever waits, once nothing has happened for a while. */
export const DEFAULT_SWEEP_UNTIL_MS = 30_000

/** Steep, so the cost decays in four steps rather than fifty. */
const SWEEP_BACKOFF = 4

/**
 * Sweeps at the short delay before backoff may start. Sized against darwin's blind window: every
 * handle is a path on one process-wide FSEvents stream, and adding or removing a handle rebuilds that
 * stream from now, so writes made before the new one listens are never delivered. Measured on a mac:
 * in three runs of eight no handle spoke at all and the sweep was the only report.
 */
const SWEEP_SETTLE_SWEEPS = 5

/** The directory both team-wide facts live in, under the checkout root. */
const TEAMREE_DIR = MEMBERS_DIR_SEGMENTS[0]

export type WatchHandle = { close: () => void }

/** The filesystem seam, so tests drive a fake and one test drives a real checkout. Never recursive: see above. */
export type WatchFn = (options: {
  target: string
  onChange: (relative: string | null) => void
  onError: (error: unknown) => void
}) => WatchHandle

/**
 * A project whose `.teamree` is not being watched, and why. Not an error: everything works, but a
 * roster silently no longer following the file is a membership list from before the last pull.
 */
export type TeamreeWatchDegraded = {
  projectId: string
  /** The directory that could not be watched. */
  path: string
  error: unknown
}

/**
 * The two team-wide facts last time an event made us check. Three mtimes: a key arriving touches
 * `members/` and not `.teamree`, and the relay file touches neither. `undefined` means not there.
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
  /** Called once per project that is not fully covered. Defaults to reporting, never to silence. */
  onDegraded?: (event: TeamreeWatchDegraded) => void
  schedule?: (run: () => void, delayMs: number) => () => void
  /** The sweep's timer, apart from `schedule` so a test driving the debounce is not also driving the safety net. */
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
 * Keeps one set of filesystem watches in step with the set of projects. `sync` takes the whole list
 * and works out the difference: the list is short, and a missed add is a feature that silently stops.
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
  /** Sweeps still owed at the short delay before backing off is allowed. */
  #settlingSweeps = SWEEP_SETTLE_SWEEPS
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
   * True when everything that exists under this project's `.teamree` is watched. False is never
   * "broken" — it is "this list is only as fresh as the last read".
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
    // `#attach` asked for a soon one if it attached anything; this is for the project it could not attach at all.
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
   * Attaches whatever is missing for one project, and says so when something that exists could not
   * be. Idempotent and re-run after every report: the watch on the outer directory says the inner one exists.
   */
  #attach(projectId: string, projectPath: string): void {
    const watched = this.#watched.get(projectId) ?? { path: projectPath, handles: new Map(), covered: true }
    this.#watched.set(projectId, watched)
    // The baseline for the checkout-root filter, taken here rather than on the first event, so a
    // build writing into the checkout does not look like a change.
    if (!this.#marks.has(projectId)) this.#marks.set(projectId, markOf(projectPath))

    const teamreeDir = join(projectPath, TEAMREE_DIR)
    const membersDir = join(projectPath, ...MEMBERS_DIR_SEGMENTS)
    const had = watched.handles.size

    // The root is watched for one entry only: a report per file a build writes would cost a roster read each.
    this.#attachOne(watched, projectId, projectPath, {
      // Asked of the filesystem, not of the event's filename: how a platform spells its events is
      // not what happened. libuv's `src/unix/fsevents.c` resolves the watched path with `realpath` and
      // drops events below the direct children, so this is the same answer on every platform.
      interesting: () => this.#teamreeChanged(projectId, projectPath),
      // The checkout itself is what notices `.teamree` appearing, so it has to be there.
      required: true
    })
    this.#attachOne(watched, projectId, teamreeDir)
    this.#attachOne(watched, projectId, membersDir)

    // Degraded is a state to recover from, not a verdict: a branch switch without `.teamree` kills the
    // watches, and the project must not stay marked unwatched after the directory and its watches come
    // back. A warning left standing over a roster being followed is how somebody learns to ignore it.
    watched.covered =
      watched.handles.has(projectPath) &&
      // A directory that is not there needs no watch; one that is there and unwatched is what this flag is for.
      (!existsSync(teamreeDir) || watched.handles.has(teamreeDir)) &&
      (!existsSync(membersDir) || watched.handles.has(membersDir))

    // A handle appearing is when the set is least trustworthy: on darwin it rebuilds the stream every
    // other watch is listening on. Sweep soon, then back off again.
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
          // A watch can die long after setup — branch switch, inotify running out — so the handle is
          // dropped and the next report re-attaches it.
          onError: (error) => this.#lose(projectId, target, error)
        })
      )
    } catch (error) {
      // A directory that does not exist yet is the ordinary state of a project without teamwork; its
      // parent's watch will say when it appears.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && options.required !== true) return
      this.#lose(projectId, target, error)
    }
  }

  #lose(projectId: string, target: string, error: unknown): void {
    const watched = this.#watched.get(projectId)
    if (!watched) return
    // Losing a handle changes the handle set, the same moment as attaching one, and the directory that
    // went is the one a branch switch is about to bring back. Only on the first loss, so a watch that
    // dies noisily cannot push the sweep out ahead of itself.
    if (watched.handles.delete(target)) this.#armSweep(true)
    // Said once per project: a dying watch can report repeatedly.
    if (!watched.covered) return
    watched.covered = false
    this.#onDegraded({ projectId, path: target, error })
  }

  #stopWatching(id: string): void {
    const watched = this.#watched.get(id)
    if (!watched) return
    this.#watched.delete(id)
    // A remembered `.teamree` would be a claim about a checkout this watcher is no longer following.
    this.#marks.delete(id)
    for (const handle of watched.handles.values()) {
      try {
        handle.close()
      } catch {
        // Closing a watch whose directory has already gone is routine.
      }
    }
  }

  /**
   * Whether `.teamree` itself has changed since the last event said it had. Remembered per project so
   * a build writing into the checkout costs one `stat` and no report.
   */
  #teamreeChanged(projectId: string, projectPath: string): boolean {
    const mark = markOf(projectPath)
    const changed = !sameMark(this.#marks.get(projectId), mark)
    this.#marks.set(projectId, mark)
    return changed
  }

  /**
   * Puts the next sweep on the clock. `fromStart` is for the moments an event is most likely lost —
   * handle set changed, or a sweep found a change nothing reported; everything else lets the backoff carry on.
   */
  #armSweep(fromStart: boolean): void {
    if (this.#closed || this.#watched.size === 0) return
    if (fromStart) this.#stayClose()
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
   * Three `stat`s per project, and a report if any moved without an event: the same comparison the
   * checkout-root filter makes, so a hit is indistinguishable from the event that should have arrived.
   */
  #sweepNow(): void {
    if (this.#closed) return
    let changed = false
    for (const [id, watched] of this.#watched) {
      if (this.#teamreeChanged(id, watched.path)) changed = true
    }
    if (changed) {
      // The sweep found what the watch did not say: evidence about the watch, so stay close.
      this.#stayClose()
    } else if (this.#settlingSweeps > 0) {
      this.#settlingSweeps -= 1
    } else {
      this.#sweepDelayMs = Math.min(this.#sweepDelayMs * SWEEP_BACKOFF, this.#sweepUntilMs)
    }
    this.#armSweep(false)
    if (changed) this.#report()
  }

  /** Back to the short delay, with the settling phase to run again. */
  #stayClose(): void {
    this.#sweepDelayMs = this.#sweepFromMs
    this.#settlingSweeps = SWEEP_SETTLE_SWEEPS
  }

  /** Collapses a burst — a pull writes several files — into one report. */
  #report(): void {
    if (this.#closed || this.#cancelPending) return
    this.#cancelPending = this.#schedule(
      () => {
        this.#cancelPending = undefined
        // Before the report, so a `.teamree` just created is covered by the time anything re-reads it.
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
    // Never the reason a process stays alive: quitting must not wait on a file watch, nor a test.
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
