// The pane host: owns every pty of a profile that keeps its agents running, outlives the app that
// started it, and serves one app at a time over a private socket. No store, no git, no window.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { spawn as spawnNodePty, type IDisposable, type IPty } from 'node-pty'
import { recoverTailOnTeardown } from '../terminals/pty-tail'
import {
  HOST_BACKPRESSURE_BYTES,
  HOST_IDLE_MS,
  HOST_RING_BYTES,
  PANE_HOST_PROTOCOL,
  readLines,
  sendLine,
  type AppMessage,
  type HostExit,
  type HostMessage,
  type HostSession
} from './protocol'

const SHUTDOWN_GRACE_MS = 500

export type PaneHostOptions = {
  socket: string
  token: string
  hostVersion: string
  /** Seam for the version tests. */
  protocol?: number
  spawnPty?: typeof spawnNodePty
  idleMs?: number
  ringBytes?: number
  log?: (line: string) => void
  /** Called once the host has closed; the entry exits the process. */
  onClosed?: () => void
}

export type PaneHost = { close: () => Promise<void> }

type Chunk = { start: number; data: string; bytes: number }

type Session = {
  id: string
  terminal: string
  pty: IPty
  cols: number
  rows: number
  chunks: Chunk[]
  held: number
  end: number
  exited?: HostExit
  subscriptions: IDisposable[]
}

/** Listens on `options.socket` with a fresh token; resolves once the socket is 0600 and answering. */
export async function startPaneHost(options: PaneHostOptions): Promise<PaneHost> {
  const v = options.protocol ?? PANE_HOST_PROTOCOL
  const spawnPty = options.spawnPty ?? spawnNodePty
  const ringBytes = options.ringBytes ?? HOST_RING_BYTES
  const idleMs = options.idleMs ?? HOST_IDLE_MS
  const log = options.log ?? (() => {})
  const sessions = new Map<string, Session>()
  let client: Socket | undefined
  const sockets = new Set<Socket>()
  const attached = new Set<string>()
  let paused = false
  let busyAt = Date.now()
  let closed = false

  if (await answering(options.socket)) throw new Error('another pane host is serving this profile')
  rmSync(options.socket, { force: true })
  const token = randomBytes(32).toString('hex')
  writeFileSync(options.token, token, { mode: 0o600 })
  chmodSync(options.token, 0o600)

  const send = (message: HostMessage): void => {
    if (client === undefined) return
    sendLine(client, message)
    if (!paused && client.writableLength > HOST_BACKPRESSURE_BYTES) pauseUntilDrained(client)
  }

  const pauseUntilDrained = (socket: Socket): void => {
    paused = true
    for (const session of running()) session.pty.pause()
    socket.once('drain', resumeAll)
  }

  const resumeAll = (): void => {
    if (!paused) return
    paused = false
    for (const session of running()) session.pty.resume()
  }

  const running = (): Session[] => [...sessions.values()].filter((session) => session.exited === undefined)

  const receive = (session: Session, data: string): void => {
    const bytes = Buffer.byteLength(data)
    session.chunks.push({ start: session.end, data, bytes })
    session.held += bytes
    session.end += bytes
    while (session.held > ringBytes && session.chunks.length > 1) session.held -= session.chunks.shift()?.bytes ?? 0
    if (attached.has(session.id)) send({ type: 'data', v, id: session.id, offset: session.end - bytes, data })
  }

  const describe = (session: Session): HostSession => ({
    id: session.id,
    terminal: session.terminal,
    pid: session.pty.pid,
    cols: session.cols,
    rows: session.rows,
    offset: session.end,
    ...(session.exited === undefined ? {} : { exited: session.exited })
  })

  const spawnSession = (message: Extract<Request, { type: 'spawn' }>): void => {
    if (sessions.has(message.id)) {
      send({ type: 'failed', v, id: message.id, message: `session ${message.id} exists` })
      return
    }
    let pty: IPty
    try {
      pty = spawnPty(message.file, message.args, {
        name: message.name,
        cwd: message.cwd,
        cols: message.cols,
        rows: message.rows,
        env: message.env
      })
    } catch (error) {
      send({ type: 'failed', v, id: message.id, message: error instanceof Error ? error.message : String(error) })
      return
    }
    const session: Session = {
      id: message.id,
      terminal: message.terminal,
      pty,
      cols: message.cols,
      rows: message.rows,
      chunks: [],
      held: 0,
      end: 0,
      subscriptions: []
    }
    sessions.set(session.id, session)
    attached.add(session.id)
    if (paused) pty.pause()
    session.subscriptions.push(
      pty.onData((data) => receive(session, data)),
      pty.onExit(({ exitCode, signal }) => {
        session.exited = { exitCode, signal }
        busyAt = Date.now()
        log(`exit ${session.id} pid ${pty.pid} code ${exitCode} signal ${signal ?? 0}`)
        if (attached.has(session.id)) {
          send({ type: 'exit', v, id: session.id, exitCode, ...(signal === undefined ? {} : { signal }) })
        }
      }),
      recoverTailOnTeardown(pty, process.platform, (data) => receive(session, data))
    )
    log(`spawn ${session.id} pid ${pty.pid} ${message.file}`)
    send({ type: 'spawned', v, id: session.id, pid: pty.pid })
  }

  const attach = (session: Session, since: number | undefined): void => {
    const from = since === undefined ? 0 : since
    const parts: string[] = []
    let offset: number | undefined
    for (const chunk of session.chunks) {
      if (chunk.start + chunk.bytes <= from) continue
      if (chunk.start >= from) {
        offset ??= chunk.start
        parts.push(chunk.data)
        continue
      }
      // Only a `since` that is not a chunk boundary lands here; the app only sends boundaries.
      offset = from
      parts.push(
        Buffer.from(chunk.data)
          .subarray(from - chunk.start)
          .toString()
      )
    }
    send({ type: 'replay', v, id: session.id, offset: offset ?? session.end, data: parts.join('') })
    attached.add(session.id)
    const exit = session.exited
    if (exit !== undefined) {
      send({
        type: 'exit',
        v,
        id: session.id,
        exitCode: exit.exitCode,
        ...(exit.signal === undefined ? {} : { signal: exit.signal })
      })
    }
  }

  const forget = (session: Session): void => {
    for (const subscription of session.subscriptions) subscription.dispose()
    sessions.delete(session.id)
    attached.delete(session.id)
    busyAt = Date.now()
  }

  const shutdown = async (): Promise<void> => {
    log('shutdown')
    const live = running()
    for (const session of live) signalGroup(session.pty, 'SIGHUP')
    const deadline = Date.now() + SHUTDOWN_GRACE_MS
    while (running().length > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
    for (const session of running()) signalGroup(session.pty, 'SIGKILL')
    await close()
  }

  const handle = (socket: Socket, message: Request | undefined): void => {
    if (message === undefined) return
    if (message.type === 'shutdown') {
      void shutdown()
      return
    }
    if (message.type === 'spawn') {
      spawnSession(message)
      return
    }
    const session = sessions.get(message.id)
    if (session === undefined) return
    switch (message.type) {
      case 'attach':
        attach(session, message.since)
        return
      case 'write':
        if (session.exited === undefined) tryIgnoring(() => session.pty.write(message.data))
        return
      case 'resize':
        session.cols = message.cols
        session.rows = message.rows
        if (session.exited === undefined) tryIgnoring(() => session.pty.resize(message.cols, message.rows))
        return
      case 'kill':
        if (session.exited === undefined) tryIgnoring(() => session.pty.kill(message.signal))
        return
      case 'clear':
        session.chunks = []
        session.held = 0
        return
      case 'forget':
        if (session.exited === undefined) signalGroup(session.pty, 'SIGHUP')
        forget(session)
        return
      case 'foreground': {
        let name = ''
        tryIgnoring(() => (name = session.pty.process))
        sendLine(socket, { type: 'foreground', v, id: session.id, name })
        return
      }
    }
  }

  const server: Server = createServer((socket) => {
    let trusted = false
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => {
      sockets.delete(socket)
      if (client !== socket) return
      client = undefined
      attached.clear()
      busyAt = Date.now()
      resumeAll()
      log('app detached')
    })
    readLines(socket, (raw) => {
      if (trusted) {
        if (client === socket) handle(socket, parse(raw))
        return
      }
      const hello = raw as { type?: unknown; token?: unknown; v?: unknown; appVersion?: unknown }
      if (hello.type !== 'hello' || typeof hello.v !== 'number' || !sameToken(hello.token, token)) {
        log('refused a connection without the token')
        socket.destroy()
        return
      }
      trusted = true
      // One app at a time: the newcomer takes over.
      client?.destroy()
      attached.clear()
      resumeAll()
      client = socket
      busyAt = Date.now()
      log(`app ${String(hello.appVersion)} attached, protocol ${hello.v}`)
      sendLine(socket, {
        type: 'welcome',
        v,
        hostVersion: options.hostVersion,
        hostPid: process.pid,
        sessions: [...sessions.values()].map(describe)
      })
    })
  })

  const idle = setInterval(
    () => {
      if (client !== undefined || running().length > 0) {
        busyAt = Date.now()
        return
      }
      if (Date.now() - busyAt < idleMs) return
      log('idle, exiting')
      void close()
    },
    Math.min(30_000, Math.max(10, Math.floor(idleMs / 4)))
  )
  idle.unref()

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    clearInterval(idle)
    // Every connection, not just the app's: `server.close` waits for a silent one forever.
    for (const socket of sockets) socket.destroy()
    for (const session of [...sessions.values()]) {
      if (session.exited === undefined) signalGroup(session.pty, 'SIGKILL')
      forget(session)
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(options.socket, { force: true })
    rmSync(options.token, { force: true })
    options.onClosed?.()
  }

  const previousUmask = process.umask(0o077)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.socket, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } finally {
    process.umask(previousUmask)
  }
  chmodSync(options.socket, 0o600)
  log(`listening, pid ${process.pid}`)
  return { close }
}

/** An app message after the hello, without its `v`. */
type Request = { [K in AppMessage['type']]: Omit<Extract<AppMessage, { type: K }>, 'v'> }[Exclude<
  AppMessage['type'],
  'hello'
>]

/** The app messages the host acts on, checked field by field; anything else is undefined. */
function parse(raw: unknown): Request | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const m = raw as Record<string, unknown>
  if (m.type === 'shutdown') return { type: 'shutdown' }
  if (typeof m.id !== 'string') return undefined
  const id = m.id
  const size = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0
  switch (m.type) {
    case 'spawn': {
      const env = m.env
      if (
        typeof m.terminal !== 'string' ||
        typeof m.file !== 'string' ||
        !Array.isArray(m.args) ||
        !m.args.every((arg) => typeof arg === 'string') ||
        typeof m.cwd !== 'string' ||
        typeof env !== 'object' ||
        env === null ||
        !size(m.cols) ||
        !size(m.rows) ||
        typeof m.name !== 'string'
      ) {
        return undefined
      }
      const strings = Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      )
      return {
        type: 'spawn',
        id,
        terminal: m.terminal,
        file: m.file,
        args: m.args as string[],
        cwd: m.cwd,
        env: strings,
        cols: m.cols,
        rows: m.rows,
        name: m.name
      }
    }
    case 'attach':
      return Number.isInteger(m.since) && (m.since as number) >= 0
        ? { type: 'attach', id, since: m.since as number }
        : { type: 'attach', id }
    case 'write':
      return typeof m.data === 'string' ? { type: 'write', id, data: m.data } : undefined
    case 'resize':
      return size(m.cols) && size(m.rows) ? { type: 'resize', id, cols: m.cols, rows: m.rows } : undefined
    case 'kill':
      return typeof m.signal === 'string' ? { type: 'kill', id, signal: m.signal } : { type: 'kill', id }
    case 'forget':
    case 'foreground':
    case 'clear':
      return { type: m.type, id }
    default:
      return undefined
  }
}

function sameToken(offered: unknown, token: string): boolean {
  if (typeof offered !== 'string' || offered.length !== token.length) return false
  return timingSafeEqual(Buffer.from(offered), Buffer.from(token))
}

/** The pty child leads its own session, so its negated pid reaches everything it started. */
function signalGroup(pty: IPty, signal: NodeJS.Signals): void {
  tryIgnoring(() => process.kill(-pty.pid, signal))
  tryIgnoring(() => process.kill(pty.pid, signal))
}

function tryIgnoring(work: () => void): void {
  try {
    work()
  } catch {
    // Already gone.
  }
}

/** Whether something already serves `socket`; a stale file answers nothing. */
function answering(socket: string): Promise<boolean> {
  if (!existsSync(socket)) return Promise.resolve(false)
  return new Promise((resolve) => {
    const probe = createConnection({ path: socket })
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', () => resolve(false))
  })
}
