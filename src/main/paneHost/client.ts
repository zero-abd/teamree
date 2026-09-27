// The app's end of the pane host socket, and `RemotePty`: the part of node-pty's IPty a pane uses,
// served by the host. Byte offsets make a replay and the live data after it join without a repeat.

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import type { IDisposable } from 'node-pty'
import {
  PANE_HOST_MIN_PROTOCOL,
  PANE_HOST_PROTOCOL,
  readLines,
  sendLine,
  type AppMessage,
  type HostMessage,
  type HostSession
} from './protocol'

const v = PANE_HOST_PROTOCOL

/** How long a pane's exit is kept before the host is told to forget it: the pane drains for up to 500 ms. */
const FORGET_AFTER_MS = 1_000

/** How stale the foreground name may be before a read asks the host again. */
const FOREGROUND_FRESH_MS = 1_000

/** Where a hosted pane's output stood when its record was written; the next attach starts there. */
export type HostMark = { session: string; offset: number }

export type RemoteSpawnOptions = {
  name: string
  cwd: string
  cols: number
  rows: number
  env: Record<string, string>
}

type ExitEvent = { exitCode: number; signal?: number }

export class RemotePty {
  #pid: number
  #end: number
  #name = ''
  #askedAt = Number.NEGATIVE_INFINITY
  #exited = false
  readonly #data = new Set<(data: string) => void>()
  readonly #exits = new Set<(event: ExitEvent) => void>()

  constructor(
    private readonly client: PaneHostClient,
    readonly id: string,
    pid: number,
    since: number
  ) {
    this.#pid = pid
    this.#end = since
  }

  get pid(): number {
    return this.#pid
  }

  readonly onData = (listener: (data: string) => void): IDisposable => subscribe(this.#data, listener)

  readonly onExit = (listener: (event: ExitEvent) => void): IDisposable => subscribe(this.#exits, listener)

  /** The last name the host reported; asking again is fire and forget. */
  get process(): string {
    const now = Date.now()
    if (!this.#exited && now - this.#askedAt > FOREGROUND_FRESH_MS) {
      this.#askedAt = now
      this.client.send({ type: 'foreground', v, id: this.id })
    }
    return this.#name
  }

  get hostMark(): HostMark {
    return { session: this.id, offset: this.#end }
  }

  write(data: string): void {
    this.client.send({ type: 'write', v, id: this.id, data })
  }

  resize(cols: number, rows: number): void {
    this.client.send({ type: 'resize', v, id: this.id, cols, rows })
  }

  kill(signal?: string): void {
    this.client.send({ type: 'kill', v, id: this.id, ...(signal === undefined ? {} : { signal }) })
  }

  /** Has the host forget the output so far, so the next attach does not replay it. */
  clear(): void {
    this.client.send({ type: 'clear', v, id: this.id })
  }

  /** Stops routing this pty's messages here; the pty itself keeps running in the host. */
  release(): void {
    this.#data.clear()
    this.#exits.clear()
    this.client.drop(this.id)
  }

  /** @internal */
  spawned(pid: number): void {
    this.#pid = pid
  }

  /** @internal Drops what was already delivered, so a replay and the live data after it never repeat. */
  deliver(offset: number, data: string): void {
    const bytes = Buffer.byteLength(data)
    if (bytes === 0 || offset + bytes <= this.#end) return
    const text =
      offset < this.#end
        ? Buffer.from(data)
            .subarray(this.#end - offset)
            .toString()
        : data
    this.#end = offset + bytes
    for (const listener of [...this.#data]) listener(text)
  }

  /** @internal */
  exit(event: ExitEvent): void {
    if (this.#exited) return
    this.#exited = true
    for (const listener of [...this.#exits]) listener(event)
    const timer = setTimeout(() => {
      this.client.send({ type: 'forget', v, id: this.id })
      this.client.drop(this.id)
    }, FORGET_AFTER_MS)
    timer.unref?.()
  }

  /** @internal */
  noteForeground(name: string): void {
    this.#name = name
  }
}

export type ConnectResult =
  | { client: PaneHostClient }
  /** Nothing listens: a host may be started. */
  | { absent: true }
  /** Something listens and would not do: left alone, and panes run in process. */
  | { refused: string }

export class PaneHostClient {
  readonly #ptys = new Map<string, RemotePty>()
  #closing = false
  #open = true
  readonly #closed: Promise<void>

  private constructor(
    private readonly socket: Socket,
    /** What the host was running when this app connected. */
    readonly sessions: readonly HostSession[],
    readonly hostPid: number
  ) {
    this.#closed = new Promise((resolve) => socket.once('close', () => resolve()))
    socket.once('close', () => {
      this.#open = false
      // A host that went away took its ptys with it; a detach is not that.
      if (!this.#closing) for (const pty of [...this.#ptys.values()]) pty.exit({ exitCode: 0, signal: 1 })
      this.#ptys.clear()
    })
  }

  /** Connects, says hello with the token, and waits for the welcome. */
  static connect(options: {
    socket: string
    tokenPath: string
    appVersion: string
    timeoutMs?: number
  }): Promise<ConnectResult> {
    return new Promise((resolve) => {
      const socket = createConnection({ path: options.socket })
      let settled = false
      const settle = (result: ConnectResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (!('client' in result)) socket.destroy()
        resolve(result)
      }
      const timer = setTimeout(() => settle({ refused: 'no welcome' }), options.timeoutMs ?? 3_000)
      let client: PaneHostClient | undefined
      socket.on('error', (error: NodeJS.ErrnoException) => {
        const nobody = error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
        settle(nobody ? { absent: true } : { refused: error.message })
      })
      socket.once('close', () => settle({ refused: 'the host closed the connection' }))
      socket.once('connect', () => {
        let token: string
        try {
          token = readFileSync(options.tokenPath, 'utf8').trim()
        } catch {
          settle({ refused: 'no token' })
          return
        }
        sendLine(socket, { type: 'hello', v, token, appVersion: options.appVersion })
      })
      readLines(socket, (raw) => {
        if (client !== undefined) {
          client.#receive(raw as HostMessage)
          return
        }
        const welcome = raw as Partial<Extract<HostMessage, { type: 'welcome' }>>
        if (welcome.type !== 'welcome' || typeof welcome.v !== 'number') {
          settle({ refused: 'not a pane host' })
          return
        }
        if (welcome.v > PANE_HOST_PROTOCOL) {
          settle({ refused: `the host speaks protocol ${welcome.v}, newer than this app` })
          return
        }
        if (welcome.v < PANE_HOST_MIN_PROTOCOL) {
          settle({ refused: `the host speaks protocol ${welcome.v}, older than this app` })
          return
        }
        client = new PaneHostClient(socket, validSessions(welcome.sessions), Number(welcome.hostPid))
        settle({ client })
      })
    })
  }

  get connected(): boolean {
    return this.#open && !this.#closing
  }

  spawn(terminal: string, file: string, args: string[], options: RemoteSpawnOptions): RemotePty {
    const id = `${terminal}.${randomUUID().slice(0, 8)}`
    const pty = new RemotePty(this, id, 0, 0)
    this.#ptys.set(id, pty)
    this.send({ type: 'spawn', v, id, terminal, file, args, ...options })
    return pty
  }

  /** Streams `session` from `since`, or from the start of what the host kept. */
  attach(session: HostSession, since?: number): RemotePty {
    const pty = new RemotePty(this, session.id, session.pid, since ?? 0)
    this.#ptys.set(session.id, pty)
    this.send({ type: 'attach', v, id: session.id, ...(since === undefined ? {} : { since }) })
    return pty
  }

  /** Ends a session nothing in the app will show. */
  kill(id: string): void {
    this.send({ type: 'forget', v, id })
  }

  /** Leaves every pty running and closes the socket. */
  async detach(): Promise<void> {
    this.#closing = true
    this.socket.end()
    await this.#closed
  }

  /** Has the host end every pty and exit; unlike `shutdown`, each pane here hears its exit. */
  async stop(): Promise<void> {
    this.send({ type: 'shutdown', v })
    await this.#closed
  }

  /** Has the host kill every pty and exit. */
  async shutdown(): Promise<void> {
    this.#closing = true
    this.send({ type: 'shutdown', v })
    this.socket.end()
    await this.#closed
  }

  /** @internal */
  send(message: AppMessage): void {
    if (this.#open) sendLine(this.socket, message)
  }

  /** @internal */
  drop(id: string): void {
    this.#ptys.delete(id)
  }

  #receive(message: HostMessage): void {
    if (typeof message !== 'object' || message === null || !('id' in message) || typeof message.id !== 'string') return
    const pty = this.#ptys.get(message.id)
    if (pty === undefined) return
    switch (message.type) {
      case 'spawned':
        pty.spawned(message.pid)
        return
      case 'failed':
        pty.deliver(0, `failed to start: ${message.message}\r\n`)
        pty.exit({ exitCode: 1 })
        return
      case 'replay':
      case 'data':
        pty.deliver(message.offset, message.data)
        return
      case 'exit':
        pty.exit({ exitCode: message.exitCode, ...(message.signal === undefined ? {} : { signal: message.signal }) })
        return
      case 'foreground':
        pty.noteForeground(message.name)
        return
    }
  }
}

function validSessions(raw: unknown): HostSession[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (session): session is HostSession =>
      typeof session === 'object' &&
      session !== null &&
      typeof session.id === 'string' &&
      typeof session.terminal === 'string' &&
      Number.isInteger(session.pid) &&
      Number.isInteger(session.cols) &&
      Number.isInteger(session.rows) &&
      Number.isInteger(session.offset)
  )
}

function subscribe<T>(listeners: Set<(event: T) => void>, listener: (event: T) => void): IDisposable {
  listeners.add(listener)
  return { dispose: () => listeners.delete(listener) }
}
