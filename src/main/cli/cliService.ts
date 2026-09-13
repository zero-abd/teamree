// Putting this app's own CLI on PATH.
//
// The destination is not a choice. `/usr/local/bin` is where a Mac developer
// expects a command to be and it is already on the PATH every login shell gets,
// so offering a directory picker would be offering a way to get it wrong. What
// the user is asked is the one thing only they can answer: their password, and
// only when the directory cannot be written without it — which on a Mac with
// Homebrew it usually can.
//
// Three things here are refusals rather than conveniences, and each of them is
// somebody's afternoon:
//
//   - A regular file at the destination is not overwritten. It is somebody's
//     binary; teamree says what is there and stops.
//   - A link that already points at this app is success. The button is
//     idempotent, and pressing it twice must not read as a failure.
//   - Nothing is reported as done until the link has been resolved and found to
//     land on this app's CLI. A privileged command that was run is not the same
//     fact as a link that works.

import { access, constants, lstat, mkdir, readFile, readlink, realpath, symlink, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { CliInstall, CliPathSource, CliStatus } from '../../shared/entities'
import { conflict, internal, notFound } from '../runtime/runtimeError'
import { linkCommand, type AdministratorRunner } from './administrator'

/** Where the link goes. Not configurable; see the note at the top of the file. */
export const CLI_DESTINATION_DIRECTORY = '/usr/local/bin'

/** What it is called there, which is what the user will type. */
export const CLI_COMMAND_NAME = 'teamree'

/**
 * The file `path_helper` builds every login shell's PATH from.
 *
 * Read because an app opened from Finder inherits no shell environment, so this
 * process's own PATH cannot answer "will `teamree` be found in my terminal".
 * `/etc/paths.d` is deliberately not read: this is asked about one directory,
 * `/usr/local/bin` is in the stock `/etc/paths`, and a partial answer that is
 * right about the question being asked beats a thorough one nobody can check.
 */
export const LOGIN_PATHS_FILE = '/etc/paths'

/**
 * Where the answer to "shall I put this on your PATH?" is kept.
 *
 * A seam rather than a store, because the service has no business knowing what
 * a workspace file is — and because a test has to be able to watch what was
 * written down without one.
 */
export type CliPromptRecord = {
  askedAt: () => number | undefined
  markAsked: (at: number) => void
}

export type CliServiceOptions = {
  /** The CLI inside this app. Null when this build has none to link. */
  source: string | null
  /** Whether that CLI is a packaged app's rather than a source checkout's. */
  packaged?: boolean
  /**
   * Where the one-time question's answer is remembered. Defaults to this
   * process, which is the most a runtime with nowhere to write can honestly
   * promise — and is what the acceptance harness gets.
   */
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
    this.#now = options.now ?? Date.now
  }

  async status(): Promise<CliStatus> {
    const destination = join(this.#directory, CLI_COMMAND_NAME)
    const { state, resolved } = await this.#describeDestination(destination)
    return {
      installable: this.#platform === 'darwin',
      platform: this.#platform,
      source: this.#source,
      packaged: this.#packaged,
      destination,
      directory: this.#directory,
      state,
      resolved,
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
      throw notFound('This build of teamree has no CLI in it to link, so there is nothing to put on PATH.')
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

    // Read back rather than assumed. A privileged command that exited zero and
    // a link that lands on this app's CLI are two different facts, and only the
    // second one is what the caller is about to be told.
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
   * Records that the question has been put and answered, without asking it.
   *
   * Called when somebody declines the offer — and, from `install`, when they
   * accept it, because pressing the button is as complete an answer as saying
   * no. A refusal is not an answer and does not get here: there was nothing
   * for the user to decide.
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

  async #describeDestination(destination: string): Promise<Pick<CliStatus, 'state' | 'resolved'>> {
    const entry = await lstat(destination).catch(() => null)
    if (entry === null) return { state: 'absent', resolved: null }
    if (entry.isSymbolicLink()) {
      // A link that leads nowhere still leads somewhere nameable, and naming it
      // is how "the app it pointed at has been deleted" reads as itself rather
      // than as an empty destination.
      const resolved = await realpath(destination).catch(() => readlink(destination))
      const target = this.#source === null ? null : await realpath(this.#source).catch(() => this.#source)
      return { state: resolved === target ? 'linked' : 'elsewhere', resolved }
    }
    return { state: entry.isDirectory() ? 'directory' : 'file', resolved: destination }
  }

  async #onPath(): Promise<CliPathSource | null> {
    const wanted = withoutTrailingSlash(this.#directory)
    const entries = (this.#env.PATH ?? '').split(':').map(withoutTrailingSlash)
    if (entries.includes(wanted)) return 'environment'
    if (this.#platform !== 'darwin') return null
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
