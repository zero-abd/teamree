// Knowing that a newer teamree exists, and fetching its `.dmg`. Never installs: the app
// ships unsigned and Squirrel.Mac refuses an unsigned replacement. Nothing waits on
// the network, a failure is a log line, and the API is asked rarely with the clock on disk.

import type { UpdateDownload, UpdateRelease, UpdateState } from '../../shared/entities'
import { DEV_VERSION } from '../appVersion'
import { conflict, internal } from '../runtime/runtimeError'
import { ChecksumMismatch, downloadDiskImage, releaseHostPolicy, type HostPolicy } from './downloadInstaller'
import {
  isReleaseDownload,
  readLatestRelease,
  RELEASE_HOST,
  UPDATE_REPOSITORY,
  type DiskImage,
  type LatestRelease,
  type ReleaseChannel
} from './latestRelease'
import { isNewerRelease, isPrereleaseVersion, parseVersion } from './semver'

/** How long an automatic check is good for: a rounding error against sixty unauthenticated requests an hour. */
export const AUTOMATIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/** How long after startup the first automatic check is made; late, so it shares no moment with the restore. */
export const STARTUP_CHECK_DELAY_MS = 30_000

/** The preference and the clock, as kept between runs; `WorkspaceStore` behind it, a seam for tests. */
export type UpdateSettingsRecord = {
  read: () => StoredUpdateSettings
  setAutomatic: (automatic: boolean) => void
  /** Writes down that a check was attempted, successful or not. */
  recordAttempt: (at: number) => void
  /** The newest version the API named, or null when it named none; a failed check leaves it alone. */
  rememberLatest: (version: string | null) => void
}

export type StoredUpdateSettings = {
  automatic: boolean
  lastCheckedAt: number | null
  /**
   * The newest version the last successful check saw, for a launch inside the
   * rate limit. Not the notes: text from the internet stays out of `workspace.json`.
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
  /** Where the installer is saved: ~/Downloads in the app. Absent, fetching it refuses. */
  downloadsDirectory?: string
  /** Opens a file with its default app, answering an error or ''; `shell.openPath` in the app. */
  openPath?: (path: string) => Promise<string>
  /** Which hosts a download may touch. Tests only; the app keeps the release hosts. */
  allowDownload?: HostPolicy
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
  readonly #downloadsDirectory: string | undefined
  readonly #openPath: ((path: string) => Promise<string>) | undefined
  readonly #allowDownload: HostPolicy
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
  #download: UpdateDownload | null = null
  #abortDownload: AbortController | undefined

  constructor(options: UpdateServiceOptions) {
    this.#version = options.version
    this.#repository = options.repository ?? UPDATE_REPOSITORY
    this.#settings = options.settings
    this.#readRelease =
      options.readRelease ??
      ((channel) => readLatestRelease({ channel, repository: this.#repository, version: this.#version }))
    this.#openExternal = options.openExternal
    this.#downloadsDirectory = options.downloadsDirectory
    this.#openPath = options.openPath
    this.#allowDownload = options.allowDownload ?? releaseHostPolicy(this.#repository)
    this.#onChange = options.onChange ?? (() => {})
    this.#onProblem = options.onProblem ?? ((message) => console.warn(`[updates] ${message}`))
    this.#now = options.now ?? Date.now
    this.#schedule = options.schedule ?? scheduleWithTimeout
  }

  /** Arms the automatic check. The preference is read when the timer fires, not now. */
  start(): void {
    if (!this.#checkable()) return
    this.#cancelScheduled?.()
    this.#cancelScheduled = this.#schedule(() => {
      this.#cancelScheduled = undefined
      if (!this.#settings.read().automatic) return
      void this.check()
    }, STARTUP_CHECK_DELAY_MS)
  }

  /** Drops the pending check and any download. A quit must not be waiting on either. */
  stop(): void {
    this.#cancelScheduled?.()
    this.#cancelScheduled = undefined
    this.#abortDownload?.abort()
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
      problem: this.#problem,
      download: this.#download
    }
  }

  /** Asks GitHub, unless asked recently enough; `force` is a person asking, whom the rate limit does not refuse. */
  async check(options: { force?: boolean } = {}): Promise<UpdateState> {
    // A second caller joins the check already running.
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
    // Before the await so a button can go quiet immediately.
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
      this.#settings.rememberLatest(release?.version ?? null)
    } catch (error) {
      this.#problem = describe(error)
      this.#onProblem(`could not read the latest release: ${this.#problem}`, error)
    } finally {
      // A refused request was still a request, so it counts against the limit.
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
   * Opens the download in the user's browser. No URL parameter: anything that
   * can reach this runtime could otherwise name a page for the browser to open.
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

  /** Starts fetching the newer release's `.dmg` into Downloads; progress is told through `onChange`. */
  async fetchInstaller(): Promise<UpdateState> {
    if (this.#download?.state === 'downloading') return this.state()
    const available = this.state().available
    const image = this.#latest?.installer ?? null
    if (available === null || image === null) throw conflict('there is no installer to download')
    if (this.#downloadsDirectory === undefined) throw internal('this runtime has nowhere to save a download')

    const abort = new AbortController()
    this.#abortDownload = abort
    this.#download = { state: 'downloading', version: available.version, received: 0, total: image.size }
    this.#onChange()
    void this.#fetch(image, available.version, this.#downloadsDirectory, abort.signal)
    return this.state()
  }

  async #fetch(image: DiskImage, version: string, directory: string, signal: AbortSignal): Promise<void> {
    let percent = 0
    try {
      const path = await downloadDiskImage({
        image,
        directory,
        allowed: this.#allowDownload,
        signal,
        onProgress: (received) => {
          this.#download = { state: 'downloading', version, received, total: image.size }
          // A window re-reads the state on every change, so it hears whole percents only.
          const now = Math.floor((received * 100) / image.size)
          if (now > percent) {
            percent = now
            this.#onChange()
          }
        }
      })
      this.#download = { state: 'ready', version, path }
    } catch (error) {
      if (signal.aborted) {
        this.#download = null
        return
      }
      const problem =
        error instanceof ChecksumMismatch
          ? 'Checksum mismatch; the file was deleted.'
          : `Download failed: ${describe(error)}`
      this.#download = { state: 'failed', version, problem }
      this.#onProblem(`could not download ${image.name}: ${describe(error)}`, error)
    } finally {
      this.#abortDownload = undefined
      this.#onChange()
    }
  }

  /** Opens the verified `.dmg`, which mounts it. Nothing else can be named. */
  async openInstaller(): Promise<{ opened: string }> {
    const download = this.#download
    if (download?.state !== 'ready') throw conflict('there is no installer downloaded')
    if (this.#openPath === undefined) throw internal('this runtime cannot open a file')
    const failure = await this.#openPath(download.path)
    if (failure !== '') {
      // Most likely moved or deleted since; the button goes back to Download.
      this.#download = null
      this.#onChange()
      throw internal(`could not open ${download.path}: ${failure}`)
    }
    return { opened: download.path }
  }

  /** Whether a release can be compared against this build; the dev placeholder parses as a pre-release of 0.0.0. */
  #checkable(): boolean {
    return this.#version !== DEV_VERSION && parseVersion(this.#version) !== null
  }

  /** Which releases this build is offered: running a candidate is how somebody opts into candidates. */
  #channel(): ReleaseChannel {
    const current = parseVersion(this.#version)
    return current !== null && isPrereleaseVersion(current) ? 'prerelease' : 'stable'
  }

  /** The release worth interrupting somebody for, or null: this session's check first, else the remembered version. */
  #available(remembered: string | null): UpdateRelease | null {
    const current = parseVersion(this.#version)
    if (current === null) return null

    if (this.#latest !== null) {
      const found = parseVersion(this.#latest.version)
      if (found === null || !isNewerRelease(found, current)) return null
      const { version, tag, notes, downloadUrl, releaseUrl, publishedAt, installer } = this.#latest
      const offered = installer === null ? null : { name: installer.name, size: installer.size }
      return { version, tag, notes, downloadUrl, releaseUrl, publishedAt, installer: offered }
    }

    if (remembered === null) return null
    // A preference turned off is not outlived by what an earlier run learned.
    if (!this.#settings.read().automatic) return null

    const seen = parseVersion(remembered)
    if (seen === null || !isNewerRelease(seen, current)) return null
    const tag = `v${seen.raw}`
    return {
      version: seen.raw,
      tag,
      // A guessed asset name is a link that 404s the day somebody renames one.
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
