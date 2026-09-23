// The registry behind every terminal.* and layout.* method: live sessions, the
// pane tree per worktree, and the streams attached to each terminal.

import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { agentLaunchCommand } from '../../shared/agentLaunch'
import type { RestoredAs } from '../../shared/paneRestore'
import type { AgentEvent, Layout, PaneNode, Terminal } from '../../shared/entities'
import { fileLeavesIn } from '../../shared/filePane'
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
import {
  hookSettings,
  hookSettingsPath,
  hookedLaunch,
  removeHookSettings,
  writeHookSettings,
  type AgentHookOptions
} from './agent-hooks'
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

/** One subscriber's end of a terminal's event stream; the hub's shape, so no adapter. */
export type StreamChannel = {
  emit: (event: TerminalEvent) => void
  /** Ends the subscription from this side: the terminal is gone. */
  close: () => void
}

/** Where layouts live. Default is in memory; the workspace store survives a restart. */
export type LayoutRepository = {
  getLayout(worktreeId: string): Layout | undefined
  putLayout(layout: Layout): Layout
  /** Needed to reconcile stored layouts at startup; in-memory repos can omit it. */
  listLayouts?(): Layout[]
}

/** Where terminal records live between launches. */
export type SessionRepository = {
  listTerminals(): TerminalRecord[]
  putTerminal(record: TerminalRecord): TerminalRecord
  removeTerminal(terminalId: string): boolean
}

/**
 * Where a pane's output lives between launches — not the workspace file, which
 * holds the record: a transcript is orders of magnitude larger. See `scrollbackArchive.ts`.
 */
export type ScrollbackRepository = {
  read(terminalId: string): RecordedScrollback | undefined
  put(terminalId: string, text: string): void
  remove(terminalId: string): void
  flush(): Promise<void>
}

export type TerminalSessionManagerOptions = {
  /** Where a terminal starts when terminal.create omits `cwd`: the worktree's checkout. */
  resolveWorktreeCwd?: (worktreeId: string) => string | undefined
  /** `Worktree.task`, told again to a pane starting its agent over with no conversation behind it. */
  resolveWorktreeTask?: (worktreeId: string) => string | undefined
  layouts?: LayoutRepository
  /** Pass the workspace store and terminals come back after a restart. */
  sessions?: SessionRepository
  /** Pass an archive and they come back showing what they last printed. */
  scrollback?: ScrollbackRepository
  /** How long after a running pane's output its record is checkpointed; tests shorten it. */
  checkpointIntervalMs?: number
  /** Delivers events for subscriptions opened through subscribe(); attachStream() ignores it. */
  publish?: (subscription: string, event: TerminalEvent) => void
  scrollbackCapBytes?: number
  /** Overridable so tests can assert on readable ids. */
  createId?: () => string
  /** Called when a pane starts or stops producing output; the manager stays unaware of the workspace stream. */
  onActivityChange?: (terminalId: string) => void
  /**
   * Called when an agent pane goes quiet or exits — the half of an edge worth
   * interrupting somebody for. A shell is never reported: quiet is its prompt.
   */
  onAgentSettled?: (settled: AgentSettled) => void
  /** Where each agent pane's hook settings go (see `agent-hooks.ts`); absent, panes are read off the pty. */
  agentHooks?: AgentHookOptions
  /** Whether a restored pane's conversation is on this disk; tests point it at a store they built. */
  conversationEvidence?: (question: ConversationQuestion) => ConversationEvidence
}

/**
 * An agent pane that has stopped. The line is read at the moment of the edge:
 * a second later the pane may have printed a prompt.
 */
export type AgentSettled = {
  terminalId: string
  worktreeId: string
  agent: AgentKind
  reason: 'quiet' | 'exit'
  /** The pane's last line worth quoting, or null when there is not one. */
  line: string | null
}

/** Tail read for a line worth quoting: the sidebar's evidence budget. */
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
   * Restored panes that have not gone quiet yet: a replayed conversation stopping
   * looks like work finishing and is not. The id leaves on that first edge.
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
    // Only with somewhere to write: no archive, no timer.
    const archive = options.scrollback
    this.checkpoints =
      archive === undefined
        ? undefined
        : new ScrollbackCheckpoints({
            // A pane closed since the checkpoint was armed answers nothing.
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

  /** Each running pane's pty child, for `system.resources`; an exited pid may be somebody else's by now. */
  paneProcesses(): { terminalId: string; worktreeId: string; pid: number }[] {
    return [...this.sessions.values()]
      .filter((session) => session.isRunning)
      .map((session) => ({ terminalId: session.id, worktreeId: session.worktreeId, pid: session.pid }))
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
    const target = this.sessions.get(params.terminalId)
    const command = params.command === undefined ? {} : { command: params.command }
    // Beside a file pane there is no session to copy: the shell opens in the
    // worktree at the runtime's default size.
    const session = target
      ? this.startSession({
          worktreeId: target.worktreeId,
          shell: target.shell,
          cwd: target.cwd,
          cols: target.snapshot().cols,
          rows: target.snapshot().rows,
          ...command
        })
      : this.startSession({ worktreeId: this.worktreeOfPane(params.terminalId), ...command })

    const layout = this.layoutFor(session.worktreeId)
    const saved = this.saveLayout({
      worktreeId: session.worktreeId,
      root: splitPane(layout.root, params.terminalId, params.direction, session.id),
      focusedTerminalId: session.id
    })
    return { terminal: session.snapshot(), layout: saved }
  }

  /** The worktree whose tree holds a pane that is not a session, or not found. */
  private worktreeOfPane(paneId: string): string {
    const holder = this.layouts.listLayouts?.().find((layout) => terminalIdsIn(layout.root).includes(paneId))
    if (holder === undefined) throw notFound(`no such terminal: ${paneId}`)
    return holder.worktreeId
  }

  /**
   * Runs an exited pane's program again in the same pane: same terminal id and
   * streams, the dead pane's output kept as this session's record. Not a resume —
   * the agent starts over under a fresh id. Refused while `running`, which stays
   * true while a reaped pane's last output is still arriving.
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
    // Told its task again only when nobody ever told it anything.
    const prompt = stored !== undefined && launch.agent !== undefined ? this.taskToRepeat(stored) : undefined

    // Read before teardown: the only copy of what the pane printed. Sanitised
    // because nothing replayed into a live emulator may do anything but print.
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
      // The name is the person's, not the replaced process's.
      ...(size.label === undefined ? {} : { label: size.label }),
      typed: false,
      cols: size.cols,
      rows: size.rows,
      createdAt: stored?.createdAt ?? Date.now()
    }

    // Started before the old session is let go of: a failed start must leave
    // the pane as it was, scrollback and all.
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
    // Said as well as written: `read()` builds the line in for views mounting
    // later, but an open view read its snapshot once and will not read again.
    for (const stream of this.streamsFor(session.id)) {
      stream.channel.emit({ type: 'data', data: closingMark(below) })
    }
    return session.snapshot()
  }

  /**
   * Sends bytes to a pane's program and reports the keystroke to anyone who has
   * to redraw: it retires the restored badge and answers the bell, and only this
   * call sees that edge. `byHand` is false for the emulator's own replies. See `PtySession.write`.
   */
  write(terminalId: string, data: string, byHand = true): void {
    const session = this.require(terminalId)
    const before = session.snapshot()
    const wasUntouched = !session.wasTypedInto
    session.write(data, byHand)
    // Written once per pane, not per keystroke: the store persists on every put.
    if (byHand && wasUntouched) this.rememberTyped(terminalId)
    const after = session.snapshot()
    // The agent event is the badge a Claude Code pane actually shows -- it rings
    // no bell -- so leaving it out would clear the badge in one window only.
    if (
      before.restored !== after.restored ||
      before.lastBellAt !== after.lastBellAt ||
      before.agentEvent !== after.agentEvent
    ) {
      for (const listener of this.answeredListeners) listener(terminalId)
    }
  }

  /** Renames a pane, or clears the name when given null. Written to the record now, not on the next checkpoint. */
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

  /** What the agent's hook just reported. Not written to the record: the next launch starts a new process. */
  agentEvent(terminalId: string, event: AgentEvent): Terminal {
    const session = this.require(terminalId)
    session.noteAgentEvent(event)
    return session.snapshot()
  }

  read(terminalId: string, tailBytes?: number): string {
    return this.require(terminalId).read(tailBytes)
  }

  /** Closes a terminal: process tree, pane leaf, streams and record all go. */
  async close(terminalId: string): Promise<void> {
    const session = this.require(terminalId)
    this.sessions.delete(terminalId)
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

  /** Streams a terminal's events into `channel` until the teardown runs or the terminal closes. */
  attachStream(terminalId: string, channel: StreamChannel): () => void {
    const session = this.require(terminalId)
    const streams = this.streamsFor(terminalId)
    const stream: AttachedStream = { channel, detach: session.on((event) => channel.emit(event)) }
    streams.add(stream)

    // Through the stream, not the listener: a relaunch rewrites `detach`.
    return () => {
      stream.detach()
      streams.delete(stream)
    }
  }

  /**
   * Reports every pane's exit, restored panes included: those start before any
   * handler exists to wrap, so a watcher attached at create time would miss them.
   */
  onTerminalExit(listener: TerminalExitListener): () => void {
    this.exitListeners.add(listener)
    return () => {
      this.exitListeners.delete(listener)
    }
  }

  /** Called when typing retired the restored badge or answered the bell. See `write`. */
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
   * Brings back the last run's terminals under their old ids, so stored pane
   * trees still point at them. Returns how many restored and how many resumed a conversation.
   */
  restoreSessions(): { restored: number; resumed: number } {
    const stored = this.records.listTerminals()
    const worktreeCwd = (worktreeId: string): string | undefined => this.options.resolveWorktreeCwd?.(worktreeId)
    const records = restorableRecords(stored, (worktreeId) => {
      const cwd = worktreeCwd(worktreeId)
      return cwd !== undefined && cwd.length > 0 && isDirectory(cwd)
    })

    // A record whose worktree is gone is forgotten; one whose checkout is merely
    // missing (unmounted volume) is skipped and kept.
    for (const record of stored) {
      const cwd = worktreeCwd(record.worktreeId)
      if (cwd === undefined || cwd.length === 0) this.forget(record.id)
    }

    let restored = 0
    let resumed = 0
    for (const record of records) {
      if (this.sessions.has(record.id)) continue
      const launch = restoreLaunch(record, this.options.conversationEvidence)
      // Handed over even for a resume, which prints the conversation itself:
      // a resume that fails would otherwise leave the pane holding a one-line
      // refusal, and the next quit wrote *that* back over the transcript.
      const kept = this.scrollback?.read(record.id)
      // A repinned id has to reach the record, or every launch asks for the same failed resume.
      const restoring: TerminalRecord =
        launch.repinned === undefined
          ? record
          : {
              ...record,
              command: launch.repinned.command,
              agentSessionId: launch.repinned.agentSessionId,
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
            // A pane starting its agent over was never spoken to, so its task goes with it again.
            ...(launch.repinned === undefined ? {} : this.taskFor(record)),
            ...(launch.resumed && launch.fallback !== undefined ? { fallback: launch.fallback } : {}),
            ...(launch.note === undefined ? {} : { startupNote: launch.note })
          },
          restoring,
          // 'restarted' is running its agent; calling it a shell had the badge contradicting the banner.
          launch.resumed ? 'agent' : launch.repinned === undefined ? 'shell' : 'restarted'
        )
        restored += 1
        if (launch.resumed) resumed += 1
      } catch {
        // One terminal that cannot start must not cost the others their restore.
        this.forget(record.id)
      }
    }
    return { restored, resumed }
  }

  /** Drops pane leaves whose terminal no longer exists; returns how many layouts changed. */
  reconcileLayouts(): number {
    const stored = this.layouts.listLayouts?.()
    if (!stored) return 0

    let changed = 0
    for (const layout of stored) {
      // A file leaf has no session to have died.
      const files = new Set(fileLeavesIn(layout.root).map((leaf) => leaf.terminalId))
      const orphans = terminalIdsIn(layout.root).filter((id) => !this.sessions.has(id) && !files.has(id))
      if (orphans.length === 0) continue

      let root = layout.root
      for (const orphan of orphans) root = removePane(root, orphan)

      const focus = layout.focusedTerminalId
      this.layouts.putLayout({
        worktreeId: layout.worktreeId,
        root,
        focusedTerminalId: focus !== null && terminalIdsIn(root).includes(focus) ? focus : null
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

    // After the closes: tearing a pty down drains undelivered output (see
    // `pty-tail.ts`), which arms a checkpoint that would fire after the flush.
    this.checkpoints?.cancelAll()

    if (this.scrollback !== undefined) {
      for (const session of sessions) this.scrollback.put(session.id, session.recordedOutput())
      await this.scrollback.flush()
    }
  }

  private startSession(
    params: ParamsOf<'terminal.create'> & {
      restoredRecord?: RecordedScrollback
      /** What this pane runs instead if the resume is refused. */
      fallback?: { command: string; agentSessionId?: string }
      recordStartsBelow?: string
      /** Printed before the command, saying why this is not a resume. */
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
    // A known agent gets a session id pinned now, after the caller's arguments
    // go on, so `agent-command.ts` decides about the line that will actually
    // run. A restore's command is already settled and is not rewritten.
    const launch = restoring
      ? { command: params.command }
      : pinAgentSession(params.command === undefined ? undefined : agentLaunchCommand(params.command, params.agentArgs))
    const agent = restoring?.agent ?? launch.agent
    // Minted before the command is final: the hook file's path carries the id.
    const id = restoring?.id ?? `term_${this.nextId()}`
    // After the selector and before the prompt; a restore's command already
    // carries the flag and only the file is written again, under the same name.
    launch.command = this.hookAgentLaunch(launch.command, agent, id)
    // The prompt goes on the line that runs, never in the record.
    const spawned =
      launch.command !== undefined && agent !== undefined && params.prompt !== undefined
        ? firstPromptCommand(launch.command, agent, params.prompt)
        : launch.command
    const fallback = params.fallback
    // The record's name wins on a restore.
    const label = restoring?.label ?? params.label

    const session = PtySession.start({
      id,
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
            // Written now: a record still naming the refused conversation would
            // ask for it again next launch, and be refused again.
            onRestart: (started: PtySession) => this.rememberRestart(started.id, fallback)
          }),
      ...(label === undefined ? {} : { label }),
      ...(this.options.onActivityChange === undefined && this.options.onAgentSettled === undefined
        ? {}
        : {
            onActivityChange: (session: PtySession) => {
              this.options.onActivityChange?.(session.id)
              // The quiet half only; `settleExit` reports the exit edge.
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
      // The record keeps the *original* launch, not the resume form: rewriting
      // it on every restart would stack one selector on the next.
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
      // A restored record's absence is kept, not turned into `false`: a record
      // from before this field existed may have a real conversation behind it.
      // `markNotResumable` answers the unknown when the agent refuses.
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

  /** The worktree's task, for a pane that never got a conversation; asked the way `restoreLaunch` asks. */
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

  /** Hands on a pane that has stopped, when it is an agent; one rule for both edges. */
  private reportSettled(session: PtySession, reason: 'quiet' | 'exit'): void {
    // First, so the pane leaves the set whether or not anybody is listening.
    const resuming = this.resuming.delete(session.id)
    const settled = this.options.onAgentSettled
    const agent = session.agent
    if (settled === undefined || agent === undefined) return
    // The resume finishing is not work finishing; an exit still is.
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
   * Drops everything this launch keeps about a terminal, from one place so record,
   * transcript and hook file cannot drift apart. The pending checkpoint goes
   * first, or it would fire after the removal and write the file back.
   */
  private forget(terminalId: string): void {
    this.resuming.delete(terminalId)
    this.checkpoints?.cancel(terminalId)
    this.records.removeTerminal(terminalId)
    this.scrollback?.remove(terminalId)
    const hooks = this.options.agentHooks
    if (hooks !== undefined) removeHookSettings(hookSettingsPath(hooks.userDataDir, terminalId))
  }

  /**
   * Hands an agent its hook settings. The file is written whenever the command
   * names it, so a restored pane has its file back whether or not the last run left one.
   */
  private hookAgentLaunch(
    command: string | undefined,
    agent: AgentKind | undefined,
    terminalId: string
  ): string | undefined {
    const hooks = this.options.agentHooks
    if (hooks === undefined || command === undefined || agent === undefined) return command
    const file = hookSettingsPath(hooks.userDataDir, terminalId)
    const hooked = hookedLaunch(command, agent, file)
    if (hooked.includes(file)) writeHookSettings(file, hookSettings(hooks, terminalId))
    return hooked
  }

  /** Writes down that somebody has typed into this pane; for every pane, since a shell can become an agent pane. */
  private rememberTyped(terminalId: string): void {
    const stored = this.records.listTerminals().find((record) => record.id === terminalId)
    if (stored === undefined || stored.typed === true) return
    this.records.putTerminal({ ...stored, typed: true })
  }

  /**
   * Writes down that the pane restarted under an id of its own. Both halves
   * matter: the old id would be asked for again, and `typed` left alone would
   * resume an id nobody has spoken to.
   */
  private rememberRestart(terminalId: string, restart: { command: string; agentSessionId?: string }): void {
    const stored = this.records.listTerminals().find((record) => record.id === terminalId)
    if (stored === undefined) return
    const next: TerminalRecord = { ...stored, command: restart.command, typed: false }
    // Deleted when the agent mints its own ids: absent means "ask the agent for the last session here".
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
   * The manager's own subscription to a pane. One listener on the data path,
   * so per-chunk work stays at a map lookup; see `scrollbackCheckpoints.ts`.
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
      // The write below is final; the armed checkpoint has nothing to add.
      this.checkpoints?.cancel(session.id)
      // A pane already out of the registry was closed on purpose; no exit event.
      if (this.sessions.get(session.id) !== session) return
      // The only moment anything knows a resume did not take; unrecorded, the
      // pane asks for the same missing conversation on every launch.
      if (session.resumeDidNotTake) this.markNotResumable(session.id)
      this.scrollback?.put(session.id, session.recordedOutput())
      this.reportSettled(session, 'exit')
      for (const listener of this.exitListeners) listener(session.id, event.exitCode)
    })
  }

  /** Points every stream open on a pane at the session now running in it; a subscription is to the pane. */
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

/** Gives an agent command a session id to resume later, where the agent lets a caller choose one. */
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
  // Untouched means it already named a session of its own; the caller's choice.
  if (pinned === command) return { command, agent }
  return { command: pinned, agent, agentSessionId }
}

/**
 * What a pane runs when it is run again: an agent's command with a fresh id
 * pinned in, else a shell — `npm run deploy` was not asked for twice, and a
 * command that cannot be modelled would leave a dead id on the line.
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
