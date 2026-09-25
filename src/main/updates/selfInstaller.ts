// Replacing the running bundle with a release's: the zip named by the release's manifest is
// fetched and verified, unpacked beside the profile and checked, and after the app quits a
// helper script swaps it in. Anything unexpected refuses, and the disk image remains the way.

import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { mkdir, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { UpdateBlock } from '../../shared/entities'
import { macBundleProbe, locationRefusal, stagingRefusal, type BundleFacts, type BundleProbe } from './bundleCheck'
import { downloadDiskImage, type HostPolicy } from './downloadInstaller'
import { helperScript, launchHelper } from './installHelper'
import type { LatestRelease } from './latestRelease'
import { MANIFEST_NAME, promisedArchive, readManifest } from './releaseManifest'
import { compareVersions, parseVersion, type Version } from './semver'

export const UPDATE_LOG_NAME = 'update.log'

const HELPER_NAME = 'install.sh'

export type SelfInstallerOptions = {
  /** The running `.app`. */
  bundlePath: string
  /** A folder in the profile that holds nothing else; `<userData>/updates` in the app. */
  stagingRoot: string
  pid?: number
  probe?: BundleProbe
  /** What relaunches the app; `/usr/bin/open` unless a test names a stand-in. */
  opener?: string
  writable?: (path: string) => boolean
  launch?: (script: string) => void
}

export type PrepareOptions = {
  allowed: HostPolicy
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  /** Told the archive's size once the manifest has named it, then each byte count. */
  onSize?: (total: number) => void
  onProgress?: (received: number) => void
}

/** What `SelfInstaller` does for `UpdateService`; a seam so the service's tests need no bundle. */
export type SelfInstall = Pick<
  SelfInstaller,
  'refusal' | 'prepare' | 'recover' | 'arm' | 'launch' | 'disarm' | 'preflight'
>

export class SelfInstaller {
  readonly #bundle: string
  readonly #root: string
  readonly #pid: number
  readonly #probe: BundleProbe
  readonly #opener: string
  readonly #writable: (path: string) => boolean
  readonly #launch: (script: string) => void
  #running: Promise<BundleFacts | string> | undefined
  #armed: string | undefined

  constructor(options: SelfInstallerOptions) {
    this.#bundle = options.bundlePath
    this.#root = options.stagingRoot
    this.#pid = options.pid ?? process.pid
    this.#probe = options.probe ?? macBundleProbe
    this.#opener = options.opener ?? '/usr/bin/open'
    this.#writable = options.writable ?? isWritable
    this.#launch = options.launch ?? launchHelper
  }

  /** Why this copy cannot replace itself, or null when it can. */
  async refusal(): Promise<string | null> {
    const running = await this.#facts()
    return typeof running === 'string' ? running : null
  }

  /** Fetches, verifies and unpacks `release` into `<stagingRoot>/<version>`; throws with the reason otherwise. */
  async prepare(release: LatestRelease, options: PrepareOptions): Promise<void> {
    const running = await this.#facts()
    if (typeof running === 'string') throw new Error(running)

    const listed = release.assets?.find((asset) => asset.name === MANIFEST_NAME)
    if (listed === undefined) throw new Error(`the release has no ${MANIFEST_NAME}`)
    const { allowed, fetchImpl, signal } = options
    const manifest = await readManifest({ url: listed.url, allowed, fetchImpl, signal })
    if (manifest === null) throw new Error(`${MANIFEST_NAME} is not a manifest`)
    const archive = promisedArchive(manifest, release)
    if (archive === null) throw new Error(`${MANIFEST_NAME} does not match the release`)
    options.onSize?.(archive.size)

    await mkdir(this.#root, { recursive: true })
    const zip = await downloadDiskImage({
      image: archive,
      directory: this.#root,
      allowed,
      fetchImpl,
      signal,
      onProgress: options.onProgress
    })
    const unpacked = join(this.#root, `${release.version}.partial`)
    try {
      await rm(unpacked, { recursive: true, force: true })
      await mkdir(unpacked)
      // ditto copies a quarantined archive's flag onto every file it unpacks; only the first install asks Gatekeeper.
      await removeQuarantine(zip)
      await ditto(['-x', '-k', zip, unpacked])
      await removeQuarantine(unpacked)
      await this.#accept(unpacked, running, release.version)
      const staged = join(this.#root, release.version)
      await rm(staged, { recursive: true, force: true })
      await rename(unpacked, staged)
    } finally {
      await rm(unpacked, { recursive: true, force: true })
      await rm(zip, { force: true })
    }
  }

  /** The newest staged version `wanted` accepts that still verifies; everything else staged is deleted. */
  async recover(wanted: (version: string) => boolean): Promise<string | null> {
    const running = await this.#facts()
    let entries: string[]
    try {
      entries = await readdir(this.#root)
    } catch {
      return null
    }
    const kept = entries
      .filter((name) => parseVersion(name) !== null && wanted(name))
      .sort((a, b) => compareVersions(parseVersion(b) as Version, parseVersion(a) as Version))[0]
    let found: string | null = null
    if (kept !== undefined && typeof running !== 'string') {
      try {
        await this.#accept(join(this.#root, kept), running, kept)
        found = kept
      } catch {
        // Tampered with or half-deleted since; it is fetched again.
      }
    }
    await Promise.all(
      entries
        .filter((name) => name !== found && name !== UPDATE_LOG_NAME)
        .map((name) => rm(join(this.#root, name), { recursive: true, force: true }))
    )
    return found
  }

  /** What would stop the swap after the quit, tried now while quitting can still be called off. */
  preflight(): Promise<UpdateBlock | null> {
    return swapBlock(this.#bundle)
  }

  /** Writes the helper for `version`, to be started by `launch` once the quit is past its questions. */
  async arm(version: string, foreground: boolean): Promise<void> {
    const staged = join(this.#root, version)
    const script = join(this.#root, HELPER_NAME)
    await writeFile(
      script,
      helperScript({
        pid: this.#pid,
        target: this.#bundle,
        staged: join(staged, await onlyApp(staged)),
        log: join(this.#root, UPDATE_LOG_NAME),
        version,
        opener: this.#opener,
        ...relaunchOptions(process.env, foreground)
      }),
      { mode: 0o700 }
    )
    this.#armed = script
  }

  /** Starts the armed helper, which waits for this process to exit. Does nothing unless armed. */
  launch(): void {
    const script = this.#armed
    this.#armed = undefined
    if (script !== undefined) this.#launch(script)
  }

  disarm(): void {
    this.#armed = undefined
  }

  #facts(): Promise<BundleFacts | string> {
    this.#running ??= (async () => {
      const refused = locationRefusal(this.#bundle, this.#writable)
      if (refused !== null) return refused
      const facts = await this.#probe(this.#bundle)
      if (facts === null) return 'this copy has no readable Info.plist'
      if (!facts.signature.valid) return "this copy's signature does not verify"
      return facts
    })()
    return this.#running
  }

  async #accept(folder: string, running: BundleFacts, version: string): Promise<void> {
    const staged = await this.#probe(join(folder, await onlyApp(folder)))
    const refused = stagingRefusal({ staged, running, version })
    if (refused !== null) throw new Error(refused)
  }
}

/** The variables a throwaway profile was started with, so the relaunch lands on it and stays behind if it was. */
export function relaunchOptions(
  env: NodeJS.ProcessEnv,
  clicked: boolean
): { foreground: boolean; env: Record<string, string> } {
  const kept: Record<string, string> = {}
  for (const name of ['TEAMREE_USER_DATA_DIR', 'TEAMREE_WORKTREES_ROOT', 'TEAMREE_BACKGROUND_LAUNCH']) {
    const value = env[name]
    if (value) kept[name] = value
  }
  return { foreground: clicked && env['TEAMREE_BACKGROUND_LAUNCH'] !== '1', env: kept }
}

/**
 * The swap's two kinds of step, each tried and undone: a folder made and renamed beside `bundle`, and a
 * file written inside it, which App Management refuses. A missing bundle blocks nothing; the helper installs there.
 */
export async function swapBlock(bundle: string): Promise<UpdateBlock | null> {
  const folder = dirname(bundle)
  const probe = join(folder, `.teamree-check-${process.pid}`)
  try {
    await mkdir(probe)
    await rename(probe, `${probe}-moved`)
    await rmdir(`${probe}-moved`)
  } catch (error) {
    await rm(probe, { recursive: true, force: true }).catch(() => undefined)
    await rm(`${probe}-moved`, { recursive: true, force: true }).catch(() => undefined)
    return { problem: `Can't write to ${folder}: ${code(error)}`, settings: false }
  }
  const inside = join(bundle, 'Contents', `.teamree-check-${process.pid}`)
  try {
    await writeFile(inside, '')
    await rm(inside, { force: true })
  } catch (error) {
    if (code(error) === 'ENOENT') return null
    await rm(inside, { force: true }).catch(() => undefined)
    return code(error) === 'EPERM'
      ? { problem: 'macOS blocked the update', settings: true }
      : { problem: `Can't write to ${bundle}: ${code(error)}`, settings: false }
  }
  return null
}

function code(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? String(error)
}

/** The one `.app` in `folder`; an archive holding anything else is not one this project made. */
async function onlyApp(folder: string): Promise<string> {
  const entries = (await readdir(folder)).filter((name) => name !== '__MACOSX')
  if (entries.length !== 1 || !entries[0]?.endsWith('.app')) throw new Error('the archive held no single app')
  return entries[0]
}

function ditto(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/ditto', args, { timeout: 600_000 }, (error) => (error ? reject(error) : resolve()))
  })
}

/** Exits non-zero when there was no flag to remove, which is the usual case. */
function removeQuarantine(path: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', path], { timeout: 120_000 }, () => resolve())
  })
}

function isWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}
