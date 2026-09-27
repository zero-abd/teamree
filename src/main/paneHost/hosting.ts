// Settings › Panes › Keep Agents Running When teamree Quits. Off, this does nothing at all: no
// file, no socket, no process. On, it connects to the profile's pane host, starting one if none answers.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { PaneHostClient, type RemotePty, type RemoteSpawnOptions } from './client'
import { ensurePrivateDir, paneHostPaths, type HostSession, type PaneHostPaths } from './protocol'

/** How long a host just started gets to answer. */
const START_DEADLINE_MS = 5_000
const START_POLL_MS = 50
/** How long a stopped host gets to end its panes and exit. */
const STOP_DEADLINE_MS = 5_000

/** A running host: its pid, and its live panes when no app of ours is attached to count them. */
export type HostSighting = { pid: number; panes?: number }

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
  /** The host this app is attached to, else one left running without it; null when none answers. */
  status(): Promise<HostSighting | null>
  /** Ends the host and every pane in it, and waits for it to exit. */
  stop(): Promise<HostSighting | null>
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

  // Both wait for a connect in flight: a second hello would take the host from it.
  async status(): Promise<HostSighting | null> {
    await this.#opening
    const client = this.#client
    if (client?.connected === true) return { pid: client.hostPid }
    return peekHost(this.options.userDataDir, this.options.appVersion)
  }

  async stop(): Promise<HostSighting | null> {
    await this.#opening
    const client = this.#client
    if (client?.connected !== true) return stopHost(this.options.userDataDir, this.options.appVersion)
    this.#client = undefined
    await client.stop()
    await exited(client.hostPid)
    // Still on, the next pane goes to a fresh host rather than silently into this process.
    await this.open()
    return { pid: client.hostPid }
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

/** A host no app is attached to, read without changing it; null when none answers. Off, nothing is touched. */
export async function peekHost(userDataDir: string, appVersion: string): Promise<HostSighting | null> {
  const client = await reach(userDataDir, appVersion)
  if (client === undefined) return null
  await client.detach()
  return sighting(client)
}

/** Ends a host no app is attached to, with every pane in it, and waits for it to exit. */
export async function stopHost(userDataDir: string, appVersion: string): Promise<HostSighting | null> {
  const client = await reach(userDataDir, appVersion)
  if (client === undefined) return null
  await client.shutdown()
  await exited(client.hostPid)
  return sighting(client)
}

async function reach(userDataDir: string, appVersion: string): Promise<PaneHostClient | undefined> {
  const paths = paneHostPaths(userDataDir)
  if (!existsSync(paths.socket)) return undefined
  const result = await PaneHostClient.connect({ socket: paths.socket, tokenPath: paths.token, appVersion })
  return 'client' in result ? result.client : undefined
}

function sighting(client: PaneHostClient): HostSighting {
  return { pid: client.hostPid, panes: client.sessions.filter((session) => session.exited === undefined).length }
}

async function exited(pid: number): Promise<void> {
  const deadline = Date.now() + STOP_DEADLINE_MS
  while (Date.now() < deadline && alive(pid)) await new Promise((resolve) => setTimeout(resolve, 25))
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
