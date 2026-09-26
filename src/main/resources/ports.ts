// Which TCP ports each pane's processes listen on: one `lsof` for the machine, matched to panes by
// walking parent ids in one `ps`. A refused lsof (a sandboxed test copy) reads as no ports.

import { execFile } from 'node:child_process'
import type { ListeningPort, ResourceProcess } from '../../shared/entities'
import { parsePsTable } from './psTable'
import { defaultResourceSamplerHost } from './sampleResources'
import type { PaneProcess } from './resourceTree'

export const LSOF_ARGS: readonly string[] = ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']

export type Listener = { pid: number; command: string; port: number }

/** `lsof -F` output as one row per process and port, lowest port first; IPv4 and IPv6 twins are one row. */
export function parseLsofListeners(text: string): Listener[] {
  const found = new Map<string, Listener>()
  let pid = 0
  let command = ''
  for (const line of text.split('\n')) {
    const value = line.slice(1)
    if (line.startsWith('p')) {
      pid = Number(value)
      command = ''
    } else if (line.startsWith('c')) {
      command = value
    } else if (line.startsWith('n') && !value.includes('->')) {
      const port = Number(value.slice(value.lastIndexOf(':') + 1))
      if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port) || port <= 0) continue
      found.set(`${pid}:${port}`, { pid, command, port })
    }
  }
  return [...found.values()].sort((a, b) => a.port - b.port || a.pid - b.pid)
}

/** Each pane's ports, keyed by terminal id; a listener under no pane is left out. */
export function portsByPane(
  listeners: readonly Listener[],
  processes: readonly Pick<ResourceProcess, 'pid' | 'ppid'>[],
  panes: readonly PaneProcess[]
): Map<string, ListeningPort[]> {
  const parentOf = new Map(processes.map((process) => [process.pid, process.ppid]))
  const paneOf = new Map(panes.map((pane) => [pane.pid, pane.terminalId]))
  const ports = new Map<string, ListeningPort[]>()
  for (const listener of listeners) {
    const seen = new Set<number>()
    let pid: number | undefined = listener.pid
    while (pid !== undefined && pid > 1 && !paneOf.has(pid) && !seen.has(pid)) {
      seen.add(pid)
      pid = parentOf.get(pid)
    }
    const terminalId = pid === undefined ? undefined : paneOf.get(pid)
    if (terminalId === undefined) continue
    const entry = { port: listener.port, pid: listener.pid, command: listener.command }
    const held = ports.get(terminalId)
    if (held) held.push(entry)
    else ports.set(terminalId, [entry])
  }
  return ports
}

export type PortWatcherHost = {
  /** The text of `lsof` with `LSOF_ARGS`; rejects or is empty where it cannot run. */
  lsof: () => Promise<string>
  ps: () => Promise<string>
}

const LSOF_MAX_BUFFER = 4 * 1024 * 1024

export const defaultPortWatcherHost: PortWatcherHost = {
  lsof: () =>
    new Promise((resolve) => {
      if (process.platform === 'win32') return resolve('')
      // lsof exits 1 when nothing listens; its stdout is still the answer.
      execFile('lsof', [...LSOF_ARGS], { maxBuffer: LSOF_MAX_BUFFER }, (_error, stdout) => resolve(stdout ?? ''))
    }),
  ps: defaultResourceSamplerHost.ps
}

export type PortWatcherOptions = {
  /** The running panes; none, and nothing is spawned. */
  panes: () => readonly PaneProcess[]
  onChange: () => void
  host?: PortWatcherHost
  debounceMs?: number
  /** The least time between two scans, however often poked: an agent's output pokes every burst. */
  minGapMs?: number
  intervalMs?: number
}

/** Scans soon after a poke, then every `intervalMs` while any pane runs; idle, it holds no timer. */
export class PortWatcher {
  #ports = new Map<string, ListeningPort[]>()
  #timer: ReturnType<typeof setTimeout> | undefined
  #dueAt = 0
  #lastScanAt = Number.NEGATIVE_INFINITY
  #scanning = false
  #rescan = false
  #announcing = false
  #closed = false
  readonly #host: PortWatcherHost
  readonly #debounceMs: number
  readonly #minGapMs: number
  readonly #intervalMs: number

  constructor(private readonly options: PortWatcherOptions) {
    this.#host = options.host ?? defaultPortWatcherHost
    this.#debounceMs = options.debounceMs ?? 750
    this.#minGapMs = options.minGapMs ?? 2_000
    this.#intervalMs = options.intervalMs ?? 5_000
  }

  ports(terminalId: string): ListeningPort[] | undefined {
    return this.#ports.get(terminalId)
  }

  /** The panes changed: scan within `debounceMs`. */
  poke(): void {
    if (this.#announcing) return
    this.#schedule(this.#debounceMs)
  }

  close(): void {
    this.#closed = true
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
  }

  #schedule(delayMs: number): void {
    if (this.#closed) return
    if (this.options.panes().length === 0) {
      if (this.#timer !== undefined) clearTimeout(this.#timer)
      this.#timer = undefined
      this.#publish(new Map())
      return
    }
    const dueAt = Math.max(Date.now() + delayMs, this.#lastScanAt + this.#minGapMs)
    if (this.#timer !== undefined && this.#dueAt <= dueAt) return
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#dueAt = dueAt
    this.#timer = setTimeout(() => void this.#scan(), dueAt - Date.now())
  }

  async #scan(): Promise<void> {
    this.#timer = undefined
    if (this.#scanning) {
      this.#rescan = true
      return
    }
    const panes = this.options.panes()
    if (panes.length === 0) return this.#schedule(0)
    this.#scanning = true
    this.#lastScanAt = Date.now()
    let next = new Map<string, ListeningPort[]>()
    try {
      const listeners = parseLsofListeners(await this.#host.lsof())
      if (listeners.length > 0) {
        next = portsByPane(listeners, parsePsTable(await this.#host.ps()), panes)
      }
    } catch {
      // Fail soft: no ports is what a machine without lsof would show.
    } finally {
      this.#scanning = false
    }
    if (this.#closed) return
    this.#publish(next)
    this.#schedule(this.#rescan ? this.#debounceMs : this.#intervalMs)
    this.#rescan = false
  }

  #publish(next: Map<string, ListeningPort[]>): void {
    if (samePorts(this.#ports, next)) return
    this.#ports = next
    this.#announcing = true
    try {
      this.options.onChange()
    } finally {
      this.#announcing = false
    }
  }
}

function samePorts(a: Map<string, ListeningPort[]>, b: Map<string, ListeningPort[]>): boolean {
  if (a.size !== b.size) return false
  for (const [terminalId, ports] of a) {
    const other = b.get(terminalId)
    if (other === undefined || other.length !== ports.length) return false
    if (ports.some((entry, index) => entry.port !== other[index]?.port || entry.pid !== other[index]?.pid)) return false
  }
  return true
}
