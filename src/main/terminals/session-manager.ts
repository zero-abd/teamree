// The registry behind every terminal.* and layout.* method.
//
// It owns three things and nothing else: the live sessions, the pane tree per
// worktree, and the streams attached to each terminal. Process behaviour lives
// in PtySession, tree behaviour in pane-tree; this file is the part that has to
// know that closing a pane also removes its leaf and ends its streams.

import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { agentLaunchCommand } from '../../shared/agentLaunch'
import type { RestoredAs } from '../../shared/paneRestore'
import type { Layout, PaneNode, Terminal } from '../../shared/entities'
import { evidenceLine } from '../../shared/outputEvidence'
import type { ParamsOf, TerminalEvent } from '../../shared/methods'
import {
  detectAgent,
  firstPromptCommand,
  newSessionId,
  pinSessionCommand,
  pinsOwnSessionId,
  restartSessionCommand,
  type AgentKind
} from './agent-command'
import { appendPane, parsePaneNode, removePane, splitPane, terminalIdsIn } from './pane-tree'
import { conversationOnDisk, type ConversationEvidence, type ConversationQuestion } from './agent-conversations'
import { restorableRecords, restoreLaunch, type TerminalRecord } from './session-restore'
import { CHECKPOINT_SOURCE_BYTES, ScrollbackCheckpoints } from './scrollbackCheckpoints'
import {
  closingMark,
  NEW_SHELL_BELOW,
  sanitizeRecordedOutput,
  startsAgainBelow,
  tailFromLineBoundary,
  type RecordedScrollback
} from './scrollbackRecord'
import { EXITED_RETENTION_BYTES, PtySession } from './pty-session'
import { conflict, invalidParams, notFound } from './service-error'
import { resolveLoginShell } from './shell-environment'

/** Size a pane starts at before the renderer measures itself and resizes. */
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

/**
 * One subscriber's end of a terminal's event stream. Deliberately the shape the
 * runtime's subscription hub hands to a stream source, so a hub subscription can
 * be attached directly without an adapter.
 */
export type StreamChannel = {
  emit: (event: TerminalEvent) => void
  /** Ends the subscription from this side: the terminal is gone. */
  close: () => void
}

/**
 * Where layouts live. The default keeps them in memory; pass the workspace store
 * (it already has getLayout/putLayout) and they survive a restart instead.
 */
export type LayoutRepository = {
  getLayout(worktreeId: string): Layout | undefined
  putLayout(layout: Layout): Layout
  /** Needed to reconcile stored layouts at startup; in-memory repos can omit it. */
  listLayouts?(): Layout[]
}

/**
 * Where terminal records live between launches. Optional for the same reason
 * layouts are: an in-memory manager has nothing to restore from and should not
 * have to pretend otherwise.
 */
export type SessionRepository = {
  listTerminals(): TerminalRecord[]
  putTerminal(record: TerminalRecord): TerminalRecord
  removeTerminal(terminalId: string): boolean
}

/**
 * Where a pane's output lives between launches, which is deliberately not where
 * the pane's own record lives: a description of a pane is a few hundred bytes
 * and belongs in the workspace file, and a transcript is orders of magnitude
 * larger and does not. `scrollbackArchive.ts` is the implementation and makes
 * that argument in full; this is the whole of what the manager asks of it.
 *
 * Optional for the same reason the two repositories above are: an in-memory
 * manager has no previous launch and should not have to pretend otherwise.
 */
export type ScrollbackRepository = {
  read(terminalId: string): RecordedScrollback | undefined
  put(terminalId: string, text: string): void
  remove(terminalId: string): void
  flush(): Promise<void>
}

export type TerminalSessionManagerOptions = {
  /**
   * Where a terminal starts when terminal.create omits `cwd`: the worktree's
   * checkout path, which only the worktree service knows.
   */
  resolveWorktreeCwd?: (worktreeId: string) => string | undefined
  /**
   * What a worktree was opened to do — `Worktree.task` — for a pane that is
   * starting its agent over with no conversation behind it, so the agent is
   * told again rather than started bare.
   */
  resolveWorktreeTask?: (worktreeId: string) => string | undefined
  layouts?: LayoutRepository
  /** Pass the workspace store and terminals come back after a restart. */
  sessions?: SessionRepository
  /** Pass an archive and they come back showing what they last printed. */
  scrollback?: ScrollbackRepository
  /**
   * How long after a running pane's output its record is checkpointed. The
   * default is the one `scrollbackCheckpoints.ts` argues for; a test that would
   * otherwise wait fifteen seconds for a write asks for a shorter one.
   */
  checkpointIntervalMs?: number
  /**
   * Delivers events for subscriptions opened through subscribe(). Ignored when
   * the caller attaches streams itself via attachStream().
   */
  publish?: (subscription: string, event: TerminalEvent) => void
  scrollbackCapBytes?: number
  /** Overridable so tests can assert on readable ids. */
  createId?: () => string
  /**
   * Called when a pane starts or stops producing output. Reported rather than
   * published, so the manager stays unaware of the workspace stream.
   */
  onActivityChange?: (terminalId: string) => void
  /**
   * Called when a pane that is running an agent stops — its output has gone
   * quiet, or its process has ended.
   *
   * A narrower event than the one above and deliberately a separate one. That
   * one is both edges of every pane, which is what a sidebar dot is drawn from;
   * this is the half of one edge that is worth interrupting somebody for. A
   * shell is never reported: a shell going quiet is a shell sitting at its
   * prompt, which is every shell for almost all of its life.
   */
  onAgentSettled?: (settled: AgentSettled) => void
  /**
   * Whether the conversation a restored pane would resume is on this disk.
   *
   * The default reads the agents' own stores under the user's home directory,
   * which is the whole point of it — see `agent-conversations.ts`. Overridable
   * so a test can point the same question at a store it built, rather than at
   * whatever the machine running the suite happens to have in it.
   */
  conversationEvidence?: (question: ConversationQuestion) => ConversationEvidence
}

/**
 * An agent pane that has stopped.
 *
 * The line is read here rather than by the caller because this is the only
 * place holding the pane's buffer, and it is read at the moment of the edge:
 * asking a second later would be asking a pane that has since printed a prompt.
 */
export type AgentSettled = {
  terminalId: string
  worktreeId: string
  agent: AgentKind
  reason: 'quiet' | 'exit'
  /** The pane's last line worth quoting, or null when there is not one. */
  line: string | null
}

/**
 * How much of a settled pane's tail to look at for a line worth quoting. The
 * same budget the sidebar's evidence reads use, and for the same reason: enough
 * to walk back past a prompt, a run of blank lines and a redrawn progress line.
 */
const SETTLED_TAIL_BYTES = 4096

type AttachedStream = { channel: StreamChannel; detach: () => void }

export type TerminalExitListener = (terminalId: string, exitCode: number) => void

/** See `TerminalSessionManager.onPaneAnswered`. */
export type PaneAnsweredListener = (terminalId: string) => void

export class TerminalSessionManager {
  private readonly sessions = new Map<string, PtySession>()
  private readonly streams = new Map<string, Set<AttachedStream>>()
  private readonly exitListeners = new Set<TerminalExitListener>()
  private readonly answeredListeners = new Set<PaneAnsweredListener>()
  /**
   * Panes brought back from the last launch that have not gone quiet yet.
   *
   * A restored agent pane replays its conversation and then stops, which looks
   * exactly like an agent finishing a piece of work and is not one — so without
   * this every launch would raise a notification for every agent pane the last
   * one left open, seconds after the window opened, about work that finished
   * yesterday. The id leaves this set on that first edge, so the next time the
   * pane goes quiet it is announced like any other.
   */
  private readonly resuming = new Set<string>()
  private readonly ownSubscriptions = new Map<string, { terminalId: string; end: () => void }>()
  private readonly layouts: LayoutRepository
  private readonly records: SessionRepository
  private readonly scrollback: ScrollbackRepository | undefined
  private readonly checkpoints: ScrollbackCheckpoints | undefined

  constructor(private readonly options: TerminalSessionManagerOptions = {}) {
    this.layouts = options.layouts ?? new InMemoryLayoutRepository()
    this.records = options.sessions ?? new InMemorySessionRepository()
    this.scrollback = options.scrollback
    // Only with somewhere to write: a manager with no archive has no reason to
    // hold a timer, and the panes of an in-memory one are not coming back.
    const archive = options.scrollback
    this.checkpoints =
      archive === undefined
        ? undefined
        : new ScrollbackCheckpoints({
            // A pane that has been closed in the interval since the checkpoint
            // was armed answers nothing, and nothing is written for it.
            read: (terminalId) => this.sessions.get(terminalId)?.recordedOutput(CHECKPOINT_SOURCE_BYTES),
            put: (terminalId, text) => archive.put(terminalId, text),
            ...(options.checkpointIntervalMs === undefined ? {} : { intervalMs: options.checkpointIntervalMs })
          })
  }

  list(worktreeId?: string): Terminal[] {
    const all = [...this.sessions.values()]
    const scoped = worktreeId === undefined ? all : all.filter((session) => session.worktreeId === worktreeId)
    return scoped.map((session) => session.snapshot())
  }

  /** Starts a terminal and gives it a pane at the top level of the worktree. */
  create(params: ParamsOf<'terminal.create'>): Terminal {
    const session = this.startSession(params)
    const layout = this.layoutFor(session.worktreeId)
    this.saveLayout({
      worktreeId: session.worktreeId,
      root: appendPane(layout.root, session.id),
      focusedTerminalId: session.id
    })
    return session.snapshot()
  }

  /** Starts a terminal in half of an existing pane. */
  split(params: ParamsOf<'terminal.split'>): { terminal: Terminal; layout: Layout } {
    const target = this.require(params.terminalId)
    const size = target.snapshot()
    const session = this.startSession({
      worktreeId: target.worktreeId,
      shell: target.shell,
      cwd: target.cwd,
      cols: size.cols,
      rows: size.rows,
      ...(params.command === undefined ? {} : { command: params.command })
    })

    const layout = this.layoutFor(target.worktreeId)
    const saved = this.saveLayout({
      worktreeId: target.worktreeId,
      root: splitPane(layout.root, target.id, params.direction, session.id),
      focusedTerminalId: session.id
    })
    return { terminal: session.snapshot(), layout: saved }
  }

  /**
   * Runs an exited pane's program again, in the pane it left behind.
   *
   * Agents exit for reasons that have nothing to do with the work being
   * finished: a crash, a rate limit, a quit, a resume that found nothing. What
   * the person wants next is always the same thing — that agent, in that
   * directory, again — and doing it by hand costs a new pane, the command
   * remembered, and their place in the scrollback they were still reading.
   *
   * Deliberately not a resume. Whether this pane's conversation is worth coming
   * back to is a question `restoreLaunch` already asks, at startup, with
   * everything written down about the pane; asking it a second time here would
   * be a second answer to it given with less, and the pane this is most for is
   * the one whose resume just failed. So the agent starts over under a freshly
   * pinned id, which is exactly what a pane nobody ever typed into comes back
   * as.
   *
   * The pane itself does not move. Same terminal id, so the leaf in the split
   * tree still points at it and no layout is rewritten; same streams, pointed
   * at the new process; and what the dead pane printed is carried over as this
   * session's record, so it stands above a line saying the program starts
   * again, the way a restored pane's output does.
   *
   * Refused while the pane is running, because then there is nothing to run
   * again — and `running` stays true across the window where a reaped pane's
   * last output is still arriving, so that window is refused too rather than
   * having a second process print into the middle of it.
   */
  async relaunch(params: ParamsOf<'terminal.relaunch'>): Promise<Terminal> {
    const previous = this.require(params.terminalId)
    if (previous.isRunning) {
      throw conflict(`terminal ${params.terminalId} has not exited; there is nothing to run again`)
    }

    const size = previous.snapshot()
    const stored = this.records.listTerminals().find((record) => record.id === params.terminalId)
    const launch = relaunchCommand(stored)
    const below = launch.agent === undefined ? NEW_SHELL_BELOW : startsAgainBelow(launch.agent)
    // Told its task again only when nobody ever told it anything: a pane that
    // held a conversation is starting a new one by choice, and the person
    // pressing the button is there to say what it is for.
    const prompt = stored !== undefined && launch.agent !== undefined ? this.taskToRepeat(stored) : undefined

    // Read before anything is torn down: this is the only copy of what the pane
    // printed, and it is reduced on the way in for the reason `scrollbackRecord`
    // gives — nothing replayed into a live emulator may do anything but print.
    const text = tailFromLineBoundary(sanitizeRecordedOutput(previous.recordedOutput()), EXITED_RETENTION_BYTES)
    const kept: RecordedScrollback | undefined = text.length === 0 ? undefined : { text, recordedAt: Date.now() }

    const restoring: TerminalRecord = {
      id: previous.id,
      worktreeId: previous.worktreeId,
      cwd: previous.cwd,
      shell: previous.shell,
      ...(launch.command === undefined ? {} : { command: launch.command }),
      ...(launch.agent === undefined ? {} : { agent: launch.agent }),
      ...(launch.agentSessionId === undefined ? {} : { agentSessionId: launch.agentSessionId }),
      // The pane keeps its name across the restart. Everything else here is a
      // fact about a process that has just been replaced; the name is a fact
      // about the person who gave it, and running the program again is not them
      // taking it back.
      ...(size.label === undefined ? {} : { label: size.label }),
      // Nobody has typed into the conversation this is opening, so there is
      // nothing under the new id to come back to until somebody does.
      typed: false,
      cols: size.cols,
      rows: size.rows,
      createdAt: stored?.createdAt ?? Date.now()
    }

    // Started before the old session is let go of. A start that fails — a
    // directory that has moved, a shell that is gone — must leave the pane
    // exactly as it was, holding its scrollback, rather than take away the dead
    // pane the person was reading as well as the live one they asked for.
    const session = this.startSession(
      {
        worktreeId: previous.worktreeId,
        cwd: previous.cwd,
        shell: previous.shell,
        cols: size.cols,
        rows: size.rows,
        recordStartsBelow: below,
        ...(launch.command === undefined ? {} : { command: launch.command }),
        ...(prompt === undefined ? {} : { prompt }),
        ...(kept === undefined ? {} : { restoredRecord: kept })
      },
      restoring
    )

    await previous.close()
    this.rebindStreams(session)
    // Said as well as written. `read()` builds this same line in from the
    // record's side, so a view mounting from here on finds it there — but a
    // view that was already open read its snapshot once and will not read
    // again, and the whole job of the line is to sit between the two runs on
    // the screen somebody is looking at.
    for (const stream of this.streamsFor(session.id)) {
      stream.channel.emit({ type: 'data', data: closingMark(below) })
    }
    return session.snapshot()
  }

  /**
   * Sends bytes to a pane's program, and reports the keystroke to anyone who
   * has to redraw because of it.
   *
   * A keystroke changes two things every client holds, and both of them are
   * badges somebody is looking at: it retires the pane's restored badge, and it
   * answers the bell the pane was ringing, which is what the sidebar draws
   * "waiting on you" from. Neither is visible from outside this call — the pane
   * list says what the pane is now, not what it was a byte ago — so this is the
   * only place that can see the edge, and it says so.
   *
   * Reported rather than published, so the manager stays unaware of the
   * workspace stream; `publishTerminalEvents` is what turns it into an event.
   * Reported rather than returned, because the answer has to reach the runtime
   * however the write arrived — the CLI's `terminal send` and a teammate's
   * keystroke both come through handlers that have nothing to do with drawing.
   *
   * `byHand` is false only for the emulator answering the program's own
   * questions — bytes for the pty and nothing for the record. See
   * `PtySession.write`.
   */
  write(terminalId: string, data: string, byHand = true): void {
    const session = this.require(terminalId)
    const before = session.snapshot()
    const wasUntouched = !session.wasTypedInto
    session.write(data, byHand)
    // The first keystroke a pane ever gets is the moment its agent can have a
    // conversation worth resuming, and the next launch has to know. Written
    // once per pane rather than once per keystroke: this runs on the typing
    // path, and the store persists on every put.
    if (byHand && wasUntouched) this.rememberTyped(terminalId)
    const after = session.snapshot()
    if (before.restored !== after.restored || before.lastBellAt !== after.lastBellAt) {
      for (const listener of this.answeredListeners) listener(terminalId)
    }
  }

  /**
   * Renames a pane, or clears the name when given null.
   *
   * Written to the record in the same call, not on the next checkpoint: a name
   * is typed once and is the kind of thing whose loss to a crash would be
   * noticed, and there is no other moment at which anything knows it changed.
   */
  rename(terminalId: string, label: string | null): Terminal {
    const session = this.require(terminalId)
    session.rename(label)
    const snapshot = session.snapshot()
    const stored = this.records.listTerminals().find((record) => record.id === terminalId)
    if (stored !== undefined) {
      const next: TerminalRecord = { ...stored }
      if (snapshot.label === undefined) delete next.label
      else next.label = snapshot.label
      this.records.putTerminal(next)
    }
    return snapshot
  }

  resize(terminalId: string, cols: number, rows: number): Terminal {
    const session = this.require(terminalId)
    session.resize(cols, rows)
    return session.snapshot()
  }

  read(terminalId: string, tailBytes?: number): string {
    return this.require(terminalId).read(tailBytes)
  }

  /**
   * Closes a terminal: the process tree dies, the pane is removed from the tree,
   * and every stream is ended. The terminal is gone from list() afterwards.
   */
  async close(terminalId: string): Promise<void> {
    const session = this.require(terminalId)
    this.sessions.delete(terminalId)
    // Closing a pane is the user saying they are done with it, so the record
    // goes too: a restart must not bring back what was deliberately shut.
    this.forget(terminalId)
    this.endStreamsFor(terminalId)

    const layout = this.layoutFor(session.worktreeId)
    const root = removePane(layout.root, terminalId)
    this.saveLayout({
      worktreeId: session.worktreeId,
      root,
      focusedTerminalId:
        layout.focusedTerminalId === terminalId ? (terminalIdsIn(root)[0] ?? null) : layout.focusedTerminalId
    })

    await session.close()
  }

  /**
   * Streams a terminal's data, exit and title events into `channel` until the
   * returned teardown runs or the terminal closes, whichever comes first. This
   * is the primitive the runtime's subscription hub plugs into; subscribe() is
   * the same thing with ids kept here instead.
   */
  attachStream(terminalId: string, channel: StreamChannel): () => void {
    const session = this.require(terminalId)
    const streams = this.streamsFor(terminalId)
    const stream: AttachedStream = { channel, detach: session.on((event) => channel.emit(event)) }
    streams.add(stream)

    // Through the stream rather than through the listener this attached: a pane
    // run again swaps the session underneath and rewrites `detach`, and a
    // teardown holding the old one would unhook nothing.
    return () => {
      stream.detach()
      streams.delete(stream)
    }
  }

  /**
   * Reports every pane's exit, whichever call opened the pane — or no call at
   * all, for the ones restoreSessions() brings back.
   *
   * Hung off the session rather than off the handler that created it on
   * purpose: restored panes are started before any handler exists to wrap, so a
   * watcher attached at create time covers only this run's panes and a pane
   * that came back from the last launch would die unannounced. A restored pane
   * and a fresh one have to be indistinguishable to every client.
   */
  onTerminalExit(listener: TerminalExitListener): () => void {
    this.exitListeners.add(listener)
    return () => {
      this.exitListeners.delete(listener)
    }
  }

  /**
   * Called when somebody typing into a pane changed something every client
   * holds: the restored badge is gone, or the bell has been answered. Never for
   * the emulator's own replies, which change neither. See `write`.
   */
  onPaneAnswered(listener: PaneAnsweredListener): () => void {
    this.answeredListeners.add(listener)
    return () => {
      this.answeredListeners.delete(listener)
    }
  }

  /** Opens a stream this manager keeps the id for, delivered via `publish`. */
  subscribe(terminalId: string): string {
    const id = `sub_${this.nextId()}`
    const publish = this.options.publish
    const detach = this.attachStream(terminalId, {
      emit: (event) => publish?.(id, event),
      close: () => {
        this.ownSubscriptions.delete(id)
      }
    })
    this.ownSubscriptions.set(id, { terminalId, end: detach })
    return id
  }

  /** False when the subscription was already gone, e.g. its terminal closed. */
  unsubscribe(subscription: string): boolean {
    const existing = this.ownSubscriptions.get(subscription)
    if (!existing) return false
    existing.end()
    this.ownSubscriptions.delete(subscription)
    return true
  }

  layoutGet(worktreeId: string): Layout {
    return this.layoutFor(worktreeId)
  }

  /**
   * Brings back the terminals of the last run, before layouts are reconciled.
   *
   * Each record keeps its own terminal id, so the stored pane trees still point
   * at the terminals they always did and no layout has to be rewritten. What
   * comes back is not the old process — that died with the app — but a shell in
   * the same worktree, and for an agent pane, the same conversation resumed.
   *
   * A worktree that has gone takes its terminals with it, and anything that
   * fails to start is simply left out; the reconciliation that follows drops
   * the panes pointing at whatever did not come back.
   *
   * Returns how many terminals were restored, and how many of those resumed a
   * conversation rather than opening a fresh shell.
   */
  restoreSessions(): { restored: number; resumed: number } {
    const stored = this.records.listTerminals()
    const worktreeCwd = (worktreeId: string): string | undefined => this.options.resolveWorktreeCwd?.(worktreeId)
    const records = restorableRecords(stored, (worktreeId) => {
      const cwd = worktreeCwd(worktreeId)
      return cwd !== undefined && cwd.length > 0 && isDirectory(cwd)
    })

    // A record whose worktree the workspace no longer has is not coming back
    // on a later start either, and left here it stays in the workspace file
    // for the life of the installation — a set of them per worktree ever
    // removed. A worktree that is still recorded but whose checkout is not
    // there is a different thing entirely: a volume not mounted, a directory
    // moved back tomorrow. That one is left out of this restore and left
    // alone, because one bad start is no reason to throw a pane away.
    for (const record of stored) {
      const cwd = worktreeCwd(record.worktreeId)
      if (cwd === undefined || cwd.length === 0) this.forget(record.id)
    }

    let restored = 0
    let resumed = 0
    for (const record of records) {
      if (this.sessions.has(record.id)) continue
      const launch = restoreLaunch(record, this.options.conversationEvidence)
      // A pane that resumes a conversation is about to print that conversation
      // itself, from the agent's own store, so replaying a transcript into it
      // would show the same exchange twice — once as a record of what the agent
      // said and once as the agent saying it.
      //
      // Which is why the record is handed over either way and held rather than
      // dropped: "about to print it" is a bet on a command that has not run
      // yet, and this one archive entry is the only copy of what the pane
      // printed before the restart. Betting it used to lose it outright — a
      // resume that failed left the pane holding a one-line refusal, and the
      // next quit wrote *that* back over the transcript. PtySession shows what
      // it is holding if the resume turns out not to have taken.
      const kept = this.scrollback?.read(record.id)
      // A pane starting its agent over has pinned a new id, and the record has
      // to say so: the old id names nothing, and leaving it there is asking for
      // the same failed resume on every launch from here on.
      const restoring: TerminalRecord =
        launch.repinned === undefined
          ? record
          : {
              ...record,
              command: launch.repinned.command,
              agentSessionId: launch.repinned.agentSessionId,
              // Nobody has typed into this pane yet, and the fresh conversation
              // it is opening is no more resumable than the last one until they
              // do.
              typed: false
            }
      try {
        this.startSession(
          {
            worktreeId: record.worktreeId,
            cwd: record.cwd,
            shell: record.shell,
            cols: record.cols,
            rows: record.rows,
            ...(launch.command === undefined ? {} : { command: launch.command }),
            ...(kept === undefined ? {} : { restoredRecord: kept }),
            // A pane starting its agent over was never spoken to, so its task
            // goes with it again; a resume is a conversation already told.
            ...(launch.repinned === undefined ? {} : this.taskFor(record)),
            // Only where a conversation is being asked for. Everything else
            // here either is the fresh start already or is a plain shell, and
            // neither has anything to fall back from.
            ...(launch.resumed && launch.fallback !== undefined ? { fallback: launch.fallback } : {}),
            // Said in the pane before anything starts in it, where this launch
            // is not the one the record asked for and nothing else would say so.
            ...(launch.note === undefined ? {} : { startupNote: launch.note })
          },
          restoring,
          // Three answers, not two: a pane whose agent was started over is
          // running that agent, and the banner under its record says so.
          // Calling it a shell was the badge contradicting the banner.
          launch.resumed ? 'agent' : launch.repinned === undefined ? 'shell' : 'restarted'
        )
        restored += 1
        if (launch.resumed) resumed += 1
      } catch {
        // One terminal that cannot start — a shell that is gone, a directory
        // that moved — must not cost the others their restore.
        this.forget(record.id)
      }
    }
    return { restored, resumed }
  }

  /**
   * Drops pane leaves whose terminal no longer exists. Layouts are durable but
   * terminals are not, so every stored layout is stale the moment the app
   * restarts; without this the UI renders panes bound to dead ids.
   * Returns the number of layouts it had to change.
   */
  reconcileLayouts(): number {
    const stored = this.layouts.listLayouts?.()
    if (!stored) return 0

    let changed = 0
    for (const layout of stored) {
      const orphans = terminalIdsIn(layout.root).filter((id) => !this.sessions.has(id))
      if (orphans.length === 0) continue

      let root = layout.root
      for (const orphan of orphans) root = removePane(root, orphan)

      const focus = layout.focusedTerminalId
      this.layouts.putLayout({
        worktreeId: layout.worktreeId,
        root,
        focusedTerminalId: focus !== null && this.sessions.has(focus) ? focus : null
      })
      changed += 1
    }
    return changed
  }

  /** Replaces a worktree's tree wholesale, e.g. after a drag-resize or restore. */
  layoutSet(params: ParamsOf<'layout.set'>): Layout {
    let root: PaneNode | null = null
    if (params.root !== null && params.root !== undefined) {
      root = parsePaneNode(params.root)
      if (root === null) throw invalidParams('root is not a valid pane tree')
    }

    const focus = params.focusedTerminalId
    return this.saveLayout({
      worktreeId: params.worktreeId,
      root,
      // Focus has to name a pane that exists, or the renderer focuses nothing.
      focusedTerminalId: focus !== null && terminalIdsIn(root).includes(focus) ? focus : null
    })
  }

  /** Kills every PTY. Call from the app's before-quit path. */
  async shutdown(): Promise<void> {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    for (const terminalId of [...this.streams.keys()]) this.endStreamsFor(terminalId)
    this.ownSubscriptions.clear()
    await Promise.all(sessions.map((session) => session.close()))

    // After the closes, and before the writes below. A pty being torn down
    // drains what the child had written and not yet delivered, and that output
    // arms a checkpoint like any other; left armed it would fire against an
    // archive that has already been flushed and a process that is leaving.
    // What it would have written is written here instead, in full.
    this.checkpoints?.cancelAll()

    // After the closes, not before them: closing a pty drains whatever the
    // child had written and not yet delivered — see `pty-tail.ts` — and the
    // last thing a command printed is the part somebody comes back for.
    if (this.scrollback !== undefined) {
      for (const session of sessions) this.scrollback.put(session.id, session.recordedOutput())
      await this.scrollback.flush()
    }
  }

  private startSession(
    params: ParamsOf<'terminal.create'> & {
      restoredRecord?: RecordedScrollback
      /** What this pane runs instead if the resume it is being given is refused. */
      fallback?: { command: string; agentSessionId?: string }
      recordStartsBelow?: string
      /** A line the pane prints before its command, saying why this is not a resume. */
      startupNote?: string
    },
    restoring?: TerminalRecord,
    restored?: RestoredAs
  ): PtySession {
    const cwd = params.cwd ?? this.options.resolveWorktreeCwd?.(params.worktreeId)
    if (cwd === undefined || cwd.length === 0) {
      throw invalidParams(`no cwd for worktree ${params.worktreeId}`)
    }
    if (!isDirectory(cwd)) throw notFound(`cwd is not a directory: ${cwd}`)

    const shell = params.shell ?? resolveLoginShell()
    // A command that launches a known agent gets a session id chosen now, so
    // the next launch has something to resume rather than something to guess.
    // A restore arrives with its command already settled and must not be
    // rewritten again.
    //
    // The caller's own arguments go on first, so everything `agent-command.ts`
    // decides — where the selector goes, and whether the line can be touched at
    // all — is decided about the line that will actually run. See
    // `src/shared/agentLaunch.ts`. A restore skips this too: the arguments are
    // already in the command that was written down.
    const launch = restoring
      ? { command: params.command }
      : pinAgentSession(params.command === undefined ? undefined : agentLaunchCommand(params.command, params.agentArgs))
    const agent = restoring?.agent ?? launch.agent
    // The prompt goes on the line that runs and nowhere else. The record below
    // keeps `launch.command`, which is what a resume is rewritten from, and a
    // conversation being resumed has already been given this.
    const spawned =
      launch.command !== undefined && agent !== undefined && params.prompt !== undefined
        ? firstPromptCommand(launch.command, agent, params.prompt)
        : launch.command
    const fallback = params.fallback
    // The record's name wins on a restore: it is the one the user has been
    // looking at, and the caller of a restore passes no name at all.
    const label = restoring?.label ?? params.label

    const session = PtySession.start({
      id: restoring?.id ?? `term_${this.nextId()}`,
      worktreeId: params.worktreeId,
      cwd,
      shell,
      ...(spawned === undefined ? {} : { command: spawned }),
      cols: params.cols ?? DEFAULT_COLS,
      rows: params.rows ?? DEFAULT_ROWS,
      ...(restored === undefined ? {} : { restored }),
      ...(params.restoredRecord === undefined ? {} : { restoredRecord: params.restoredRecord }),
      ...(params.recordStartsBelow === undefined ? {} : { recordStartsBelow: params.recordStartsBelow }),
      ...(params.startupNote === undefined ? {} : { startupNote: params.startupNote }),
      ...(agent === undefined ? {} : { agent }),
      ...(fallback === undefined
        ? {}
        : {
            restartCommand: fallback.command,
            // The pane has stopped being the one the record describes: it is
            // running a new agent under a new id, and nobody has said anything
            // to that one yet. Written here rather than on the next launch,
            // because the next launch is exactly what this is trying to spare
            // the pane — a record still naming the conversation that has just
            // been refused would ask for it again, and be refused again.
            onRestart: (started: PtySession) => this.rememberRestart(started.id, fallback)
          }),
      ...(label === undefined ? {} : { label }),
      ...(this.options.onActivityChange === undefined && this.options.onAgentSettled === undefined
        ? {}
        : {
            onActivityChange: (session: PtySession) => {
              this.options.onActivityChange?.(session.id)
              // The quiet half of the edge only, and not the one an exit
              // produces: `settleExit` reports the same edge on its way past,
              // and the exit below is the better of the two to announce.
              if (!session.isBusy && session.isRunning) this.reportSettled(session, 'quiet')
            }
          }),
      ...(this.options.scrollbackCapBytes === undefined ? {} : { scrollbackCapBytes: this.options.scrollbackCapBytes })
    })

    this.sessions.set(session.id, session)
    if (restored !== undefined) this.resuming.add(session.id)
    this.watchSession(session)
    const snapshot = session.snapshot()
    this.records.putTerminal({
      id: session.id,
      worktreeId: session.worktreeId,
      cwd,
      shell,
      // The record keeps the *original* launch of an agent, not the resume
      // form: the pinned id is what identifies the conversation, and rewriting
      // the record on every restart would stack one selector on the next.
      ...(restoring?.command === undefined
        ? launch.command === undefined
          ? {}
          : { command: launch.command }
        : { command: restoring.command }),
      ...((restoring?.agent ?? launch.agent) ? { agent: restoring?.agent ?? launch.agent } : {}),
      ...(label === undefined ? {} : { label }),
      ...((restoring?.agentSessionId ?? launch.agentSessionId)
        ? { agentSessionId: restoring?.agentSessionId ?? launch.agentSessionId }
        : {}),
      // A pane this version opens says so either way, because it is in a
      // position to: nobody has typed into a pane that was created a moment
      // ago, and `false` is a fact about it rather than an absence of one.
      //
      // A pane being restored carries whatever its record said, absence
      // included, and absence is not turned into `false` here. This runs before
      // the resume it is restoring has had a chance to work or fail, and a
      // record written before this field existed is a record that may well have
      // a real conversation behind it — writing `false` over it on the way past
      // would take the resume away on the launch after that, from a pane that
      // had just resumed perfectly. What answers the unknown is the outcome,
      // written by `markNotResumable` when the agent refuses.
      ...(restoring === undefined ? { typed: false } : restoring.typed === undefined ? {} : { typed: restoring.typed }),
      cols: snapshot.cols,
      rows: snapshot.rows,
      createdAt: restoring?.createdAt ?? Date.now()
    })
    return session
  }

  /** `{ prompt }` for a pane whose worktree has a task, else nothing. */
  private taskFor(record: TerminalRecord): { prompt?: string } {
    const task = this.options.resolveWorktreeTask?.(record.worktreeId)
    return task === undefined || task.length === 0 ? {} : { prompt: task }
  }

  /**
   * The worktree's task, for a pane that never got a conversation.
   *
   * The same question `restoreLaunch` asks, answered the same way: the agent's
   * own store first, and what the window saw typed only where the store cannot
   * be read.
   */
  private taskToRepeat(record: TerminalRecord): string | undefined {
    if (record.agent === undefined) return undefined
    const evidence = (this.options.conversationEvidence ?? conversationOnDisk)({
      agent: record.agent,
      cwd: record.cwd,
      ...(record.agentSessionId === undefined ? {} : { agentSessionId: record.agentSessionId })
    })
    const never = evidence === 'absent' || (evidence === 'unknown' && record.typed === false)
    return never ? this.taskFor(record).prompt : undefined
  }

  /**
   * Hands on a pane that has stopped, when it is a pane worth reporting.
   *
   * Every filter is here rather than in the caller so that both edges — quiet
   * and exit — are answered by one rule: an agent, and only an agent.
   */
  private reportSettled(session: PtySession, reason: 'quiet' | 'exit'): void {
    // First, so a pane leaves that set on its first edge whether or not anybody
    // is listening to these at all.
    const resuming = this.resuming.delete(session.id)
    const settled = this.options.onAgentSettled
    const agent = session.agent
    if (settled === undefined || agent === undefined) return
    // The resume finishing is not work finishing; see `resuming`. An exit still
    // is, because an agent that will not resume says so and leaves, and that is
    // worth hearing about.
    if (resuming && reason === 'quiet') return
    settled({
      terminalId: session.id,
      worktreeId: session.worktreeId,
      agent,
      reason,
      line: evidenceLine(session.read(SETTLED_TAIL_BYTES))
    })
  }

  /**
   * Drops everything this launch keeps about a terminal.
   *
   * The pane's record and the pane's transcript go together, always, and from
   * one place so they cannot drift apart: a pane the user closed must not come
   * back, and what it printed must not outlive it on disk. Both are keyed to
   * the terminal id and dropped with it, which is the same arrangement the
   * workspace file describes for mutes and standing permissions, and it is what
   * leaves nothing anywhere needing to be swept.
   *
   * The pending checkpoint goes first and for the same reason. A checkpoint
   * armed by the pane's last chunk of output would otherwise fire after the
   * removal below and write the file back, which is a closed pane's transcript
   * sitting in the directory until something else sweeps it — and a pane the
   * user deliberately shut coming back with output on the next launch.
   */
  private forget(terminalId: string): void {
    this.resuming.delete(terminalId)
    this.checkpoints?.cancel(terminalId)
    this.records.removeTerminal(terminalId)
    this.scrollback?.remove(terminalId)
  }

  /**
   * Writes down that somebody has typed into this pane.
   *
   * Only the agent panes need it, but it is recorded for all of them: a pane
   * can become an agent pane at any moment by somebody typing the agent's name
   * into a shell, and a flag that is only true for panes we happened to launch
   * as agents would be a flag that lies about the others.
   */
  private rememberTyped(terminalId: string): void {
    const stored = this.records.listTerminals().find((record) => record.id === terminalId)
    if (stored === undefined || stored.typed === true) return
    this.records.putTerminal({ ...stored, typed: true })
  }

  /**
   * Writes down that this pane has no conversation to come back to.
   *
   * The same field as above with the opposite answer, and it means the same
   * thing in both directions: whether asking this pane's agent to resume is
   * worth doing. A pane that was just refused has had that question answered
   * for it, and answering it once is the difference between a pane that comes
   * back working on the next launch and a pane that reproduces the same failure
   * every time the app starts, forever.
   */
  /**
   * Writes down that this pane is running a different agent than the one it was
   * brought back for.
   *
   * The resume was refused, so the conversation the record names is not there;
   * the pane has started a fresh agent under an id of its own, and the record
   * has to name that one instead. Both halves matter. Leaving the old id would
   * ask for the same missing conversation on every launch from here on, and
   * leaving `typed` alone would let the next launch resume an id nobody has
   * said anything to yet — which is the same refusal again, one launch later.
   */
  private rememberRestart(terminalId: string, restart: { command: string; agentSessionId?: string }): void {
    const stored = this.records.listTerminals().find((record) => record.id === terminalId)
    if (stored === undefined) return
    const next: TerminalRecord = { ...stored, command: restart.command, typed: false }
    // Deleted rather than overwritten when the agent mints its own ids: what is
    // recorded has to be an id this app actually pinned, and an absent one is
    // how the restore already says "ask this agent for the last session here".
    if (restart.agentSessionId === undefined) delete next.agentSessionId
    else next.agentSessionId = restart.agentSessionId
    this.records.putTerminal(next)
  }

  private markNotResumable(terminalId: string): void {
    const stored = this.records.listTerminals().find((record) => record.id === terminalId)
    if (stored === undefined || stored.typed === false) return
    this.records.putTerminal({ ...stored, typed: false })
  }

  private require(terminalId: string): PtySession {
    const session = this.sessions.get(terminalId)
    if (!session) throw notFound(`no such terminal: ${terminalId}`)
    return session
  }

  private layoutFor(worktreeId: string): Layout {
    const stored = this.layouts.getLayout(worktreeId)
    return stored ? cloneLayout(stored) : { worktreeId, root: null, focusedTerminalId: null }
  }

  /** Stored and returned as copies: nothing outside can mutate a live layout. */
  private saveLayout(layout: Layout): Layout {
    return cloneLayout(this.layouts.putLayout(cloneLayout(layout)))
  }

  /**
   * The manager's own subscription to a pane: what it printed, and that it
   * ended.
   *
   * One listener for both, because this runs on the PTY's data path — every
   * chunk every pane prints passes through here — and the work it does per
   * chunk has to stay at the level of a map lookup. Arming a checkpoint is that
   * cheap by construction; see `scrollbackCheckpoints.ts`.
   */
  private watchSession(session: PtySession): void {
    let detach = (): void => {}
    detach = session.on((event) => {
      if (event.type === 'data') {
        this.checkpoints?.note(session.id)
        return
      }
      if (event.type !== 'exit') return
      detach()
      // Nothing more will be printed, so the checkpoint that was armed by the
      // last chunk has nothing left to add and the write below is final.
      this.checkpoints?.cancel(session.id)
      // A pane already out of the registry was closed or shut down on purpose:
      // that removal is what a client was told about, and an exit event for a
      // terminal it can no longer list would be news about nothing.
      if (this.sessions.get(session.id) !== session) return
      // A resume that did not take is worth writing down, and this is the only
      // moment anything knows it. Without it the pane asks the same agent for
      // the same missing conversation on every launch for the rest of the
      // record's life, gets the same refusal, and stacks another copy of the
      // explanation into its own record each time — the failure made durable
      // rather than handled. Recorded as "nobody typed into this pane", which
      // is not a guess but the thing that has just been demonstrated: the
      // conversation this pane was for is not there, so the next launch starts
      // the agent over exactly as it does for a pane that never had one.
      if (session.resumeDidNotTake) this.markNotResumable(session.id)
      // A pane whose process has ended appends nothing more, so this is the
      // moment its output is final and the only one at which a record of it can
      // be complete. The other two writes bound how much a pane that is still
      // running can lose; this one is the pane that has finished, written in
      // full and never written again.
      this.scrollback?.put(session.id, session.recordedOutput())
      this.reportSettled(session, 'exit')
      for (const listener of this.exitListeners) listener(session.id, event.exitCode)
    })
  }

  /**
   * Points every stream open on a pane at the session now running in it.
   *
   * A subscription is to the pane and not to the process behind it: the window
   * opens one when it mounts and holds it for as long as the pane is on screen,
   * and a teammate watching holds another. Left attached to the session that
   * ended, every one of them would be a live subscription to something that
   * will never say anything again.
   */
  private rebindStreams(session: PtySession): void {
    for (const stream of this.streamsFor(session.id)) {
      stream.detach()
      stream.detach = session.on((event) => stream.channel.emit(event))
    }
  }

  private streamsFor(terminalId: string): Set<AttachedStream> {
    const existing = this.streams.get(terminalId)
    if (existing) return existing
    const created = new Set<AttachedStream>()
    this.streams.set(terminalId, created)
    return created
  }

  private endStreamsFor(terminalId: string): void {
    const streams = this.streams.get(terminalId)
    this.streams.delete(terminalId)
    if (!streams) return
    for (const stream of streams) {
      stream.detach()
      // Tells the subscriber's owner (the hub, or subscribe() above) it is over.
      stream.channel.close()
    }
  }

  private nextId(): string {
    return this.options.createId?.() ?? randomUUID()
  }
}

class InMemoryLayoutRepository implements LayoutRepository {
  private readonly layouts = new Map<string, Layout>()

  getLayout(worktreeId: string): Layout | undefined {
    return this.layouts.get(worktreeId)
  }

  putLayout(layout: Layout): Layout {
    this.layouts.set(layout.worktreeId, layout)
    return layout
  }
}

/**
 * Gives an agent command a session id we can resume later.
 *
 * Only the agents that let a caller choose their id get one; the rest mint
 * their own, and the record simply remembers which agent it was so the restore
 * can ask for that agent's most recent session in this directory instead.
 */
function pinAgentSession(command: string | undefined): {
  command?: string
  agent?: AgentKind
  agentSessionId?: string
} {
  if (command === undefined) return {}
  const agent = detectAgent(command)
  if (agent === null) return { command }
  if (!pinsOwnSessionId(agent)) return { command, agent }

  const agentSessionId = newSessionId()
  const pinned = pinSessionCommand(command, agent, agentSessionId)
  // The command came back untouched, which means it already named a session of
  // its own. That choice is the caller's, so nothing is recorded to override it.
  if (pinned === command) return { command, agent }
  return { command: pinned, agent, agentSessionId }
}

/**
 * What a pane runs when it is run again.
 *
 * The same refusal `restoreLaunch` makes, reached from the same direction: a
 * command that is not an agent's is not re-issued, because a pane left holding
 * `npm run deploy` was not asking for it twice, and a shell in the right
 * directory is both useful and honest. An agent's command is re-issued with
 * every session selector cut out and a fresh id pinned in — `restartSessionCommand`,
 * which is already what a never-typed pane comes back as.
 *
 * A command that cannot be modelled well enough to take the old session out of
 * it answers as a shell too: re-issuing it would leave a dead id on the line
 * and write a different one into the record, and the two would disagree from
 * there on with nothing ever noticing.
 */
function relaunchCommand(record: TerminalRecord | undefined): {
  command?: string
  agent?: AgentKind
  agentSessionId?: string
} {
  if (record?.command === undefined || record.agent === undefined) return {}
  const restart = restartSessionCommand(record.command, record.agent)
  if (restart === null) return {}
  return {
    command: restart.command,
    agent: record.agent,
    ...(restart.agentSessionId === undefined ? {} : { agentSessionId: restart.agentSessionId })
  }
}

/** Records nothing worth keeping: an in-memory manager has no next launch. */
class InMemorySessionRepository implements SessionRepository {
  private readonly records = new Map<string, TerminalRecord>()

  listTerminals(): TerminalRecord[] {
    return [...this.records.values()]
  }

  putTerminal(record: TerminalRecord): TerminalRecord {
    this.records.set(record.id, record)
    return record
  }

  removeTerminal(terminalId: string): boolean {
    return this.records.delete(terminalId)
  }
}

function cloneLayout(layout: Layout): Layout {
  return {
    worktreeId: layout.worktreeId,
    root: layout.root === null ? null : structuredClone(layout.root),
    focusedTerminalId: layout.focusedTerminalId
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
