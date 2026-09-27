// Settings › Panes › Keep Agents Running When teamree Quits. Off, this does nothing at all: no
// file, no socket, no process. On, it connects to the profile's pane host, starting one if none answers.

import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { PaneHostClient, type RemotePty, type RemoteSpawnOptions } from './client'
import { ensurePrivateDir, paneHostPaths, type HostSession, type PaneHostPaths } from './protocol'

/** How long a host just started gets to answer. */
const START_DEADLINE_MS = 5_000
const START_POLL_MS = 50

/** What the terminal manager needs of the host; see `TerminalSessionManagerOptions.paneHost`. */
export type PaneHostPort = {
  /** The host's sessions when this launch connected. */
  live(): readonly HostSession[]
  /** Whether a new pane starts in the host now. */
  accepting(): boolean
  spawn(terminal: string, file: string, args: string[], options: RemoteSpawnOptions): RemotePty
  attach(session: HostSession, since?: number): RemotePty
  kill(sessionId: string): void
  /** Whether a quit leaves the hosted panes running. */
  keeps(): boolean
  /** Detaches when `keep`, else stops the host and every pty in it. */
  release(keep: boolean): Promise<void>
}

export type PaneHostingOptions = {
  userDataDir: string
  appVersion: string
  enabled: () => boolean
  /** `out/main/paneHost.js`; absent, no host is ever started. */
  entry?: string
  /** Seam for the tests; `child_process.spawn`, detached, by default. */
  startHost?: (execPath: string, args: string[], env: NodeJS.ProcessEnv) => void
  onProblem?: (reason: string) => void
}

export class PaneHosting implements PaneHostPort {
  #client: PaneHostClient | undefined
  #opening: Promise<void> | undefined

  constructor(private readonly options: PaneHostingOptions) {}

  /** Connects when the setting is on and nothing is connected; with it off, returns without touching anything. */
  open(): Promise<void> {
    if (!this.options.enabled() || this.options.entry === undefined || process.platform === 'win32') {
      return Promise.resolve()
    }
    if (this.#client?.connected) return Promise.resolve()
    this.#opening ??= this.#connectOrStart().finally(() => (this.#opening = undefined))
    return this.#opening
  }

  live(): readonly HostSession[] {
    return this.#client?.sessions ?? []
  }

  accepting(): boolean {
    return this.options.enabled() && this.#client?.connected === true
  }

  keeps(): boolean {
    return this.accepting()
  }

  spawn(terminal: string, file: string, args: string[], options: RemoteSpawnOptions): RemotePty {
    if (this.#client === undefined) throw new Error('no pane host')
    return this.#client.spawn(terminal, file, args, options)
  }

  attach(session: HostSession, since?: number): RemotePty {
    if (this.#client === undefined) throw new Error('no pane host')
    return this.#client.attach(session, since)
  }

  kill(sessionId: string): void {
    this.#client?.kill(sessionId)
  }

  async release(keep: boolean): Promise<void> {
    const client = this.#client
    this.#client = undefined
    if (client === undefined) return
    await (keep ? client.detach() : client.shutdown())
  }

  async #connectOrStart(): Promise<void> {
    const problem = this.options.onProblem ?? ((reason) => console.warn('[pane host]', reason))
    let paths: PaneHostPaths
    try {
      paths = paneHostPaths(this.options.userDataDir)
      ensurePrivateDir(paths.dir)
      ensurePrivateDir(dirname(paths.socket))
    } catch (error) {
      problem(`panes run in process: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const connect = () =>
      PaneHostClient.connect({ socket: paths.socket, tokenPath: paths.token, appVersion: this.options.appVersion })

    let result = await connect()
    if ('absent' in result) {
      this.#start(paths)
      const deadline = Date.now() + START_DEADLINE_MS
      while ('absent' in result && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, START_POLL_MS))
        result = await connect()
      }
    }
    if ('client' in result) this.#client = result.client
    else problem(`panes run in process: ${'refused' in result ? result.refused : 'the host did not start'}`)
  }

  #start(paths: PaneHostPaths): void {
    const execPath = process.execPath
    const args = [
      this.options.entry as string,
      '--socket',
      paths.socket,
      '--token',
      paths.token,
      '--log',
      paths.log,
      '--version',
      this.options.appVersion
    ]
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    if (this.options.startHost !== undefined) {
      this.options.startHost(execPath, args, env)
      return
    }
    // Detached: its own session, so a signal to the app's process group never reaches it.
    const child = spawn(execPath, args, { detached: true, stdio: 'ignore', env, cwd: paths.dir })
    child.on('error', () => {})
    child.unref()
  }
}
