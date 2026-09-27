// The pane host's wire: newline-delimited JSON over one unix socket per profile, every message
// carrying `v`. See docs/plans/pane-host.md for the table this implements.

import { lstatSync, mkdirSync, chmodSync } from 'node:fs'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { endpointKey, fitsUnixSocketPath } from '../runtime/socketEndpoint'

export const PANE_HOST_PROTOCOL = 1

/** The oldest host protocol this app still speaks. */
export const PANE_HOST_MIN_PROTOCOL = 1

/** Per session, what the host keeps of the output whether or not an app is attached. */
export const HOST_RING_BYTES = 4 * 1024 * 1024

/** A pty stops being read while the app's socket holds more than this unsent. */
export const HOST_BACKPRESSURE_BYTES = 1024 * 1024

/** With no app and no running pane for this long, the host exits. */
export const HOST_IDLE_MS = 10 * 60 * 1000

export type HostExit = { exitCode: number; signal: number | undefined }

/** One pty as the host describes it in `welcome`. */
export type HostSession = {
  id: string
  /** The app's terminal id the pty was spawned under. */
  terminal: string
  pid: number
  cols: number
  rows: number
  /** Bytes of output so far. */
  offset: number
  exited?: HostExit
}

export type AppMessage =
  | { type: 'hello'; v: number; token: string; appVersion: string }
  | {
      type: 'spawn'
      v: number
      id: string
      terminal: string
      file: string
      args: string[]
      cwd: string
      env: Record<string, string>
      cols: number
      rows: number
      name: string
    }
  | { type: 'attach'; v: number; id: string; since?: number }
  | { type: 'write'; v: number; id: string; data: string }
  | { type: 'resize'; v: number; id: string; cols: number; rows: number }
  | { type: 'kill'; v: number; id: string; signal?: string }
  | { type: 'forget'; v: number; id: string }
  | { type: 'foreground'; v: number; id: string }
  | { type: 'shutdown'; v: number }

export type HostMessage =
  | { type: 'welcome'; v: number; hostVersion: string; hostPid: number; sessions: HostSession[] }
  | { type: 'spawned'; v: number; id: string; pid: number }
  | { type: 'failed'; v: number; id: string; message: string }
  | { type: 'replay'; v: number; id: string; offset: number; data: string }
  | { type: 'data'; v: number; id: string; offset: number; data: string }
  | { type: 'exit'; v: number; id: string; exitCode: number; signal?: number }
  | { type: 'foreground'; v: number; id: string; name: string }

/** Calls `onMessage` for each JSON line; a line that does not parse ends the socket. */
export function readLines(socket: Socket, onMessage: (message: unknown) => void): void {
  let pending = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    pending += chunk
    let end: number
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      if (line === '') continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        socket.destroy()
        return
      }
      onMessage(message)
    }
  })
}

export function sendLine(socket: Socket, message: AppMessage | HostMessage): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`)
}

export type PaneHostPaths = { dir: string; socket: string; token: string; log: string }

/** Token in `<userData>/pane-host/`; the socket there too unless sun_path forces it to a private temp folder. */
export function paneHostPaths(userDataDir: string, tmpDir: string = tmpdir()): PaneHostPaths {
  const dir = join(userDataDir, 'pane-host')
  const folder = `teamree-pane-${endpointKey(userDataDir)}`
  const candidates = [join(dir, 'host.sock'), join(tmpDir, folder, 'host.sock'), join('/tmp', folder, 'host.sock')]
  const socket = candidates.find(fitsUnixSocketPath) ?? (candidates[candidates.length - 1] as string)
  return { dir, socket, token: join(dir, 'token'), log: join(userDataDir, 'pane-host.log') }
}

/** Makes `dir` 0700 and ours; refuses one another user owns, since in /tmp that is somebody else's socket. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stats = lstatSync(dir)
  if (!stats.isDirectory()) throw new Error(`${dir} is not a directory`)
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error(`${dir} belongs to another user`)
  }
  if ((stats.mode & 0o077) !== 0) chmodSync(dir, 0o700)
}
