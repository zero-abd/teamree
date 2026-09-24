// One pane: one PTY, its retained output, its title, and its subscribers.
// The session owns the only reference to the node-pty handle.

import type { RestoredAs } from '../../shared/paneRestore'
import { spawn } from 'node-pty'
import type { IDisposable, IPty } from 'node-pty'
import type { AgentEvent, Terminal } from '../../shared/entities'
import type { TerminalEvent } from '../../shared/methods'
import { killProcessTree } from './process-tree'
import { recoverTailOnTeardown } from './pty-tail'
import { ScrollbackBuffer } from './scrollback'
import {
  FAILED_RESUME_BELOW,
  failedResumeMark,
  replayableRecord,
  tailFromLineBoundary,
  type RecordedScrollback
} from './scrollbackRecord'
import {
  buildShellCommand,
  buildTerminalEnv,
  loginShellPath,
  shellCannotRun,
  SHELL_UNRUNNABLE,
  TERMINAL_TYPE,
  shellName
} from './shell-environment'
import { terminalFailed, TerminalServiceError } from './service-error'
import { ErrorCode } from '../../shared/protocol'
import { agentForProcess, type AgentKind } from './agent-command'
import { TitleSequenceScanner } from './title-sequence'
import { titleOpinion, type TitleOpinion } from '../../shared/titleOpinion'
import {
  menuQuestion,
  screenMenu,
  screenOpinion,
  screenQuestion,
  type ScreenMenu,
  type ScreenOpinion
} from '../../shared/screenOpinion'
import { screenRows } from './screenRows'
import type { Tone } from '../../shared/theme'

/** How long close() waits for the tree to die before giving up on the exit event. */
const CLOSE_TIMEOUT_MS = 5_000

/**
 * How long the exit event is held open after the last byte arrives: waitpid
 * returns before the child's last output does. On POSIX `pty-tail.ts` reads the
 * pty to its end first; on Windows this window is the only thing holding exit.
 */
const EXIT_DRAIN_QUIET_MS = 50

/** Ceiling on that wait; after reaping only the kernel's buffer is left. */
const EXIT_DRAIN_MAX_MS = 500

/**
 * How long output has to stop before a pane counts as quiet — the only signal
 * this app has for whether an agent is working. Longer than a pause between
 * tool calls; short enough that a finished agent stops looking busy.
 */
export const QUIET_AFTER_MS = 4_000

/** How long after output an agent pane's screen is read for a question; one read waits at a time. */
const SCREEN_READ_AFTER_MS = 1_000

/** How much of the tail that read rebuilds the screen from: enough for a full-screen agent's last redraw. */
const SCREEN_TAIL_BYTES = 64 * 1024

/** How long after a resize output counts as the child repainting for the new size, not as new output. */
export const REDRAW_AFTER_RESIZE_MS = 300

/**
 * What a pane keeps once it has exited. Trimmed rather than freed: the
 * renderer, sidebar, `terminal read` and watch snapshots all want the tail.
 */
export const EXITED_RETENTION_BYTES = 256 * 1024

/**
 * How long after a pane is brought back to resume a conversation an exit still
 * counts as the resume having failed. A refusing agent exits in the first
 * seconds or not at all; past this an agent that ends is an agent that ended.
 */
export const RESUME_WINDOW_MS = 30_000

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
  /** The window's tone when the pane starts, told to the child as COLORFGBG. */
  tone?: Tone
  platform?: NodeJS.Platform
  scrollbackCapBytes?: number
  /** Set when this session is a previous run's pane being brought back. */
  restored?: RestoredAs
  /**
   * What the pane printed the last time it was open. Kept apart from the live
   * buffer so no byte of it can be mistaken for one this session produced.
   */
  restoredRecord?: RecordedScrollback
  /** What the mark under that record says is starting below it; absent means "a new shell". */
  recordStartsBelow?: string
  /**
   * A line to put in the pane before anything this session prints. Written into
   * the output, not emitted: nobody is subscribed at the moment a pane starts.
   */
  startupNote?: string
  /** Which coding agent this pane runs, when it runs one. */
  agent?: AgentKind
  /**
   * What to run in this pane if the resume it came back for is refused. Used at
   * most once per pane: the second start is a fresh agent, not a resume.
   */
  restartCommand?: string
  /** Called after that restart, so the pane's record can say what is running. */
  onRestart?: (session: PtySession) => void
  /** What the pane is called, when somebody has said; see `Terminal.label`. */
  label?: string
  /** See `Terminal.ordinal`. */
  ordinal?: number
  /** Called when the pane starts or stops producing output. */
  onActivityChange?: (session: PtySession) => void
  /** Called when the bottom of an agent pane's screen starts or stops showing a question. */
  onScreenChange?: (session: PtySession) => void
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
  readonly ordinal: number | undefined

  /** Not a field: a restarted agent has a different child, and `close()` kills by pid. */
  get pid(): number {
    return this.pty.pid
  }

  private pty: IPty
  private readonly platform: NodeJS.Platform
  private readonly scrollback: ScrollbackBuffer
  /** Characters of output appended since the session started; a data event carries the count after it. */
  private appended = 0
  private widest: number
  /** The previous run's output, when this pane is one that was brought back. */
  private readonly record: RecordedScrollback | undefined
  private readonly titles = new TitleSequenceScanner()
  private readonly listeners = new Set<TerminalEventListener>()
  private readonly subscriptions: IDisposable[] = []
  private readonly exitWaiters = new Set<() => void>()

  private title: string
  /** Mutable: a rename is the user changing it, not the program. */
  private label: string | undefined
  private cols: number
  private rows: number
  private running = true
  private exitCode: number | undefined
  private restored: RestoredAs | undefined
  private busy = false
  /**
   * When the bell last rang within the current burst; see `Terminal.lastBellAt`.
   * Held, not merely emitted, so a later subscriber can learn of it.
   */
  private lastBellAt: number | undefined
  /** What the agent last said about itself; see `Terminal.agentEvent`. */
  private agentEvent: AgentEvent | undefined
  /** See `Terminal.tookTurn`. A resumed conversation has had its turns. */
  private tookTurn: boolean
  private screenSays: ScreenOpinion | undefined
  private screenAsks: string | undefined
  private screenMenu: ScreenMenu | undefined
  private cancelScreenRead: (() => void) | undefined
  /** Bumped by every read and every keystroke, so a read that was overtaken lands nowhere. */
  private screenReads = 0
  private lastOutputAt: number
  private resizedAt = Number.NEGATIVE_INFINITY
  private readonly startedAt: number
  private cancelQuietWatch: (() => void) | undefined
  /** Set when the child has been reaped but its output has not gone quiet. */
  private draining: { exitCode: number; cancelQuiet: () => void; cancelCeiling: () => void } | undefined
  /**
   * True while the record this pane came back with is held rather than shown: a
   * resuming agent prints the conversation itself. Let go if the resume fails.
   */
  private recordHeld: boolean
  /** True once this pane has said, in the pane, that its resume did not take. */
  private resumeFailed = false
  /** True once a fresh agent has taken the refused resume's place in this pane. */
  private agentRestarted = false
  /** True once anybody has typed into this pane; see `TerminalRecord.typed`. */
  private typedInto = false
  /** True from the moment close() is called: this pane is being ended on purpose. */
  private closing = false

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
    this.ordinal = init.ordinal
    this.cols = init.cols
    this.rows = init.rows
    this.widest = init.cols
    this.platform = platform
    this.pty = handle
    this.scrollback = new ScrollbackBuffer(init.scrollbackCapBytes)
    this.record = init.restoredRecord
    this.recordHeld = init.restored === 'agent' && init.restoredRecord !== undefined
    this.title = initialTitle(init, platform)
    this.label = init.label
    this.restored = init.restored
    this.tookTurn = init.restored === 'agent'
    this.lastOutputAt = (init.now ?? Date.now)()
    this.startedAt = this.lastOutputAt

    // Before the child is listened to, so it is above its first byte.
    if (init.startupNote !== undefined) this.append(init.startupNote)

    this.listen(handle)
  }

  /** Routes one child's output, and its death, into this pane. */
  private listen(handle: IPty): void {
    this.subscriptions.push(
      handle.onData((chunk) => this.receive(chunk)),
      handle.onExit(({ exitCode, signal }) => this.finish(exitCode, signal)),
      recoverTailOnTeardown(handle, this.platform, (chunk) => this.receive(chunk))
    )
  }

  static start(init: PtySessionInit): PtySession {
    const platform = init.platform ?? process.platform
    const handle = startChild(init, init.command, platform)
    return new PtySession(init, handle, platform)
  }

  snapshot(): Terminal {
    const foregroundAgent = this.foregroundAgent()
    const titleSays: TitleOpinion | null = titleOpinion(this.agent ?? foregroundAgent, this.title)
    return {
      id: this.id,
      worktreeId: this.worktreeId,
      title: this.title,
      cwd: this.cwd,
      shell: this.shell,
      cols: this.cols,
      rows: this.rows,
      running: this.running,
      // `running` is deliberately still true while draining, but `write` already throws.
      ...(this.draining === undefined ? {} : { draining: true }),
      ...(this.exitCode === undefined ? {} : { exitCode: this.exitCode }),
      ...(this.restored === undefined ? {} : { restored: this.restored }),
      ...(this.agent === undefined ? {} : { agent: this.agent }),
      ...(foregroundAgent === undefined ? {} : { foregroundAgent }),
      ...(this.label === undefined ? {} : { label: this.label }),
      ...(this.ordinal === undefined ? {} : { ordinal: this.ordinal }),
      busy: this.busy,
      // Derived, not stored, so it cannot drift from the title.
      ...(titleSays === null ? {} : { titleSays }),
      ...(this.screenSays === undefined ? {} : { screenSays: this.screenSays }),
      ...(this.screenMenu === undefined ? {} : { screenMenu: this.screenMenu }),
      ...(this.lastBellAt === undefined ? {} : { lastBellAt: this.lastBellAt }),
      ...(this.agentEvent === undefined ? {} : { agentEvent: this.agentEvent }),
      ...(this.agent === undefined ? {} : { tookTurn: this.tookTurn }),
      lastOutputAt: this.lastOutputAt
    }
  }

  /** A harness in the foreground of a pane not started as one; read afresh, since the user can quit it. */
  private foregroundAgent(): AgentKind | undefined {
    if (this.agent !== undefined || !this.running) return undefined
    try {
      const name: unknown = this.pty.process
      return typeof name === 'string' ? (agentForProcess(name) ?? undefined) : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Records what the agent in this pane has just said about itself. Replaced,
   * never merged; not cleared by output, which is the reading this outranks.
   */
  noteAgentEvent(event: AgentEvent): void {
    this.agentEvent = { ...event }
    if (event.event === 'UserPromptSubmit') this.tookTurn = true
  }

  get isRunning(): boolean {
    return this.running
  }

  /** What the screen is asking; see `screenQuestion` and, for a dialog without a known hint, `menuQuestion`. */
  get question(): string | undefined {
    return this.screenAsks
  }

  /** Whether output is still arriving; see `noteActivity` for what that means. */
  get isBusy(): boolean {
    return this.busy
  }

  /** Renames the pane; a blank clears the name rather than keeping "   ". */
  rename(label: string | null): void {
    const trimmed = label?.trim() ?? ''
    this.label = trimmed.length === 0 ? undefined : trimmed
  }

  /** Subscribes to data, exit and title events. Returns an unsubscribe function. */
  on(listener: TerminalEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Puts bytes on the pty, and records who put them there. `byHand` is false for
   * the emulator's own device-query answers, which say nothing about whether
   * anybody is here; only the window can tell (`handsHere.ts`). Defaulting to a
   * person is the safe direction: the other way loses a real conversation.
   */
  write(data: string, byHand = true): void {
    // Draining counts as exited: the child has been reaped.
    if (!this.running || this.draining) {
      throw new TerminalServiceError(ErrorCode.Conflict, `terminal ${this.id} has exited`)
    }
    if (byHand) {
      // Typing into a restored pane is the user taking it over.
      this.restored = undefined
      this.typedInto = true
      // What answers these bytes is output, not the last resize's repaint.
      this.resizedAt = Number.NEGATIVE_INFINITY
      // A bell is a question; this is somebody answering it.
      this.lastBellAt = undefined
      // So is this; the screen is read again once the answer has redrawn it.
      this.screenSays = undefined
      this.screenAsks = undefined
      this.screenMenu = undefined
      this.screenReads++
      this.cancelScreenRead?.()
      this.cancelScreenRead = undefined
      // A request answered or a running turn interrupted: the bytes are the
      // better reading until the agent speaks again. A turn that ended stays ended.
      if (overtakenByTyping(this.agentEvent)) this.agentEvent = undefined
    }
    this.pty.write(data)
  }

  /** Whether anybody has typed into this pane; see `TerminalRecord.typed`. */
  get wasTypedInto(): boolean {
    return this.typedInto
  }

  resize(cols: number, rows: number): void {
    // The kernel only raises SIGWINCH when the size changes.
    if (cols !== this.cols || rows !== this.rows) this.resizedAt = this.clock()
    this.cols = cols
    this.rows = rows
    this.widest = Math.max(this.widest, cols)
    if (!this.running || this.draining) return
    try {
      this.pty.resize(cols, rows)
    } catch (error) {
      // The child can exit between the check and the ioctl.
      if (this.running) throw terminalFailed(`resize failed: ${describe(error)}`)
    }
  }

  /**
   * What this pane shows: the previous run's record, framed so a reader knows
   * where old output ends (see `scrollbackRecord.ts`), then this session's own.
   */
  read(tailBytes?: number): string {
    const live = this.scrollback.tail(tailBytes)
    if (this.record === undefined || this.recordHeld) return live
    const framed = replayableRecord(this.record, this.resumeFailed ? FAILED_RESUME_BELOW : this.init.recordStartsBelow)
    if (tailBytes === undefined) return `${framed}${live}`

    // The live output is the newer half; the record only supplies what is left over.
    const remaining = tailBytes - this.scrollback.byteLength
    if (remaining <= 0) return live
    return `${tailFromLineBoundary(framed, remaining)}${live}`
  }

  /**
   * The pane's output as written down for the next launch. Without the marks:
   * the next replay adds them again, and keeping them would nest the framing.
   */
  recordedOutput(capBytes?: number): string {
    const live = this.scrollback.tail(capBytes)
    if (this.record === undefined || this.scrollback.byteLength >= (capBytes ?? Infinity)) return live
    // A record that ended mid-line must not have this session's first line run on from it.
    const joined = this.record.text.endsWith('\n') ? this.record.text : `${this.record.text}\r\n`
    const combined = `${joined}${live}`
    return capBytes === undefined ? combined : tailFromLineBoundary(combined, capBytes)
  }

  /** The widest the pane has been: none of its output was written for a wider one. */
  get widestCols(): number {
    return this.widest
  }

  /** Where the output stands now, in the units of a data event's `end`. */
  get outputEnd(): number {
    return this.appended
  }

  private append(text: string): number {
    this.scrollback.append(text)
    this.appended += text.length
    return this.appended
  }

  get retainedBytes(): number {
    return this.scrollback.byteLength
  }

  /** Kills the process tree and releases every listener. Safe to call twice. */
  async close(): Promise<void> {
    // Before the kill: the exit that follows must not be read as a refused resume.
    this.closing = true
    if (this.running) {
      const exited = this.waitForExit(CLOSE_TIMEOUT_MS)
      await killProcessTree(this.pid, this.platform)
      await exited
    }

    try {
      this.pty.kill()
    } catch {
      // Already reaped.
    }

    this.cancelQuietWatch?.()
    this.cancelQuietWatch = undefined
    this.cancelScreenRead?.()
    this.cancelScreenRead = undefined
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
    if (this.clock() - this.resizedAt >= REDRAW_AFTER_RESIZE_MS) this.noteActivity()
    this.emit({ type: 'data', data: chunk, end: this.append(chunk) })
    this.cancelScreenRead ??= this.scheduler(() => {
      this.cancelScreenRead = undefined
      void this.readScreen()
    }, SCREEN_READ_AFTER_MS)
    const { titles, bells } = this.titles.scan(chunk)
    // Reported from here because `outputEvidence.ts` strips the bell downstream.
    if (bells > 0) {
      this.lastBellAt = this.clock()
      this.emit({ type: 'bell', at: this.lastBellAt })
    }
    for (const title of titles) {
      if (title === this.title) continue
      this.title = title
      if (titleOpinion(this.agent, title) === 'working') this.tookTurn = true
      this.emit({ type: 'title', title })
    }
    // Each chunk after the reap pushes the quiet window out again, up to the ceiling.
    if (this.draining) this.restartQuietWindow()
  }

  /**
   * Marks the pane busy and restarts the quiet countdown. Only the two edges
   * are reported; a notification per chunk would be one per frame of a build.
   */
  private noteActivity(): void {
    this.lastOutputAt = this.clock()
    this.cancelQuietWatch?.()
    if (!this.busy) {
      this.busy = true
      // A fresh burst of output retires the previous burst's bell.
      this.lastBellAt = undefined
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

  /** Rebuilds the screen from the tail and reads its bottom rows for a question; a shell's are never read. */
  private async readScreen(): Promise<void> {
    const read = ++this.screenReads
    const agent = this.agent ?? this.foregroundAgent()
    const rows = agent === undefined ? [] : await screenRows(this.read(SCREEN_TAIL_BYTES), this.cols, this.rows)
    if (read !== this.screenReads || !this.running) return
    this.screenAsks = screenQuestion(agent, rows) ?? menuQuestion(rows) ?? undefined
    const says = screenOpinion(agent, rows) ?? undefined
    const menu = screenMenu(agent, rows) ?? undefined
    if (says === this.screenSays && menu?.prompt === this.screenMenu?.prompt) return
    this.screenSays = says
    this.screenMenu = menu
    this.init.onScreenChange?.(this)
  }

  /** The keypresses of `data` when the screen, read now, still shows `prompt` and offers them as one answer; else null. */
  async answerKeys(prompt: string, data: string): Promise<readonly string[] | null> {
    const agent = this.agent ?? this.foregroundAgent()
    if (agent === undefined || !this.running) return null
    const menu = screenMenu(agent, await screenRows(this.read(SCREEN_TAIL_BYTES), this.cols, this.rows))
    if (menu === null || menu.prompt !== prompt) return null
    return menu.choices.find((choice) => choice.keys?.join('') === data)?.keys ?? null
  }

  private get clock(): () => number {
    return this.init.now ?? Date.now
  }

  private get scheduler(): (run: () => void, delayMs: number) => () => void {
    return this.init.schedule ?? scheduleUnref
  }

  private finish(exitCode: number, signal: number | undefined): void {
    if (!this.running || this.draining) return
    // A signalled death has exitCode 0; the shell convention of 128 + signal keeps it apart.
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
   * The exit everyone else sees. Only reached once output has gone quiet or the
   * ceiling has run out, so the exit landing means the scrollback is complete.
   */
  private settleExit(): void {
    const draining = this.draining
    if (!draining || !this.running) return
    draining.cancelQuiet()
    draining.cancelCeiling()
    this.draining = undefined
    this.cancelQuietWatch?.()
    this.cancelQuietWatch = undefined
    const wasBusy = this.busy
    this.busy = false

    // Asked before `running` settles: for a refused resume this pane has not
    // ended, a fresh agent takes the dead one's place and no subscriber sees an exit.
    const restarting = this.restartAfterRefusedResume(draining.exitCode)
    if (!restarting) this.running = false

    // The quiet countdown that would have reported this edge was just cancelled.
    if (wasBusy) this.init.onActivityChange?.(this)
    if (restarting) return

    this.exitCode = draining.exitCode
    this.emit({ type: 'exit', exitCode: this.exitCode })
    for (const waiter of this.exitWaiters) waiter()
    this.exitWaiters.clear()
    // Last, so every subscriber has read the whole buffer on the back of the exit.
    this.scrollback.restrictTo(EXITED_RETENTION_BYTES)
  }

  /**
   * Says, in the pane's own output, that the conversation this pane came back
   * for did not come back (a restore happens before the window exists, so nobody
   * is subscribed), retracts the badge, and restarts the agent where it can.
   * Returns true when that happened: the pane has not ended after all.
   */
  private restartAfterRefusedResume(exitCode: number): boolean {
    if (this.restored !== 'agent' || this.closing) return false
    // A clean exit is not a refusal: every one of these CLIs leaves non-zero
    // when it will not resume, and a one-shot agent leaves with zero.
    if (exitCode === 0) return false
    // Past the window, an agent that ends is an agent that ended.
    if (this.clock() - this.startedAt > RESUME_WINDOW_MS) return false

    this.restored = undefined
    this.tookTurn = false
    this.resumeFailed = true
    // The conversation was expected to print itself, and it did not.
    this.recordHeld = false

    // Emitted, not appended: a client reads once when its view mounts, so a
    // window already up needs the record sent; appending would hand a re-mounting
    // view two copies and nest the framing into the next launch's record.
    if (this.record !== undefined) this.emit({ type: 'data', data: replayableRecord(this.record, FAILED_RESUME_BELOW) })

    // Before the note, which says which of the two things happened.
    const restarted = this.restartAgent()

    const note = failedResumeMark(exitCode, this.record !== undefined, restarted)
    // Appended as well as emitted: a subscriber arriving after the exit reads the pane.
    this.emit({ type: 'data', data: note, end: this.append(note) })

    if (restarted) this.init.onRestart?.(this)
    return restarted
  }

  /**
   * Puts a fresh agent on the other end of this pane, keeping its id, listeners,
   * title and output. The old subscriptions go first: a `recoverTailOnTeardown`
   * left in place would read an fd about to be handed to somebody else.
   */
  private restartAgent(): boolean {
    const command = this.init.restartCommand
    if (command === undefined) return false
    let handle: IPty
    try {
      handle = startChild(this.init, command, this.platform)
    } catch {
      // The pane reports the exit it was going to report anyway.
      return false
    }
    for (const subscription of this.subscriptions) subscription.dispose()
    this.subscriptions.length = 0
    this.pty = handle
    try {
      // The pane is very likely not the size `init` describes any more.
      handle.resize(this.cols, this.rows)
    } catch {
      // Died between the spawn and this call; its exit arrives through `listen`.
    }
    this.agentRestarted = true
    this.listen(handle)
    return true
  }

  /**
   * True once the resume failed and nothing was started in its place; the manager
   * writes that down so the pane does not fail the same way on every launch.
   * False again after a restart: `onRestart` has already corrected the record.
   */
  get resumeDidNotTake(): boolean {
    return this.resumeFailed && !this.agentRestarted
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

/**
 * Puts one child on the other end of a new pty. The command is separate from
 * `init` because a pane whose resume is refused restarts under a different one.
 */
function startChild(init: PtySessionInit, command: string | undefined, platform: NodeJS.Platform): IPty {
  const { file, args } = buildShellCommand(init.shell, command, platform)
  // The login shell's PATH, not the one launchd handed a desktop-launched app.
  const env = buildTerminalEnv(init.env, platform, loginShellPath({ platform }), init.tone)

  // Windows refuses a missing shell in spawn(); POSIX forks fine and the helper's
  // execvp failure goes to the pty, so the pane appears and vanishes. Ask first.
  if (shellCannotRun(file, env, init.cwd, platform)) {
    throw terminalFailed(`failed to start ${file}: ${SHELL_UNRUNNABLE}`, { cwd: init.cwd })
  }

  try {
    return spawn(file, args, {
      name: TERMINAL_TYPE,
      cwd: init.cwd,
      cols: init.cols,
      rows: init.rows,
      env
    })
  } catch (error) {
    throw terminalFailed(`failed to start ${file}: ${startFailureReason(error)}`, { cwd: init.cwd })
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

/** Windows reports a missing shell as "File not found" out of spawn; same words as the POSIX check. */
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

/** The events a keystroke overtakes: a request, and a turn the agent said was running. */
function overtakenByTyping(event: AgentEvent | undefined): boolean {
  return event !== undefined && (event.event === 'Notification' || event.event === 'UserPromptSubmit')
}
