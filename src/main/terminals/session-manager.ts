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

export type TerminalSessionManagerOptions = {
  /**
   * Where a terminal starts when terminal.create omits `cwd`: the worktree's
   * checkout path, which only the worktree service knows.
   */
  resolveWorktreeCwd?: (worktreeId: string) => string | undefined
  layouts?: LayoutRepository
  /** Pass the workspace store and terminals come back after a restart. */
  sessions?: SessionRepository
  /**
   * Delivers events for subscriptions opened through subscribe(). Ignored when
   * the caller attaches streams itself via attachStream().
   */
  publish?: (subscription: string, event: TerminalEvent) => void
  scrollbackCapBytes?: number
  /** Overridable so tests can assert on readable ids. */
  createId?: () => string
}

type AttachedStream = { channel: StreamChannel; detach: () => void }

export class TerminalSessionManager {
  private readonly sessions = new Map<string, PtySession>()
  private readonly streams = new Map<string, Set<AttachedStream>>()
  private readonly ownSubscriptions = new Map<string, { terminalId: string; end: () => void }>()
  private readonly layouts: LayoutRepository
  private readonly records: SessionRepository

  constructor(private readonly options: TerminalSessionManagerOptions = {}) {
    this.layouts = options.layouts ?? new InMemoryLayoutRepository()
    this.records = options.sessions ?? new InMemorySessionRepository()
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
    session.write(data)
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
    this.records.removeTerminal(terminalId)
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
    const records = restorableRecords(this.records.listTerminals(), (worktreeId) => {
      const cwd = this.options.resolveWorktreeCwd?.(worktreeId)
      return cwd !== undefined && cwd.length > 0 && isDirectory(cwd)
    })

    let restored = 0
    let resumed = 0
    for (const record of records) {
      if (this.sessions.has(record.id)) continue
      const launch = restoreLaunch(record)
      try {
        this.startSession(
          {
            worktreeId: record.worktreeId,
            cwd: record.cwd,
            shell: record.shell,
            cols: record.cols,
            rows: record.rows,
            ...(launch.command === undefined ? {} : { command: launch.command })
          },
          record,
          launch.resumed ? 'agent' : 'shell'
        )
        restored += 1
        if (launch.resumed) resumed += 1
      } catch {
        // One terminal that cannot start — a shell that is gone, a directory
        // that moved — must not cost the others their restore.
        this.records.removeTerminal(record.id)
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
  }

  private startSession(
    params: ParamsOf<'terminal.create'>,
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

    const session = PtySession.start({
      id: restoring?.id ?? `term_${this.nextId()}`,
      worktreeId: params.worktreeId,
      cwd,
      shell,
      ...(launch.command === undefined ? {} : { command: launch.command }),
      cols: params.cols ?? DEFAULT_COLS,
      rows: params.rows ?? DEFAULT_ROWS,
      ...(restored === undefined ? {} : { restored }),
      ...(this.options.scrollbackCapBytes === undefined ? {} : { scrollbackCapBytes: this.options.scrollbackCapBytes })
    })

    this.sessions.set(session.id, session)
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
      cols: snapshot.cols,
      rows: snapshot.rows,
      createdAt: restoring?.createdAt ?? Date.now()
    })
    return session
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
