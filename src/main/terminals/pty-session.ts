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
import { recoverTailOnTeardown } from './pty-tail'
import { ScrollbackBuffer } from './scrollback'
import {
  buildShellCommand,
  buildTerminalEnv,
  shellCannotRun,
  SHELL_UNRUNNABLE,
  TERMINAL_TYPE,
  shellName
} from './shell-environment'
import { terminalFailed, TerminalServiceError } from './service-error'
import { ErrorCode } from '../../shared/protocol'
import type { AgentKind } from './agent-command'
import { TitleSequenceScanner } from './title-sequence'

/** How long close() waits for the tree to die before giving up on the exit event. */
const CLOSE_TIMEOUT_MS = 5_000

/**
 * How long the exit event is held open after the last byte arrives.
 *
 * The child exiting and its output arriving are two different events on two
 * different channels: waitpid returns as soon as the process is reaped, while
 * whatever it last wrote may still be on its way to us. Holding exit until the
 * data goes quiet is what makes "exited" mean "and everything it printed is
 * readable" — the invariant `terminal run` hands to an agent.
 *
 * On POSIX the completeness itself is not this window's doing: `pty-tail.ts`
 * reads the pty to its real end before the fd is closed, which happens before
 * node-pty reports the exit, so nothing is outstanding by the time `finish`
 * runs. The window still earns its place on Windows, where output arrives over
 * a pipe node-pty owns and this is the only thing holding exit back.
 */
const EXIT_DRAIN_QUIET_MS = 50

/**
 * A ceiling on that wait, so a terminal that never goes quiet cannot hold a
 * shutdown open. Generous: after the child is reaped only what the kernel had
 * buffered is left, which is tens of kilobytes at most.
 */
const EXIT_DRAIN_MAX_MS = 500

/**
 * How long output has to stop before a pane counts as quiet.
 *
 * This is the whole of what this app knows about whether an agent is working.
 * Without a hook into the agent's own protocol there is no "thinking" signal
 * and no "waiting for permission" signal — there is only whether bytes are
 * still arriving. Long enough that a pause between two tool calls does not
 * read as finished; short enough that a finished agent stops looking busy
 * while you watch it.
 */
export const QUIET_AFTER_MS = 4_000

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
  /** Set when this session is a previous run's pane being brought back. */
  restored?: 'shell' | 'agent'
  /** Which coding agent this pane runs, when it runs one. */
  agent?: AgentKind
  /** Called when the pane starts or stops producing output. */
  onActivityChange?: (session: PtySession) => void
  now?: () => number
  /** Timer seam, so a test need not wait out the quiet window. */
  schedule?: (run: () => void, delayMs: number) => () => void
}

export type TerminalEventListener = (event: TerminalEvent) => void

export class PtySession {
  readonly id: string
  readonly worktreeId: string
  readonly cwd: string
  readonly shell: string
  readonly command: string | undefined
  readonly agent: AgentKind | undefined
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
  private restored: 'shell' | 'agent' | undefined
  private busy = false
  private lastOutputAt: number
  private cancelQuietWatch: (() => void) | undefined
  /** Set when the child has been reaped but its output has not gone quiet. */
  private draining: { exitCode: number; cancelQuiet: () => void; cancelCeiling: () => void } | undefined

  private constructor(
    private readonly init: PtySessionInit,
    handle: IPty,
    platform: NodeJS.Platform
  ) {
    this.id = init.id
    this.worktreeId = init.worktreeId
    this.cwd = init.cwd
    this.shell = init.shell
    this.command = init.command
    this.agent = init.agent
    this.cols = init.cols
    this.rows = init.rows
    this.platform = platform
    this.pty = handle
    this.pid = handle.pid
    this.scrollback = new ScrollbackBuffer(init.scrollbackCapBytes)
    this.title = initialTitle(init, platform)
    this.restored = init.restored
    this.lastOutputAt = (init.now ?? Date.now)()

    this.subscriptions.push(
      handle.onData((chunk) => this.receive(chunk)),
      handle.onExit(({ exitCode, signal }) => this.finish(exitCode, signal)),
      recoverTailOnTeardown(handle, platform, (chunk) => this.receive(chunk))
    )
  }

  static start(init: PtySessionInit): PtySession {
    const platform = init.platform ?? process.platform
    const { file, args } = buildShellCommand(init.shell, init.command, platform)
    const env = buildTerminalEnv(init.env, platform)

    // The two platforms answer "that shell is not there" in different places.
    // Windows refuses in spawn() below. POSIX does not refuse at all: the fork
    // succeeds, the helper's own execvp failure goes to the pty, and the caller
    // is handed a running session that dies a moment later — a pane that
    // appears and vanishes, with nothing anywhere saying why. So the platform
    // that will not raise is asked the question first, and both ends here.
    if (shellCannotRun(file, env, init.cwd, platform)) {
      throw terminalFailed(`failed to start ${file}: ${SHELL_UNRUNNABLE}`, { cwd: init.cwd })
    }

    let handle: IPty
    try {
      handle = spawn(file, args, {
        name: TERMINAL_TYPE,
        cwd: init.cwd,
        cols: init.cols,
        rows: init.rows,
        env
      })
    } catch (error) {
      throw terminalFailed(`failed to start ${file}: ${startFailureReason(error)}`, { cwd: init.cwd })
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
      ...(this.exitCode === undefined ? {} : { exitCode: this.exitCode }),
      ...(this.restored === undefined ? {} : { restored: this.restored }),
      ...(this.agent === undefined ? {} : { agent: this.agent }),
      busy: this.busy,
      lastOutputAt: this.lastOutputAt
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
    // Draining counts as exited here: the child has been reaped, so there is
    // nothing on the other end to read this, however the event is still held.
    if (!this.running || this.draining) {
      throw new TerminalServiceError(ErrorCode.Conflict, `terminal ${this.id} has exited`)
    }
    // Typing into a restored pane is the user taking it over; the badge has
    // said what it had to say by then.
    this.restored = undefined
    this.pty.write(data)
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    if (!this.running || this.draining) return
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

    this.cancelQuietWatch?.()
    this.cancelQuietWatch = undefined
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
    this.noteActivity()
    this.scrollback.append(chunk)
    this.emit({ type: 'data', data: chunk })
    for (const title of this.titles.scan(chunk)) {
      if (title === this.title) continue
      this.title = title
      this.emit({ type: 'title', title })
    }
    // Output after the child was reaped is the whole reason exit is held: each
    // chunk pushes the quiet window out again, up to the ceiling.
    if (this.draining) this.restartQuietWindow()
  }

  /**
   * Marks the pane busy and restarts the quiet countdown.
   *
   * Only the two edges are reported — busy going true, and going false again —
   * because a notification per chunk of output would be a notification per
   * frame of a build.
   */
  private noteActivity(): void {
    this.lastOutputAt = this.clock()
    this.cancelQuietWatch?.()
    if (!this.busy) {
      this.busy = true
      this.init.onActivityChange?.(this)
    }
    const cancel = this.scheduler(() => {
      this.cancelQuietWatch = undefined
      if (!this.busy) return
      this.busy = false
      this.init.onActivityChange?.(this)
    }, QUIET_AFTER_MS)
    this.cancelQuietWatch = cancel
  }

  private get clock(): () => number {
    return this.init.now ?? Date.now
  }

  private get scheduler(): (run: () => void, delayMs: number) => () => void {
    return this.init.schedule ?? scheduleUnref
  }

  private finish(exitCode: number, signal: number | undefined): void {
    if (!this.running || this.draining) return
    // A signalled death has exitCode 0, which would read as success; the shell
    // convention of 128 + signal keeps the two apart.
    const code = signal !== undefined && signal !== 0 ? 128 + signal : exitCode
    const ceiling = setTimeout(() => this.settleExit(), EXIT_DRAIN_MAX_MS)
    ceiling.unref?.()
    this.draining = {
      exitCode: code,
      cancelQuiet: () => {},
      cancelCeiling: () => clearTimeout(ceiling)
    }
    this.restartQuietWindow()
  }

  private restartQuietWindow(): void {
    const draining = this.draining
    if (!draining) return
    draining.cancelQuiet()
    const timer = setTimeout(() => this.settleExit(), EXIT_DRAIN_QUIET_MS)
    timer.unref?.()
    draining.cancelQuiet = () => clearTimeout(timer)
  }

  /**
   * The exit everyone else sees. Only reached once the output has gone quiet
   * or the ceiling has run out, so `running` going false and the event landing
   * both mean the scrollback is complete.
   */
  private settleExit(): void {
    const draining = this.draining
    if (!draining || !this.running) return
    draining.cancelQuiet()
    draining.cancelCeiling()
    this.draining = undefined
    this.running = false
    // An exited pane is not busy, whatever it was doing a moment ago.
    this.cancelQuietWatch?.()
    this.cancelQuietWatch = undefined
    const wasBusy = this.busy
    this.busy = false
    this.exitCode = draining.exitCode
    // The quiet countdown that would have reported this edge was just
    // cancelled, so the edge has to be reported here instead: a pane that dies
    // mid-burst goes busy -> not busy like any other, and a subscriber watching
    // activity must not be left holding the last thing it was told.
    if (wasBusy) this.init.onActivityChange?.(this)
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

/**
 * Windows reports a shell that is not there as "File not found" out of
 * node-pty's own spawn. That is the cause the check above refuses on POSIX, so
 * it is reported in the same words; anything else is a different failure and is
 * passed through as node-pty described it.
 */
function startFailureReason(error: unknown): string {
  const reason = describe(error)
  return /file not found|no such file/i.test(reason) ? SHELL_UNRUNNABLE : reason
}

/** A timer that is never the reason a process stays alive. */
function scheduleUnref(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}
