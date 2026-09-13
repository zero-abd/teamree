// Knowing that a newer teamree exists, and saying so quietly.
//
// **This checks; it does not install.** teamree ships unsigned, and the macOS
// update mechanism every Electron auto-updater is built on — Squirrel.Mac —
// validates the code signature of the replacement before swapping it in and
// refuses an unsigned one. So a silent download-and-restart is not a thing this
// product can have, and pretending otherwise would mean shipping a button that
// fails on every machine it runs on. What it can have is the part that actually
// matters to somebody running a build from three releases ago: being told, once
// they are already in the app, that there is something newer, with the notes
// and a link to the `.dmg`. `docs/install.md` takes it from there, quarantine
// advice and all.
//
// Three rules shape everything below, and each of them is about not costing the
// user anything for a feature they did not ask for:
//
//   - **Nothing waits on the network.** The check is scheduled well after the
//     window is up and nothing is awaited on the way there. A machine with no
//     route to GitHub launches exactly as fast as one without.
//   - **A failure is not an event.** No dialog, no notice, no red. The reason
//     is kept for whoever opens the log, the state says the check did not land,
//     and the app carries on.
//   - **The API is asked rarely.** Once every few hours at most, and the clock
//     is on disk rather than in memory, so quitting and relaunching all morning
//     is one check rather than a dozen. The budget being spent is the user's
//     own unauthenticated quota, shared with every other tool on their machine.

import type { UpdateRelease, UpdateState } from '../../shared/entities'
import { DEV_VERSION } from '../appVersion'
import { conflict, internal } from '../runtime/runtimeError'
import {
  isReleaseDownload,
  readLatestRelease,
  RELEASE_HOST,
  UPDATE_REPOSITORY,
  type LatestRelease,
  type ReleaseChannel
} from './latestRelease'
import { isNewerRelease, isPrereleaseVersion, parseVersion } from './semver'

/**
 * How long an automatic check is good for.
 *
 * Releases here happen a few times a week at the busiest, so six hours is
 * already far finer-grained than the thing it is watching. It is chosen from
 * the other end anyway: it is short enough that somebody who leaves the app
 * open for a working day hears about a release that afternoon, and long enough
 * that the app is a rounding error against sixty unauthenticated requests an
 * hour.
 */
export const AUTOMATIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * How long after startup the first automatic check is made.
 *
 * Late on purpose. Startup is already restoring panes, resuming agents and
 * reading git, and none of that should share a moment with a DNS lookup nobody
 * is waiting for. Half a minute in, the window has been usable for a while and
 * the check is invisible whichever way it goes.
 */
export const STARTUP_CHECK_DELAY_MS = 30_000

/**
 * The preference and the clock, as they are kept between runs.
 *
 * A seam rather than the store itself, for the reason `CliPromptRecord` is one:
 * this service has no business knowing what a workspace file is, and a test has
 * to be able to watch what was written down without one. The implementation
 * behind it is `WorkspaceStore` — the same file every other preference lives
 * in, because a second file for one boolean is a second file to lose.
 */
export type UpdateSettingsRecord = {
  read: () => StoredUpdateSettings
  setAutomatic: (automatic: boolean) => void
  /** Writes down that a check was attempted, successful or not. */
  recordAttempt: (at: number) => void
  /**
   * Writes down the newest version the API named, or null when it named none.
   *
   * Only what a check actually learned: a check that could not be made leaves
   * this alone, so a laptop that opens on a train still knows what it was told
   * yesterday.
   */
  rememberLatest: (version: string | null) => void
}

export type StoredUpdateSettings = {
  automatic: boolean
  lastCheckedAt: number | null
  /**
   * The newest version the last successful check saw.
   *
   * This is what lets the app still say "0.2.0 is out" on a launch that is
   * inside the rate limit and therefore asks nobody anything. It is a version
   * string and nothing else — the notes are not kept, because they are text
   * from the internet and `workspace.json` is the one file this app cannot
   * afford to have trouble reading.
   */
  lastSeenVersion: string | null
}

export type UpdateServiceOptions = {
  /** This build's version. `APP_VERSION`, which is package.json's. */
  version: string
  settings: UpdateSettingsRecord
  /** Defaults to this project's releases. A test always names its own. */
  repository?: string
  /** The GitHub read. Injected whole, so no test ever opens a socket. */
  readRelease?: (channel: ReleaseChannel) => Promise<LatestRelease | null>
  /** Opens a URL in the user's browser. `shell.openExternal` in the app. */
  openExternal?: (url: string) => Promise<void>
  /** Told after anything that changes what `state()` answers. */
  onChange?: () => void
  /** Where a failed check goes. Never a dialog; see the note at the top. */
  onProblem?: (message: string, error: unknown) => void
  now?: () => number
  /** Timer seam. Returns the cancel, like the rest of the codebase's. */
  schedule?: (run: () => void, delayMs: number) => () => void
}

export class UpdateService {
  readonly #version: string
  readonly #repository: string
  readonly #settings: UpdateSettingsRecord
  readonly #readRelease: (channel: ReleaseChannel) => Promise<LatestRelease | null>
  readonly #openExternal: ((url: string) => Promise<void>) | undefined
  readonly #onChange: () => void
  readonly #onProblem: (message: string, error: unknown) => void
  readonly #now: () => number
  readonly #schedule: (run: () => void, delayMs: number) => () => void

  /** What this session's own check found. Null until one has succeeded. */
  #latest: LatestRelease | null = null
  /** One check at a time: a menu click during the startup check joins it. */
  #inFlight: Promise<UpdateState> | undefined
  #problem: string | null = null
  #cancelScheduled: (() => void) | undefined

  constructor(options: UpdateServiceOptions) {
    this.#version = options.version
    this.#repository = options.repository ?? UPDATE_REPOSITORY
    this.#settings = options.settings
    this.#readRelease =
      options.readRelease ??
      ((channel) => readLatestRelease({ channel, repository: this.#repository, version: this.#version }))
    this.#openExternal = options.openExternal
    this.#onChange = options.onChange ?? (() => {})
    this.#onProblem = options.onProblem ?? ((message) => console.warn(`[updates] ${message}`))
    this.#now = options.now ?? Date.now
    this.#schedule = options.schedule ?? scheduleWithTimeout
  }

  /**
   * Arms the automatic check, and returns immediately.
   *
   * Not awaited by anything, and nothing here touches the network: it sets a
   * timer. The preference is read when the timer fires rather than now, so
   * turning the check off in the first half-minute turns off the first check.
   */
  start(): void {
    if (!this.#checkable()) return
    this.#cancelScheduled?.()
    this.#cancelScheduled = this.#schedule(() => {
      this.#cancelScheduled = undefined
      if (!this.#settings.read().automatic) return
      void this.check()
    }, STARTUP_CHECK_DELAY_MS)
  }

  /** Drops the pending check. A quit must not be waiting on an update check. */
  stop(): void {
    this.#cancelScheduled?.()
    this.#cancelScheduled = undefined
  }

  state(): UpdateState {
    const stored = this.#settings.read()
    return {
      current: this.#version,
      checkable: this.#checkable(),
      automatic: stored.automatic,
      available: this.#available(stored.lastSeenVersion),
      checking: this.#inFlight !== undefined,
      checkedAt: stored.lastCheckedAt,
      problem: this.#problem
    }
  }

  /**
   * Asks GitHub, unless it has been asked recently enough.
   *
   * `force` is what the menu item and the palette pass, and it is the whole
   * difference between the two callers: somebody who has just chosen "Check for
   * updates" is owed an answer now, and the rate limit exists to stop the app
   * asking on its own account rather than to refuse a person.
   */
  async check(options: { force?: boolean } = {}): Promise<UpdateState> {
    // A second caller joins the check already running rather than starting
    // another. Two in flight would spend two requests to learn one fact.
    if (this.#inFlight) return this.#inFlight

    if (!this.#checkable()) {
      this.#problem = `This build reports ${this.#version}, which is not a released version, so there is nothing to compare it against.`
      this.#onChange()
      return this.state()
    }

    const now = this.#now()
    const last = this.#settings.read().lastCheckedAt
    if (options.force !== true && last !== null && now - last < AUTOMATIC_CHECK_INTERVAL_MS) {
      return this.state()
    }

    this.#inFlight = this.#run(now)
    // Said before the await so a button can go quiet immediately; said again in
    // `#run`'s finally, when there is an answer to show.
    this.#onChange()
    try {
      return await this.#inFlight
    } finally {
      this.#inFlight = undefined
    }
  }

  async #run(startedAt: number): Promise<UpdateState> {
    try {
      const release = await this.#readRelease(this.#channel())
      this.#latest = release
      this.#problem = null
      // Written down whichever way it went, including "there is no release at
      // all", so the answer survives the restart that comes after it.
      this.#settings.rememberLatest(release?.version ?? null)
    } catch (error) {
      // The one place a failed check is allowed to reach, and it is a log line.
      this.#problem = describe(error)
      this.#onProblem(`could not read the latest release: ${this.#problem}`, error)
    } finally {
      // The attempt counts against the rate limit even when it failed: the
      // point of the limit is how often this app asks, and a request that was
      // refused was still a request.
      this.#settings.recordAttempt(startedAt)
      this.#onChange()
    }
    return this.state()
  }

  /** The preference, which is the one thing here the user decides. */
  setAutomatic(automatic: boolean): UpdateState {
    this.#settings.setAutomatic(automatic)
    if (!automatic) this.stop()
    this.#onChange()
    return this.state()
  }

  /**
   * Opens the download in the user's browser, and takes no URL to do it.
   *
   * Deliberately no parameter. The address came off the GitHub API, and a call
   * that accepted one would let anything that can reach this runtime — the CLI
   * socket, a renderer, a teammate's misrouted frame — name a page for the
   * user's browser to open. So the only thing that can be opened is the release
   * this service is currently holding, re-checked here against the repository
   * it claims to belong to.
   */
  async openDownload(): Promise<{ opened: string }> {
    const available = this.state().available
    if (available === null) throw conflict('there is no newer release to download')
    const url = available.downloadUrl ?? available.releaseUrl
    if (!isReleaseDownload(url, this.#repository)) {
      throw internal(`refusing to open ${url}: it is not a download in ${this.#repository}`)
    }
    if (this.#openExternal === undefined) {
      throw internal('this runtime has no browser to open a download in')
    }
    await this.#openExternal(url)
    return { opened: url }
  }

  /**
   * Whether this build is one a release can be compared against.
   *
   * The dev placeholder is excluded by name as well as by shape: it parses
   * perfectly well as a pre-release of 0.0.0, which is to say as a version that
   * everything ever published is newer than.
   */
  #checkable(): boolean {
    return this.#version !== DEV_VERSION && parseVersion(this.#version) !== null
  }

  /**
   * Which releases this build is offered.
   *
   * Running a candidate is how somebody opts into candidates: there is no
   * setting for it, because the setting would be a second way of saying the
   * thing the running version already says.
   */
  #channel(): ReleaseChannel {
    const current = parseVersion(this.#version)
    return current !== null && isPrereleaseVersion(current) ? 'prerelease' : 'stable'
  }

  /**
   * The release worth interrupting somebody for, or null.
   *
   * Two sources, and the order matters. This session's own check wins, because
   * it is the newer fact. Otherwise the version written down by an earlier run
   * answers — which is what makes a launch inside the rate limit still able to
   * say that 0.2.0 exists, without asking anybody and without pretending to
   * know notes it does not have.
   */
  #available(remembered: string | null): UpdateRelease | null {
    const current = parseVersion(this.#version)
    if (current === null) return null

    if (this.#latest !== null) {
      const found = parseVersion(this.#latest.version)
      if (found === null || !isNewerRelease(found, current)) return null
      const { version, tag, notes, downloadUrl, releaseUrl, publishedAt } = this.#latest
      return { version, tag, notes, downloadUrl, releaseUrl, publishedAt }
    }

    if (remembered === null) return null
    // Somebody who turned the check off is not offered what an earlier run
    // happened to learn. The remembered version exists so that a launch inside
    // the rate limit can still say something; it is not a way for a preference
    // to be quietly outlived by the last thing it found. A check they ask for
    // by hand sets `#latest` above, which is answered whatever this says.
    if (!this.#settings.read().automatic) return null

    const seen = parseVersion(remembered)
    if (seen === null || !isNewerRelease(seen, current)) return null
    const tag = `v${seen.raw}`
    return {
      version: seen.raw,
      tag,
      // No notes and no asset: neither is written down between runs, and
      // guessing an asset's file name would be inventing a link that 404s the
      // day somebody renames one. The release page is always there.
      notes: null,
      downloadUrl: null,
      releaseUrl: `https://${RELEASE_HOST}/${this.#repository}/releases/tag/${tag}`,
      publishedAt: null
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function scheduleWithTimeout(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs)
  // An update check must never be the reason a process is still alive.
  timer.unref?.()
  return () => clearTimeout(timer)
}
