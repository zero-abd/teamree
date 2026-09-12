// One pane: one PTY, its retained output, its title, and its subscribers.
//
// Everything that is per-terminal lives here so the manager stays a registry.
// The session owns the only reference to the node-pty handle; nothing outside
// this file writes to a PTY or listens to one directly.

import { spawn } from 'node-pty'
import type { IDisposable, IPty } from 'node-pty'
import type { Terminal } from '../../shared/entities'
import type { TerminalEvent } from '../../shared/methods'
import { killProcessTree } from './process-tree'
import { ScrollbackBuffer } from './scrollback'
import { buildShellCommand, buildTerminalEnv, TERMINAL_TYPE, shellName } from './shell-environment'
import { terminalFailed, TerminalServiceError } from './service-error'
import { ErrorCode } from '../../shared/protocol'
import { TitleSequenceScanner } from './title-sequence'

/** How long close() waits for the tree to die before giving up on the exit event. */
const CLOSE_TIMEOUT_MS = 5_000

export type PtySessionInit = {
  id: string
  worktreeId: string
  cwd: string
  shell: string
  /** Run this instead of an interactive login shell. */
  command?: string
  cols: number
  rows: number
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  scrollbackCapBytes?: number
}

export type TerminalEventListener = (event: TerminalEvent) => void

export class PtySession {
  readonly id: string
  readonly worktreeId: string
  readonly cwd: string
  readonly shell: string
  readonly command: string | undefined
  readonly pid: number

  private readonly pty: IPty
  private readonly platform: NodeJS.Platform
  private readonly scrollback: ScrollbackBuffer
  private readonly titles = new TitleSequenceScanner()
  private readonly listeners = new Set<TerminalEventListener>()
  private readonly subscriptions: IDisposable[] = []
  private readonly exitWaiters = new Set<() => void>()

  private title: string
  private cols: number
  private rows: number
  private running = true
  private exitCode: number | undefined

  private constructor(init: PtySessionInit, handle: IPty, platform: NodeJS.Platform) {
    this.id = init.id
    this.worktreeId = init.worktreeId
    this.cwd = init.cwd
    this.shell = init.shell
    this.command = init.command
    this.cols = init.cols
    this.rows = init.rows
    this.platform = platform
    this.pty = handle
    this.pid = handle.pid
    this.scrollback = new ScrollbackBuffer(init.scrollbackCapBytes)
    this.title = initialTitle(init, platform)

    this.subscriptions.push(
      handle.onData((chunk) => this.receive(chunk)),
      handle.onExit(({ exitCode, signal }) => this.finish(exitCode, signal))
    )
  }

  static start(init: PtySessionInit): PtySession {
    const platform = init.platform ?? process.platform
    const { file, args } = buildShellCommand(init.shell, init.command, platform)

    let handle: IPty
    try {
      handle = spawn(file, args, {
        name: TERMINAL_TYPE,
        cwd: init.cwd,
        cols: init.cols,
        rows: init.rows,
        env: buildTerminalEnv(init.env)
      })
    } catch (error) {
      throw terminalFailed(`failed to start ${file}: ${describe(error)}`, { cwd: init.cwd })
    }

    return new PtySession(init, handle, platform)
  }

  snapshot(): Terminal {
    return {
      id: this.id,
      worktreeId: this.worktreeId,
      title: this.title,
      cwd: this.cwd,
      shell: this.shell,
      cols: this.cols,
      rows: this.rows,
      running: this.running,
      ...(this.exitCode === undefined ? {} : { exitCode: this.exitCode })
    }
  }

  get isRunning(): boolean {
    return this.running
  }

  /** Subscribes to data, exit and title events. Returns an unsubscribe function. */
  on(listener: TerminalEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  write(data: string): void {
    if (!this.running) {
      throw new TerminalServiceError(ErrorCode.Conflict, `terminal ${this.id} has exited`)
    }
    this.pty.write(data)
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    if (!this.running) return
    try {
      this.pty.resize(cols, rows)
    } catch (error) {
      // The child can exit between the check and the ioctl; the recorded size
      // still matters because the renderer draws the pane either way.
      if (this.running) throw terminalFailed(`resize failed: ${describe(error)}`)
    }
  }

  read(tailBytes?: number): string {
    return this.scrollback.tail(tailBytes)
  }

  get retainedBytes(): number {
    return this.scrollback.byteLength
  }

  /** Kills the process tree and releases every listener. Safe to call twice. */
  async close(): Promise<void> {
    if (this.running) {
      const exited = this.waitForExit(CLOSE_TIMEOUT_MS)
      await killProcessTree(this.pid, this.platform)
      await exited
    }

    try {
      this.pty.kill()
    } catch {
      // Already reaped; the handle has nothing left to signal.
    }

    for (const subscription of this.subscriptions) subscription.dispose()
    this.subscriptions.length = 0
    this.listeners.clear()
  }

  /** Resolves when the child exits, or when `timeoutMs` elapses. */
  waitForExit(timeoutMs: number): Promise<void> {
    if (!this.running) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.exitWaiters.delete(waiter)
        resolve()
      }, timeoutMs)
      const waiter = (): void => {
        clearTimeout(timer)
        resolve()
      }
      this.exitWaiters.add(waiter)
    })
  }

  private receive(chunk: string): void {
    this.scrollback.append(chunk)
    this.emit({ type: 'data', data: chunk })
    for (const title of this.titles.scan(chunk)) {
      if (title === this.title) continue
      this.title = title
      this.emit({ type: 'title', title })
    }
  }

  private finish(exitCode: number, signal: number | undefined): void {
    if (!this.running) return
    this.running = false
    // A signalled death has exitCode 0, which would read as success; the shell
    // convention of 128 + signal keeps the two apart.
    this.exitCode = signal !== undefined && signal !== 0 ? 128 + signal : exitCode
    this.emit({ type: 'exit', exitCode: this.exitCode })
    for (const waiter of this.exitWaiters) waiter()
    this.exitWaiters.clear()
  }

  private emit(event: TerminalEvent): void {
    // Copied: a listener may unsubscribe itself while being notified.
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // A broken subscriber must not stall the PTY's data pump.
      }
    }
  }
}

function initialTitle(init: PtySessionInit, platform: NodeJS.Platform): string {
  if (init.command !== undefined) {
    const [program] = init.command.trim().split(/\s+/)
    if (program !== undefined && program.length > 0) return program
  }
  return shellName(init.shell, platform)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
