// Putting this app's own CLI on PATH at `/usr/local/bin`, which on Apple
// Silicon is root:wheel 755 (Homebrew lives in /opt/homebrew), so the password
// path is the ordinary one. Refuses to overwrite a file; a link already right is success.

import { access, constants, lstat, mkdir, readFile, readlink, realpath, stat, symlink, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CliImpermanence, CliInstall, CliPathSource, CliStatus } from '../../shared/entities'
import { conflict, internal, notFound } from '../runtime/runtimeError'
import { loginShellPath } from '../terminals/shell-environment'
import { linkCommand, type AdministratorRunner } from './administrator'

/** Where the link goes. Not configurable; see the note at the top of the file. */
export const CLI_DESTINATION_DIRECTORY = '/usr/local/bin'

/** What it is called there, which is what the user will type. */
export const CLI_COMMAND_NAME = 'teamree'

/**
 * Whether a link to this path would still lead somewhere tomorrow: a mounted
 * DMG dangles at the eject, and App Translocation runs a downloaded app from a
 * per-boot temporary copy (matched on both halves of the path, since either alone is ordinary).
 */
function impermanentSource(source: string): CliImpermanence | null {
  if (source.startsWith('/Volumes/')) return 'volume'
  const temporary = source.startsWith('/private/var/folders/') || source.startsWith('/var/folders/')
  return temporary && source.split('/').includes('AppTranslocation') ? 'translocated' : null
}

/**
 * The file `path_helper` builds every login shell's PATH from. `/etc/paths.d`
 * is deliberately not read: `/usr/local/bin` is in the stock `/etc/paths`.
 */
export const LOGIN_PATHS_FILE = '/etc/paths'

/** Where the answer to "shall I put this on your PATH?" is kept. A seam, not a store. */
export type CliPromptRecord = {
  askedAt: () => number | undefined
  markAsked: (at: number) => void
}

export type CliServiceOptions = {
  /** The CLI inside this app. Null when this build has none to link. */
  source: string | null
  /** Whether that CLI is a packaged app's rather than a source checkout's. */
  packaged?: boolean
  /** Where the one-time question's answer is remembered. Defaults to this process. */
  prompt?: CliPromptRecord
  /** Injected so a test never goes near the real one. */
  directory?: string
  platform?: NodeJS.Platform
  /** The environment PATH is read from. Passed in for the same reason. */
  env?: NodeJS.ProcessEnv
  /** Whether the directory can be written without a password. */
  writable?: (directory: string) => Promise<boolean>
  /** Runs one shell command as an administrator. */
  administrator?: AdministratorRunner
  /** The login shell's PATH directories. */
  loginPaths?: () => Promise<string[]>
  /** The login shell's own PATH, or undefined when it cannot be asked. A test seam. */
  shellPath?: () => string | undefined
  now?: () => number
}

export class CliService {
  readonly #source: string | null
  readonly #packaged: boolean
  readonly #prompt: CliPromptRecord
  readonly #directory: string
  readonly #platform: NodeJS.Platform
  readonly #env: NodeJS.ProcessEnv
  readonly #writable: (directory: string) => Promise<boolean>
  readonly #administrator: AdministratorRunner | undefined
  readonly #loginPaths: () => Promise<string[]>
  readonly #shellPath: () => string | undefined
  readonly #now: () => number

  constructor(options: CliServiceOptions) {
    this.#source = options.source
    this.#packaged = options.packaged ?? false
    this.#prompt = options.prompt ?? inMemoryPrompt()
    this.#directory = options.directory ?? CLI_DESTINATION_DIRECTORY
    this.#platform = options.platform ?? process.platform
    this.#env = options.env ?? process.env
    this.#writable = options.writable ?? canWrite
    this.#administrator = options.administrator
    this.#loginPaths = options.loginPaths ?? readLoginPaths
    // The same probe every pane is built with, and the same cached answer.
    this.#shellPath = options.shellPath ?? (() => loginShellPath({ platform: this.#platform }))
    this.#now = options.now ?? Date.now
  }

  async status(): Promise<CliStatus> {
    const destination = join(this.#directory, CLI_COMMAND_NAME)
    const { state, resolved, dangling } = await this.#describeDestination(destination)
    return {
      installable: this.#platform === 'darwin',
      platform: this.#platform,
      source: this.#source,
      packaged: this.#packaged,
      bundle: await this.#bundle(),
      impermanent: this.#source === null ? null : impermanentSource(this.#source),
      destination,
      directory: this.#directory,
      state,
      resolved,
      dangling,
      needsAdministrator: !(await this.#writable(this.#directory)),
      onPath: await this.#onPath(),
      askedAt: this.#prompt.askedAt() ?? null,
      readAt: this.#now()
    }
  }

  async install(): Promise<CliInstall> {
    const before = await this.status()

    if (!before.installable) {
      throw conflict(
        `teamree can only put the CLI on PATH itself on macOS. On ${before.platform}, link it yourself: ` +
          `ln -s ${before.source ?? '<the app>/resources/cli/teamree'} ${before.destination}`
      )
    }
    const source = before.source
    if (source === null) {
      throw notFound(
        'This build of teamree has no CLI in it to link. A packaged app carries one in Contents/Resources/cli.'
      )
    }
    // Ahead of everything, the link that may already be right included: a link
    // made from here reads back fine and the user finds out at the eject.
    if (before.impermanent !== null) {
      throw conflict(
        (before.impermanent === 'volume'
          ? `teamree is running from ${source}, on a mounted volume. A link into it stops leading anywhere the ` +
            'moment the volume is ejected. '
          : `macOS is running teamree from ${source}, a temporary copy of itself. That copy is gone by the next ` +
            'launch, and a link into it with it. ') +
          'Drag teamree to your Applications folder, open it from there, and press this again.'
      )
    }
    // A launcher with nothing behind it cannot become a working command by being linked.
    if (before.bundle === null) {
      throw notFound(
        `${source} is the launcher, and the CLI bundle it runs has not been built. Linking it would put a ` +
          'teamree on your PATH that cannot start. Build it first: npm run build:cli'
      )
    }
    if (before.state === 'linked') {
      return { outcome: 'already-linked', replaced: null, administrator: false, status: await this.#answered(before) }
    }
    if (before.state === 'file' || before.state === 'directory') {
      const what = before.state === 'file' ? 'a regular file' : 'a directory'
      throw conflict(
        `There is ${what} at ${before.destination}, and teamree will not delete it. ` + 'Move it aside and try again.'
      )
    }

    const administrator = before.needsAdministrator
    if (administrator) await this.#escalate(source, before.destination)
    else await this.#link(source, before.destination, before.state === 'elsewhere')

    // Read back rather than assumed: a privileged command exiting zero is not a link that lands.
    const after = await this.status()
    if (after.state !== 'linked') {
      throw internal(
        `${after.destination} does not lead to ${source} after linking it` +
          (after.resolved === null ? '' : ` — it leads to ${after.resolved}`)
      )
    }
    return {
      outcome: before.state === 'elsewhere' ? 'replaced' : 'linked',
      replaced: before.resolved,
      administrator,
      status: await this.#answered(after)
    }
  }

  /**
   * Records that the question has been answered, by a decline or by `install`.
   * A refusal is not an answer and does not get here.
   */
  async dismissPrompt(): Promise<CliStatus> {
    return this.#answered(await this.status())
  }

  async #answered(status: CliStatus): Promise<CliStatus> {
    if (status.askedAt !== null) return status
    const at = this.#now()
    this.#prompt.markAsked(at)
    return { ...status, askedAt: this.#prompt.askedAt() ?? at }
  }

  async #escalate(source: string, destination: string): Promise<void> {
    const administrator = this.#administrator
    if (administrator === undefined) {
      throw internal(`${this.#directory} cannot be written and this runtime has no way to ask for a password`)
    }
    await administrator(linkCommand(source, destination))
  }

  async #link(source: string, destination: string, replacing: boolean): Promise<void> {
    await mkdir(this.#directory, { recursive: true })
    // Only ever a symlink: every other kind of entry was refused above.
    if (replacing) await unlink(destination)
    await symlink(source, destination)
  }

  /**
   * The bundle the launcher would run, found the way `resources/cli/teamree`
   * finds it (`teamree.mjs` beside it, else `../../out/cli/index.js`), but
   * checked to exist, which the launcher does not do for the second.
   */
  async #bundle(): Promise<string | null> {
    const source = this.#source
    if (source === null) return null
    const here = dirname(await realpath(source).catch(() => source))
    for (const candidate of [join(here, 'teamree.mjs'), join(here, '..', '..', 'out', 'cli', 'index.js')]) {
      if (await isFile(candidate)) return candidate
    }
    return null
  }

  async #describeDestination(destination: string): Promise<Pick<CliStatus, 'state' | 'resolved' | 'dangling'>> {
    const entry = await lstat(destination).catch(() => null)
    if (entry === null) return { state: 'absent', resolved: null, dangling: false }
    if (entry.isSymbolicLink()) {
      // A dangling link still names somewhere; `realpath` failing is what tells
      // "the app was deleted" from "points at another app".
      const landed = await realpath(destination).catch(() => null)
      const resolved = landed ?? (await readlink(destination))
      const target = this.#source === null ? null : await realpath(this.#source).catch(() => this.#source)
      return { state: resolved === target ? 'linked' : 'elsewhere', resolved, dangling: landed === null }
    }
    return { state: entry.isDirectory() ? 'directory' : 'file', resolved: destination, dangling: false }
  }

  /**
   * Which PATH the destination is on. This process's PATH means nothing when it
   * says no (a Finder-opened app has no shell environment); the login shell's
   * is the one source allowed to say no, since a profile assigning `PATH=`
   * discards `/etc/paths`, which is read only where the shell cannot be asked.
   */
  async #onPath(): Promise<CliPathSource | null> {
    const wanted = withoutTrailingSlash(this.#directory)
    const entries = (this.#env.PATH ?? '').split(':').map(withoutTrailingSlash)
    if (entries.includes(wanted)) return 'environment'
    if (this.#platform !== 'darwin') return null

    const shell = this.#shellPath()
    if (shell !== undefined) {
      // A no here is a real no.
      return shell.split(':').map(withoutTrailingSlash).includes(wanted) ? 'shell' : null
    }

    const login = await this.#loginPaths().catch(() => [])
    return login.map(withoutTrailingSlash).includes(wanted) ? 'login' : null
  }
}

/** What a service built without anywhere to remember gets: this process. */
function inMemoryPrompt(): CliPromptRecord {
  let at: number | undefined
  return {
    askedAt: () => at,
    markAsked: (when) => {
      at ??= when
    }
  }
}

function withoutTrailingSlash(value: string): string {
  return value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value
}

/** `[ -f ]`, which is what the launcher tests its bundle with. */
async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false
}

async function canWrite(directory: string): Promise<boolean> {
  try {
    await access(directory, constants.W_OK)
    return true
  } catch {
    return false
  }
}

async function readLoginPaths(): Promise<string[]> {
  const text = await readFile(LOGIN_PATHS_FILE, 'utf8').catch(() => '')
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}
