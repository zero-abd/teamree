// Knowing that a newer teamree exists, fetching it, and replacing this copy after a quit
// (selfInstaller.ts; Squirrel.Mac refuses an ad-hoc signature). Where this copy cannot replace
// itself the verified `.dmg` is the way. Nothing waits on the network; a failure is a log line.

import type { UpdateDownload, UpdateInstall, UpdateRelease, UpdateState } from '../../shared/entities'
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
import { UntrustedRelease } from './releaseManifest'
import type { SelfInstall } from './selfInstaller'
import { isNewerRelease, isPrereleaseVersion, parseVersion } from './semver'
import { watchForWake, type WakeWatch } from './wakeWatch'

/** How often the automatic check re-arms itself: launch, then this clock, a wake, or a stale focus besides. */
export const AUTOMATIC_CHECK_INTERVAL_MS = 60 * 60 * 1000

/** The floor between two automatic checks, so a wake and a focus and this clock cannot stack past GitHub's limit. */
export const AUTOMATIC_CHECK_THROTTLE_MS = 10 * 60 * 1000

/** How long after startup the first automatic check is made; still late enough to share no moment with the restore. */
export const STARTUP_CHECK_DELAY_MS = 10_000

/** A window away this long is worth a fresh look on its return, throttle allowing. */
export const FOCUS_RECHECK_AFTER_MS = 30 * 60 * 1000

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
  /** Which hosts a download may touch. Refused outside the test runner; the app keeps the release hosts. */
  allowDownload?: HostPolicy
  /** Replaces this copy in place; absent where it cannot (not packaged, not macOS). */
  selfInstall?: SelfInstall
  /** How this machine hears that it woke from sleep. Defaults to Electron's `powerMonitor`. */
  watchWake?: WakeWatch
  /** Quits the way Quit does, questions included; `app.quit` in the app. */
  restart?: () => void
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
  readonly #selfInstall: SelfInstall | undefined
  readonly #watchWake: WakeWatch
  readonly #restart: (() => void) | undefined
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
  #install: UpdateInstall | null = null
  #abortInstall: AbortController | undefined
  #askedAt: number | null = null
  /** A version whose release failed its signature or version checks; never offered this run. */
  #untrusted: string | null = null
  /** Set once the staged copies left by an earlier run have been looked at. */
  #recovered: Promise<void> | undefined
  #started = false
  #unwatchWake: (() => void) | undefined
  /** When the window last lost focus; null once consumed by a return worth checking over. */
  #blurredAt: number | null = null

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
    if (options.allowDownload !== undefined && process.env['VITEST'] === undefined) {
      throw new Error('allowDownload is for tests; the app downloads only from the release hosts')
    }
    this.#allowDownload = options.allowDownload ?? releaseHostPolicy(this.#repository)
    this.#selfInstall = options.selfInstall
    this.#watchWake = options.watchWake ?? watchForWake
    this.#restart = options.restart
    this.#onChange = options.onChange ?? (() => {})
    this.#onProblem = options.onProblem ?? ((message) => console.warn(`[updates] ${message}`))
    this.#now = options.now ?? Date.now
    this.#schedule = options.schedule ?? scheduleWithTimeout
  }

  /** Arms the automatic check, then again every interval, and starts listening for a wake. */
  start(): void {
    if (!this.#checkable()) return
    this.#started = true
    this.#arm(STARTUP_CHECK_DELAY_MS)
    void this.#armWake()
  }

  async #armWake(): Promise<void> {
    this.#unwatchWake = await this.#watchWake(() => {
      if (!this.#settings.read().automatic) return
      void this.#automaticCheck()
    })
  }

  /** The window lost focus: the moment its return is measured against. */
  noteWindowBlur(): void {
    this.#blurredAt = this.#now()
  }

  /** The window came back from 30 or more minutes away: worth a look, same as a wake. */
  noteWindowFocus(): void {
    const blurredAt = this.#blurredAt
    this.#blurredAt = null
    if (blurredAt === null || this.#now() - blurredAt < FOCUS_RECHECK_AFTER_MS) return
    if (!this.#settings.read().automatic) return
    void this.#automaticCheck()
  }

  #arm(delayMs: number): void {
    this.#cancelScheduled?.()
    this.#cancelScheduled = this.#schedule(() => {
      this.#cancelScheduled = undefined
      this.#arm(AUTOMATIC_CHECK_INTERVAL_MS)
      if (!this.#settings.read().automatic) return
      void this.#automaticCheck()
    }, delayMs)
  }

  async #automaticCheck(): Promise<void> {
    await this.#recover()
    // A release seen earlier but not yet fetched is worth one request past the rate limit.
    const seen = parseVersion(this.#settings.read().lastSeenVersion ?? '')
    const current = parseVersion(this.#version)
    const pending =
      this.#selfInstall !== undefined &&
      this.#install === null &&
      seen !== null &&
      current !== null &&
      isNewerRelease(seen, current)
    await this.check({ force: pending })
  }

  /** Drops the pending check and any download, then starts the install a restart asked for. */
  stop(): void {
    this.#halt()
    this.#unwatchWake?.()
    this.#unwatchWake = undefined
    this.#selfInstall?.launch()
  }

  #halt(): void {
    this.#cancelScheduled?.()
    this.#cancelScheduled = undefined
    this.#abortDownload?.abort()
    this.#abortInstall?.abort()
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
      download: this.#download,
      install: this.#install,
      askedAt: this.#askedAt
    }
  }

  /** Asks GitHub, unless asked recently enough; `force` is a person asking, whom the rate limit does not refuse. */
  async check(options: { force?: boolean; person?: boolean } = {}): Promise<UpdateState> {
    // A second caller joins the check already running.
    if (this.#inFlight) return this.#inFlight

    if (!this.#checkable()) {
      this.#problem = `This build reports ${this.#version}, which is not a released version, so there is nothing to compare it against.`
      this.#onChange()
      return this.state()
    }

    const now = this.#now()
    const last = this.#settings.read().lastCheckedAt
    if (options.force !== true && last !== null && now - last < AUTOMATIC_CHECK_THROTTLE_MS) {
      return this.state()
    }
    if (options.person === true) this.#askedAt = now

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
      const version = release?.version ?? null
      this.#settings.rememberLatest(version === this.#untrusted ? null : version)
      if (release !== null && this.state().available !== null) this.#prepare(release)
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
    if (!automatic) this.#halt()
    else if (this.#started && this.#cancelScheduled === undefined) this.#arm(STARTUP_CHECK_DELAY_MS)
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

  /** Fetches and stages `release` in the background, unless it already is; a refusal leaves the `.dmg` path. */
  #prepare(release: LatestRelease): void {
    const installer = this.#selfInstall
    if (installer === undefined) return
    const { version } = release
    if (this.#install?.version === version && this.#install.state !== 'failed') return

    this.#abortInstall?.abort()
    const abort = new AbortController()
    this.#abortInstall = abort
    // Set before any await, so the window never shows the `.dmg` card for a moment first.
    this.#install = { state: 'downloading', version, received: 0, total: 0 }
    void (async () => {
      try {
        await this.#recover()
        const refused = await installer.refusal()
        if (refused !== null) {
          this.#install = null
          this.#onProblem(`this copy cannot replace itself: ${refused}`, new Error(refused))
          return
        }
        let percent = 0
        let total = 0
        await installer.prepare(release, {
          allowed: this.#allowDownload,
          signal: abort.signal,
          onSize: (size) => {
            total = size
          },
          onProgress: (received) => {
            this.#install = { state: 'downloading', version, received, total }
            const now = Math.floor((received * 100) / Math.max(total, 1))
            if (now > percent) {
              percent = now
              this.#onChange()
            }
          }
        })
        this.#install = { state: 'ready', version }
      } catch (error) {
        if (abort.signal.aborted) {
          this.#install = null
          return
        }
        if (error instanceof UntrustedRelease) {
          this.#install = null
          this.#untrusted = version
          this.#settings.rememberLatest(null)
          this.#onProblem(`ignoring ${version}: ${error.message}`, error)
          return
        }
        this.#install = { state: 'failed', version, problem: `Update failed: ${describe(error)}` }
        this.#onProblem(`could not stage ${version}: ${describe(error)}`, error)
      } finally {
        if (this.#abortInstall === abort) this.#abortInstall = undefined
        this.#onChange()
      }
    })()
  }

  /** Picks up a copy an earlier run fetched but did not install, once per run. */
  #recover(): Promise<void> {
    const installer = this.#selfInstall
    if (installer === undefined) return Promise.resolve()
    this.#recovered ??= (async () => {
      const current = parseVersion(this.#version)
      try {
        const found = await installer.recover((candidate) => {
          const version = parseVersion(candidate)
          return version !== null && current !== null && isNewerRelease(version, current)
        })
        if (found !== null && this.#install === null) {
          this.#install = { state: 'ready', version: found }
          this.#onChange()
        }
      } catch (error) {
        this.#onProblem(`could not read the staged update: ${describe(error)}`, error)
      }
    })()
    return this.#recovered
  }

  /**
   * Quits through the app's own quit, whose questions still apply; the swap starts once it is past them.
   * A swap macOS would refuse is found first, and then nothing quits: the card says why.
   */
  async restartToUpdate(): Promise<{ restarting: string } | { blocked: string }> {
    const install = this.#install
    if (install?.state !== 'ready') throw conflict('there is no update ready to install')
    if (this.#selfInstall === undefined || this.#restart === undefined)
      throw internal('this copy cannot restart itself')
    const { version } = install
    const blocked = await this.#selfInstall.preflight()
    this.#install = blocked === null ? { state: 'ready', version } : { state: 'ready', version, blocked }
    if (blocked !== null) {
      this.#onChange()
      return { blocked: blocked.problem }
    }
    await this.#selfInstall.arm(version, true)
    this.#restart()
    return { restarting: version }
  }

  /** The quit was declined (Cancel on a Save question): the next ordinary quit installs nothing. */
  quitDeclined(): void {
    this.#selfInstall?.disarm()
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
      if (this.#latest.version === this.#untrusted) return null
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
