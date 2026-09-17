// The registry behind every terminal.* and layout.* method.
//
// It owns three things and nothing else: the live sessions, the pane tree per
// worktree, and the streams attached to each terminal. Process behaviour lives
// in PtySession, tree behaviour in pane-tree; this file is the part that has to
// know that closing a pane also removes its leaf and ends its streams.

import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import type { Layout, PaneNode, Terminal } from '../../shared/entities'
import type { ParamsOf, TerminalEvent } from '../../shared/methods'
import { detectAgent, newSessionId, pinSessionCommand, pinsOwnSessionId, type AgentKind } from './agent-command'
import { appendPane, parsePaneNode, removePane, splitPane, terminalIdsIn } from './pane-tree'
import { restorableRecords, restoreLaunch, type TerminalRecord } from './session-restore'
import { CHECKPOINT_SOURCE_BYTES, ScrollbackCheckpoints } from './scrollbackCheckpoints'
import type { RecordedScrollback } from './scrollbackRecord'
import { PtySession } from './pty-session'
import { invalidParams, notFound } from './service-error'
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
}

type AttachedStream = { channel: StreamChannel; detach: () => void }

export type TerminalExitListener = (terminalId: string, exitCode: number) => void

export class TerminalSessionManager {
  private readonly sessions = new Map<string, PtySession>()
  private readonly streams = new Map<string, Set<AttachedStream>>()
  private readonly exitListeners = new Set<TerminalExitListener>()
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
   * Returns true when this write cleared the pane's restored badge, which is
   * the one thing a keystroke changes that anyone else needs to hear about.
   * Reported rather than published here, so the manager stays unaware of the
   * workspace stream.
   */
  write(terminalId: string, data: string): boolean {
    const session = this.require(terminalId)
    const wasRestored = session.snapshot().restored !== undefined
    const wasUntouched = !session.wasTypedInto
    session.write(data)
    // The first keystroke a pane ever gets is the moment its agent can have a
    // conversation worth resuming, and the next launch has to know. Written
    // once per pane rather than once per keystroke: this runs on the typing
    // path, and the store persists on every put.
    if (wasUntouched) this.rememberTyped(terminalId)
    return wasRestored
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
    const unlisten = session.on((event) => channel.emit(event))
    const streams = this.streamsFor(terminalId)
    const stream: AttachedStream = { channel, detach: unlisten }
    streams.add(stream)

    return () => {
      unlisten()
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
      const launch = restoreLaunch(record)
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
            ...(kept === undefined ? {} : { restoredRecord: kept })
          },
          restoring,
          launch.resumed ? 'agent' : 'shell'
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
    params: ParamsOf<'terminal.create'> & { restoredRecord?: RecordedScrollback },
    restoring?: TerminalRecord,
    restored?: 'shell' | 'agent'
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
    const launch = restoring ? { command: params.command } : pinAgentSession(params.command)
    const agent = restoring?.agent ?? launch.agent

    const session = PtySession.start({
      id: restoring?.id ?? `term_${this.nextId()}`,
      worktreeId: params.worktreeId,
      cwd,
      shell,
      ...(launch.command === undefined ? {} : { command: launch.command }),
      cols: params.cols ?? DEFAULT_COLS,
      rows: params.rows ?? DEFAULT_ROWS,
      ...(restored === undefined ? {} : { restored }),
      ...(params.restoredRecord === undefined ? {} : { restoredRecord: params.restoredRecord }),
      ...(agent === undefined ? {} : { agent }),
      ...(this.options.onActivityChange === undefined
        ? {}
        : { onActivityChange: (session: PtySession) => this.options.onActivityChange?.(session.id) }),
      ...(this.options.scrollbackCapBytes === undefined ? {} : { scrollbackCapBytes: this.options.scrollbackCapBytes })
    })

    this.sessions.set(session.id, session)
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
      for (const listener of this.exitListeners) listener(session.id, event.exitCode)
    })
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
