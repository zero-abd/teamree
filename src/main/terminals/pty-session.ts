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
import type { AgentKind } from './agent-command'
import { TitleSequenceScanner } from './title-sequence'
import { titleOpinion, type TitleOpinion } from '../../shared/titleOpinion'

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

/**
 * What a pane keeps once it has exited.
 *
 * A dead pty appends nothing more, so the whole of an exited pane's buffer is
 * memory held against whoever reads it next — and those readers are real: the
 * renderer repaints a pane from `terminal.read` every time its view remounts,
 * the sidebar reads the last few KB once more after the exit, `teamree
 * terminal read` answers out of it, and a teammate joining a watch takes its
 * snapshot from it. So it is trimmed rather than freed. Every one of them wants
 * the tail; the head of a finished command is what nobody comes back for.
 *
 * Sixteen times smaller than a live pane's cap, which is the difference between
 * a day of command panes costing tens of megabytes and costing a few.
 */
export const EXITED_RETENTION_BYTES = 256 * 1024

/**
 * How long after a pane is brought back to resume a conversation an exit still
 * counts as the resume having failed.
 *
 * An agent that will not resume says so and leaves: it reads its own store,
 * finds nothing under the id, prints a line and exits. That happens in the
 * first seconds or not at all, so this window is set well past however long a
 * cold start and a store read can take and nowhere near long enough to reach a
 * session that ran for a while and then died of something else. The bound is
 * what makes the mark below a statement rather than a guess — past it, an agent
 * that ends is an agent that ended, and this app has nothing to add.
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
  platform?: NodeJS.Platform
  scrollbackCapBytes?: number
  /** Set when this session is a previous run's pane being brought back. */
  restored?: 'shell' | 'agent'
  /**
   * What the pane printed the last time it was open, for a pane being brought
   * back. Read by everything that reads this pane's output and appended to by
   * nothing: it is a record of a process that has ended, kept apart from the
   * live buffer so that no byte of it can ever be mistaken for one this session
   * produced.
   */
  restoredRecord?: RecordedScrollback
  /**
   * What the mark under that record says is starting below it. Absent means the
   * ordinary "a new shell", which is what a restored pane opens; a pane run
   * again names the program it is running again instead.
   */
  recordStartsBelow?: string
  /**
   * A line to put in the pane before anything this session prints.
   *
   * For the one thing a pane cannot show by itself: that it is not the launch
   * its record asked for. A pane whose conversation was found to be missing
   * comes back as a fresh agent, and a fresh agent looks like a fresh agent —
   * so the reason is written in, above it, where whoever opens the pane will
   * read it. Written into the pane's own output rather than emitted alongside
   * it, because the copy that matters is the one `terminal.read` answers with:
   * nobody is subscribed at the moment a pane starts.
   */
  startupNote?: string
  /** Which coding agent this pane runs, when it runs one. */
  agent?: AgentKind
  /**
   * What to run in this pane if the resume it came back for is refused.
   *
   * A pane brought back to pick a conversation up and told there is no such
   * conversation has done all it can with the command it was given. Without
   * this it stops there, holding an explanation and nothing else, and the
   * person who opened it has to open it again. With it the pane says what
   * happened and then starts the agent afresh in the same place — which is what
   * they were going to do anyway, and what a pane nobody ever typed into
   * already does on its own.
   *
   * Used at most once per pane: the second start is a fresh agent, not a
   * resume, so nothing it does afterwards can be read as a refusal.
   */
  restartCommand?: string
  /** Called after that restart, so the pane's record can say what is running. */
  onRestart?: (session: PtySession) => void
  /** What the pane is called, when somebody has said; see `Terminal.label`. */
  label?: string
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

  /**
   * Not held as a field: a pane that has restarted its agent has a different
   * child, and a pid captured at construction would name a process that has
   * been reaped — which `close()` would then go looking for a tree under.
   */
  get pid(): number {
    return this.pty.pid
  }

  private pty: IPty
  private readonly platform: NodeJS.Platform
  private readonly scrollback: ScrollbackBuffer
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
  private restored: 'shell' | 'agent' | undefined
  private busy = false
  /**
   * When the bell last rang, within the burst of output this pane is still in.
   *
   * Kept per burst rather than forever: see `Terminal.lastBellAt`. Held here
   * and not merely emitted, because the pane that rang it is asking for
   * something for as long as nobody has answered, and a subscriber that
   * attached a minute later would otherwise have no way to learn that.
   */
  private lastBellAt: number | undefined
  private lastOutputAt: number
  private readonly startedAt: number
  private cancelQuietWatch: (() => void) | undefined
  /** Set when the child has been reaped but its output has not gone quiet. */
  private draining: { exitCode: number; cancelQuiet: () => void; cancelCeiling: () => void } | undefined
  /**
   * True while the record this pane came back with is held rather than shown.
   *
   * A pane resuming a conversation is about to print that conversation itself,
   * so replaying a transcript of it would show the same exchange twice. But
   * "about to" is a bet, and the record is the only copy of what this pane
   * printed before the restart — so it is held rather than dropped, and let go
   * of the moment the bet turns out to have been wrong.
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
    this.cols = init.cols
    this.rows = init.rows
    this.platform = platform
    this.pty = handle
    this.scrollback = new ScrollbackBuffer(init.scrollbackCapBytes)
    this.record = init.restoredRecord
    this.recordHeld = init.restored === 'agent' && init.restoredRecord !== undefined
    this.title = initialTitle(init, platform)
    this.label = init.label
    this.restored = init.restored
    this.lastOutputAt = (init.now ?? Date.now)()
    this.startedAt = this.lastOutputAt

    // Before the child is listened to, so it is above the first byte the child
    // prints however quickly that arrives.
    if (init.startupNote !== undefined) this.scrollback.append(init.startupNote)

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
    const titleSays: TitleOpinion | null = titleOpinion(this.agent, this.title)
    return {
      id: this.id,
      worktreeId: this.worktreeId,
      title: this.title,
      cwd: this.cwd,
      shell: this.shell,
      cols: this.cols,
      rows: this.rows,
      running: this.running,
      // Said out loud rather than left to be inferred from `running`, which is
      // deliberately still true here: `write` already throws, so a reader that
      // only had `running` would offer a pane that cannot take anything.
      ...(this.draining === undefined ? {} : { draining: true }),
      ...(this.exitCode === undefined ? {} : { exitCode: this.exitCode }),
      ...(this.restored === undefined ? {} : { restored: this.restored }),
      ...(this.agent === undefined ? {} : { agent: this.agent }),
      ...(this.label === undefined ? {} : { label: this.label }),
      busy: this.busy,
      // Derived here rather than stored, so it cannot drift from the title it
      // is a reading of. A reader with both fields is reading one fact.
      ...(titleSays === null ? {} : { titleSays }),
      ...(this.lastBellAt === undefined ? {} : { lastBellAt: this.lastBellAt }),
      lastOutputAt: this.lastOutputAt
    }
  }

  get isRunning(): boolean {
    return this.running
  }

  /** Whether output is still arriving; see `noteActivity` for what that means. */
  get isBusy(): boolean {
    return this.busy
  }

  /**
   * Renames the pane, or takes the name away when given nothing.
   *
   * A blank is cleared rather than kept, because a pane called "   " is a pane
   * with no name at all drawn as though it had one. What is left then is the
   * program's own name, which is where every unnamed pane starts.
   */
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
   * Puts bytes on the pty, and records who put them there.
   *
   * `byHand` is false for the bytes the emulator sends of its own accord — its
   * answers to the device queries a full-screen program asks constantly. Those
   * belong on the pty like any other, and they are the one kind of write that
   * says nothing about whether anybody is here: an agent pane produces them
   * within a second of starting, before the window is even looked at. Only the
   * window can tell them from a keystroke, so it is the window that says; see
   * `handsHere.ts`.
   *
   * Defaulting to a person is the safe direction of the two. Everything else
   * that writes here is one — the CLI's `terminal send`, a teammate's keystroke
   * — and the cost of getting it wrong that way is a resume attempted for a
   * pane that had nothing to resume, which now says so and starts over. The
   * other way round loses a real conversation.
   */
  write(data: string, byHand = true): void {
    // Draining counts as exited here: the child has been reaped, so there is
    // nothing on the other end to read this, however the event is still held.
    if (!this.running || this.draining) {
      throw new TerminalServiceError(ErrorCode.Conflict, `terminal ${this.id} has exited`)
    }
    if (byHand) {
      // Typing into a restored pane is the user taking it over; the badge has
      // said what it had to say by then.
      this.restored = undefined
      this.typedInto = true
      // And a bell is a question: this is somebody answering it. Leaving it set
      // would leave the pane asking for something it has just been given. An
      // emulator's reply answers nobody's question, so it leaves the bell up.
      this.lastBellAt = undefined
    }
    this.pty.write(data)
  }

  /**
   * Whether anybody has typed into this pane, which is what the next launch
   * needs in order to know there is a conversation to come back to at all.
   * See `TerminalRecord.typed` for why input rather than output is the question.
   */
  get wasTypedInto(): boolean {
    return this.typedInto
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

  /**
   * What this pane shows: the record of the run before this one, if there is
   * one, and then everything this session has printed.
   *
   * The record is framed rather than concatenated. Every reader of this — the
   * renderer repainting a pane, `teamree terminal read`, a teammate joining a
   * watch — is told in words where the old output ends and this session begins,
   * because a reader who thinks a finished build is still running will wait for
   * it. See `scrollbackRecord.ts` for the marks and for why nothing in a record
   * can do anything but print.
   */
  read(tailBytes?: number): string {
    const live = this.scrollback.tail(tailBytes)
    if (this.record === undefined || this.recordHeld) return live
    // What follows the record is a new shell in the ordinary case, and the
    // attempt at resuming that did not take in the other one.
    const framed = replayableRecord(this.record, this.resumeFailed ? FAILED_RESUME_BELOW : this.init.recordStartsBelow)
    if (tailBytes === undefined) return `${framed}${live}`

    // A tail short enough to be answered out of this session alone is answered
    // that way: the live output is the newer half, and the record is only ever
    // asked for what is left over.
    const remaining = tailBytes - Buffer.byteLength(live, 'utf8')
    if (remaining <= 0) return live
    return `${tailFromLineBoundary(framed, remaining)}${live}`
  }

  /**
   * The pane's output as it is written down for the next launch: the record it
   * came back with, then this session's own.
   *
   * Without the marks, deliberately. They describe a record rather than being
   * part of one, and whoever replays this next adds them again — keeping them
   * would nest one restart's framing inside the next one's, and leave a line
   * promising a new shell in the middle of the scrollback.
   */
  recordedOutput(capBytes?: number): string {
    const live = this.scrollback.tail(capBytes)
    if (this.record === undefined) return live
    // A record that ended mid-line must not have this session's first line run
    // on from it.
    const joined = this.record.text.endsWith('\n') ? this.record.text : `${this.record.text}\r\n`
    const combined = `${joined}${live}`
    return capBytes === undefined ? combined : tailFromLineBoundary(combined, capBytes)
  }

  get retainedBytes(): number {
    return this.scrollback.byteLength
  }

  /** Kills the process tree and releases every listener. Safe to call twice. */
  async close(): Promise<void> {
    // Before the kill, and the whole reason this flag exists: a pane this app
    // is ending on purpose is not a pane that failed at anything, and the exit
    // that follows must not be read as an agent refusing to resume.
    this.closing = true
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
    const { titles, bells } = this.titles.scan(chunk)
    // Announced before it is thrown away. Downstream a bell is stripped as
    // noise -- `outputEvidence.ts` drops it so it cannot become a glyph in the
    // middle of a quoted line -- and stripping it there is right, which is
    // exactly why it has to be reported from here.
    if (bells > 0) {
      this.lastBellAt = this.clock()
      this.emit({ type: 'bell', at: this.lastBellAt })
    }
    for (const title of titles) {
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
      // A fresh burst of output retires the previous burst's bell. Whatever the
      // pane was asking for, it has gone back to doing something since.
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
    // An exited pane is not busy, whatever it was doing a moment ago.
    this.cancelQuietWatch?.()
    this.cancelQuietWatch = undefined
    const wasBusy = this.busy
    this.busy = false

    // Asked before `running` is settled and before anybody is told anything,
    // because for a refused resume this pane has not ended: the note is printed
    // and a fresh agent takes the dead one's place, and no subscriber ever sees
    // an exit. Every report below then describes whichever of the two happened.
    const restarting = this.restartAfterRefusedResume(draining.exitCode)
    if (!restarting) this.running = false

    // The quiet countdown that would have reported this edge was just
    // cancelled, so the edge has to be reported here instead: a pane that dies
    // mid-burst goes busy -> not busy like any other, and a subscriber watching
    // activity must not be left holding the last thing it was told.
    if (wasBusy) this.init.onActivityChange?.(this)
    if (restarting) return

    this.exitCode = draining.exitCode
    this.emit({ type: 'exit', exitCode: this.exitCode })
    for (const waiter of this.exitWaiters) waiter()
    this.exitWaiters.clear()
    // Last, so every subscriber has had the exit and whatever it read on the
    // back of it out of the whole buffer. From here nothing is appended again,
    // so what is kept is only what a later reader can ask for.
    this.scrollback.restrictTo(EXITED_RETENTION_BYTES)
  }

  /**
   * Says, in the pane, that the conversation this pane came back for did not
   * come back — and stops claiming that it did.
   *
   * A pane brought back to resume ends one of two ways: somebody takes it over,
   * which clears the badge on the first keystroke, or it is still wearing that
   * badge when the process ends. The second one is a pane that was handed a
   * conversation to pick up and never picked one up, and there is exactly one
   * honest thing to do with it, which is to say so where the person will be
   * looking. Nothing else in the app will: the renderer's own exit line is
   * written by whoever is subscribed at the moment of the exit, and a restore
   * happens before the window exists, so a pane that dies in its first second
   * has nobody listening. This goes into the pane's own output instead, which
   * is what the window paints from whenever it does open.
   *
   * The badge is retracted in the same breath. A pane reading "resumed" beside
   * "exited 1", with a refusal from a CLI as its entire contents, is the app
   * asserting something it can see is not true — and of everything here that is
   * the part a person could not work out for themselves.
   *
   * Then, where there is a command to do it with, the agent is started again in
   * this same pane. A conversation being gone is not a reason for the pane to
   * be gone too: what the person wanted was an agent in this checkout, and the
   * fresh one they would have opened by hand is the one this starts for them.
   * Returns true when that happened, which is the caller's signal that this
   * pane has not ended after all.
   */
  private restartAfterRefusedResume(exitCode: number): boolean {
    if (this.restored !== 'agent' || this.closing) return false
    // A clean exit is not a refusal. Every one of these CLIs leaves non-zero
    // when it will not resume, and an agent asked to do one thing and print the
    // answer — which is a mode, not a different program, so nothing upstream can
    // tell it apart from the interactive one — does its work and leaves with
    // zero. Saying "nothing was resumed" over that would be false in every
    // clause, which is precisely what this is here to stop.
    if (exitCode === 0) return false
    // Past the window, an agent that ends is an agent that ended: it may well
    // have resumed fine an hour ago, and this app would be inventing a cause.
    if (this.clock() - this.startedAt > RESUME_WINDOW_MS) return false

    this.restored = undefined
    this.resumeFailed = true
    // Let go of the record in the same moment. It was held back because the
    // conversation was expected to print itself, and it did not.
    this.recordHeld = false

    // Released *and delivered*. Un-holding it only changes what `read()`
    // answers, and a client reads once when its view mounts — so a window that
    // was already up when the agent gave up would be told the old output is
    // above this line while never having been sent a byte of it. The note makes
    // a claim about what is on the screen, so the thing it claims is there has
    // to be put there by the same path the claim travels on.
    //
    // Emitted rather than appended, deliberately, and it is the one piece of
    // text here that is not in the scrollback: `read()` builds the record in
    // from the other side, so appending it would hand a re-mounting view two
    // copies, and `recordedOutput()` would write a framed record into the next
    // launch's record — the nesting that `recordedOutput` warns about. The cost
    // is that a view attached at this moment sees the record below the refusal
    // rather than above it, where a view mounting later sees it above. Both have
    // all of it, and in both the record stands above the note that describes it.
    if (this.record !== undefined) this.emit({ type: 'data', data: replayableRecord(this.record, FAILED_RESUME_BELOW) })

    // Attempted before the note is written, because the note says which of the
    // two things happened and must not promise a fresh agent that failed to
    // start. A start that throws — the shell gone, the checkout unmounted — is
    // the pane ending the way it would have ended anyway.
    const restarted = this.restartAgent()

    const note = failedResumeMark(exitCode, this.record !== undefined, restarted)
    // Appended as well as emitted, so it is in what `terminal.read` answers
    // with. That is the copy that matters here — a subscriber arriving after
    // the exit gets the pane by reading it, not by having been told.
    this.scrollback.append(note)
    this.emit({ type: 'data', data: note })

    if (restarted) this.init.onRestart?.(this)
    return restarted
  }

  /**
   * Puts a fresh agent on the other end of this pane, keeping everything the
   * pane is: its id, its listeners, its title, and every byte it has printed.
   *
   * The old child's subscriptions go first. They are bound to a pty that has
   * already been reaped, and a `recoverTailOnTeardown` left in place would go
   * on reading a file descriptor this process is about to hand to somebody
   * else.
   */
  private restartAgent(): boolean {
    const command = this.init.restartCommand
    if (command === undefined) return false
    let handle: IPty
    try {
      handle = startChild(this.init, command, this.platform)
    } catch {
      // Nothing to add: the pane is about to report the exit it was going to
      // report, and the agent's own refusal is already on the screen above.
      return false
    }
    for (const subscription of this.subscriptions) subscription.dispose()
    this.subscriptions.length = 0
    this.pty = handle
    try {
      // The pane has been drawn since it was created and is very likely not the
      // size `init` describes any more.
      handle.resize(this.cols, this.rows)
    } catch {
      // A child that died between the spawn and this call; its own exit is
      // already on its way through `listen` below.
    }
    this.agentRestarted = true
    this.listen(handle)
    return true
  }

  /**
   * True once this pane has said that the conversation it came back for did not
   * come back, and nothing has been started in its place. Read by the manager,
   * which writes that down: a pane whose resume failed has nothing to resume
   * next time either, and saying so in the record is what stops it failing the
   * same way on every launch from here on.
   *
   * False again once a fresh agent has taken over, because by then the record
   * has already been corrected — `onRestart` fires at that moment and says what
   * is running — and a second answer arriving at the pane's eventual exit would
   * write "nobody ever typed here" over a pane somebody has since worked in.
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
 * Puts one child on the other end of a new pty.
 *
 * Takes the command separately from the rest of the pane's description because
 * a pane can outlive the command it was opened with: one whose resume is
 * refused starts its agent again, in the same pane, under a different command
 * line. Everything else about the pane — where it runs, how big it is, which
 * shell wraps it — is the same both times and comes from `init`.
 */
function startChild(init: PtySessionInit, command: string | undefined, platform: NodeJS.Platform): IPty {
  const { file, args } = buildShellCommand(init.shell, command, platform)
  // The login shell's PATH rather than this process's: a pane opened from a
  // desktop launch would otherwise start from the PATH launchd handed the
  // app, which is not the one the user installed anything on.
  const env = buildTerminalEnv(init.env, platform, loginShellPath({ platform }))

  // The two platforms answer "that shell is not there" in different places.
  // Windows refuses in spawn() below. POSIX does not refuse at all: the fork
  // succeeds, the helper's own execvp failure goes to the pty, and the caller
  // is handed a running session that dies a moment later — a pane that
  // appears and vanishes, with nothing anywhere saying why. So the platform
  // that will not raise is asked the question first, and both ends here.
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
