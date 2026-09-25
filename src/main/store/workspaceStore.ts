// Durable workspace state: the projects a user tracks, the worktrees under them,
// and the pane layout per worktree. State is held in memory and mirrored to one
// JSON file; reads are synchronous because handlers answer from memory, and
// writes are coalesced so a burst of mutations costs one rename.

import { rename } from 'node:fs/promises'
import type { Layout, Project, Worktree } from '../../shared/entities'
import type { ClosedTerminalRecord, TerminalRecord } from '../terminals/session-restore'
import { samePath } from '../git/pathIdentity'
import { openJsonFile, writeJsonFileAtomically } from './atomicJsonFile'
import { DEFAULT_APPEARANCE, sanitizeAppearance, type Appearance } from '../../shared/theme'
import {
  emptyWorkspaceDocument,
  parseWorkspaceDocument,
  type AskedQuestion,
  type AskedQuestions,
  type AgentsRecord,
  type StandingConsentRecord,
  type UpdateRecord,
  type WorkspaceDocument
} from './workspaceDocument'

/** The update check's preference and clock, with the defaults filled in. */
export type UpdateSettings = {
  automatic: boolean
  lastCheckedAt: number | null
  lastSeenVersion: string | null
}

export type WorkspaceSnapshot = {
  projects: Project[]
  worktrees: Worktree[]
  layouts: Layout[]
  terminals: TerminalRecord[]
}

/**
 * Something about the file on disk the app has to say out loud. None stops the
 * store working, which is the danger: an unreadable file looks like a first launch.
 */
export type StoreProblem =
  /** The file was there and could not be read. Nothing has been lost yet. */
  | { kind: 'unreadable'; filePath: string; reason: string }
  /** Those bytes now live here, because something had to be written. */
  | { kind: 'keptAside'; filePath: string; keptAt: string }
  /** Refused to write, so the unreadable file is still whole. */
  | { kind: 'notWritten'; filePath: string; reason: string }
  /** Nothing has been saved since; this session's work is in memory only. */
  | { kind: 'writeFailed'; filePath: string; reason: string }

export function describeStoreProblem(problem: StoreProblem): string {
  switch (problem.kind) {
    case 'unreadable':
      return (
        `${problem.filePath} could not be read (${problem.reason}), so this window opened with nothing in it. ` +
        'Your projects and worktrees are still on disk; the file is kept until something needs to be saved.'
      )
    case 'keptAside':
      return `${problem.filePath} could not be read and was kept at ${problem.keptAt} before a new one was written.`
    case 'notWritten':
      return (
        `${problem.filePath} could not be read and could not be moved aside (${problem.reason}), ` +
        'so nothing is being saved rather than writing over it.'
      )
    case 'writeFailed':
      return `${problem.filePath} could not be written (${problem.reason}); nothing has been saved since.`
  }
}

const CLOSED_KEPT_MS = 14 * 24 * 60 * 60_000

export type WorkspaceStoreOptions = {
  /** Defaults to reporting; never to silence. */
  onProblem?: (problem: StoreProblem) => void
  now?: () => number
}

export class WorkspaceStore {
  private readonly projects = new Map<string, Project>()
  private readonly worktrees = new Map<string, Worktree>()
  private readonly layouts = new Map<string, Layout>()
  private readonly terminals = new Map<string, TerminalRecord>()
  private closedTerminals: ClosedTerminalRecord[] = []
  private readonly mutedTerminals = new Set<string>()
  /** Standing permissions, keyed the way `consentKey` spells one out. */
  private readonly standingConsent = new Map<string, StandingConsentRecord>()
  private asked: AskedQuestions = {}
  private appearance: Appearance = DEFAULT_APPEARANCE
  private updates: UpdateRecord = {}
  private agents: AgentsRecord = {}

  private queue: Promise<void> = Promise.resolve()
  private queued = false
  private writeError: unknown
  private reportedWriteFailure = false
  private readonly onProblem: (problem: StoreProblem) => void
  private readonly now: () => number
  /** Set while the file on disk is one this process has refused to overwrite. */
  private unreadableReason: string | undefined

  private constructor(
    readonly filePath: string,
    document: WorkspaceDocument,
    options: WorkspaceStoreOptions
  ) {
    this.onProblem = options.onProblem ?? ((problem) => console.error('[workspace]', describeStoreProblem(problem)))
    this.now = options.now ?? Date.now
    for (const project of document.projects) this.projects.set(project.id, project)
    for (const worktree of document.worktrees) this.worktrees.set(worktree.id, worktree)
    for (const layout of document.layouts) this.layouts.set(layout.worktreeId, layout)
    for (const terminal of document.terminals) this.terminals.set(terminal.id, terminal)
    // A fortnight, as the kept copies of removed worktrees.
    const since = this.now() - CLOSED_KEPT_MS
    this.closedTerminals = document.closedTerminals.filter((closed) => closed.closedAt >= since)
    for (const terminalId of document.mutedTerminals) this.mutedTerminals.add(terminalId)
    for (const grant of document.standingConsent) {
      this.standingConsent.set(consentKey(grant.terminalId, grant.publicKey), grant)
    }
    this.asked = document.asked
    this.appearance = document.appearance
    this.updates = document.updates
    this.agents = document.agents
  }

  /**
   * Opens the file, or starts empty. An unreadable file still opens the store,
   * but nothing writes over those bytes until they are kept aside.
   */
  static async open(filePath: string, options: WorkspaceStoreOptions = {}): Promise<WorkspaceStore> {
    const read = await openJsonFile(filePath)
    const document = read.kind === 'parsed' ? parseWorkspaceDocument(read.value) : emptyWorkspaceDocument()
    const store = new WorkspaceStore(filePath, document, options)
    if (read.kind === 'unreadable') {
      store.unreadableReason = read.reason
      store.onProblem({ kind: 'unreadable', filePath, reason: read.reason })
    }
    return store
  }

  /** Why the file on disk could not be read, when it could not. */
  get unreadable(): string | undefined {
    return this.unreadableReason
  }

  listProjects(): Project[] {
    return [...this.projects.values()]
  }

  getProject(projectId: string): Project | undefined {
    return this.projects.get(projectId)
  }

  /** Matched through path identity: two spellings of one checkout are one project. */
  findProjectByPath(path: string): Project | undefined {
    for (const project of this.projects.values()) if (samePath(project.path, path)) return project
    return undefined
  }

  putProject(project: Project): Project {
    this.projects.set(project.id, project)
    this.persist()
    return project
  }

  /** Removing a project takes its worktrees and their layouts with it. */
  removeProject(projectId: string): boolean {
    if (!this.projects.delete(projectId)) return false
    // Copied first: the loop deletes from the map it is walking.
    for (const worktree of [...this.worktrees.values()]) {
      if (worktree.projectId === projectId) {
        this.worktrees.delete(worktree.id)
        this.layouts.delete(worktree.id)
      }
    }
    this.persist()
    return true
  }

  listWorktrees(projectId?: string): Worktree[] {
    const all = [...this.worktrees.values()]
    return projectId === undefined ? all : all.filter((worktree) => worktree.projectId === projectId)
  }

  getWorktree(worktreeId: string): Worktree | undefined {
    return this.worktrees.get(worktreeId)
  }

  putWorktree(worktree: Worktree): Worktree {
    this.worktrees.set(worktree.id, worktree)
    this.persist()
    return worktree
  }

  removeWorktree(worktreeId: string): boolean {
    if (!this.worktrees.delete(worktreeId)) return false
    this.layouts.delete(worktreeId)
    this.persist()
    return true
  }

  listLayouts(): Layout[] {
    return [...this.layouts.values()]
  }

  getLayout(worktreeId: string): Layout | undefined {
    return this.layouts.get(worktreeId)
  }

  putLayout(layout: Layout): Layout {
    this.layouts.set(layout.worktreeId, layout)
    this.persist()
    return layout
  }

  /** Drops a layout on its own: closing the panes of a removed worktree would write the emptied layout back. */
  removeLayout(worktreeId: string): boolean {
    const removed = this.layouts.delete(worktreeId)
    if (removed) this.persist()
    return removed
  }

  /** Terminal records: descriptions, not live terminals. */
  listTerminals(): TerminalRecord[] {
    return [...this.terminals.values()]
  }

  putTerminal(terminal: TerminalRecord): TerminalRecord {
    this.terminals.set(terminal.id, terminal)
    this.persist()
    return terminal
  }

  removeTerminal(terminalId: string): boolean {
    const removed = this.terminals.delete(terminalId)
    // The mute and the permissions go with the record, so nothing needs sweeping.
    const unmuted = this.mutedTerminals.delete(terminalId)
    let forgotten = false
    for (const [key, grant] of this.standingConsent) {
      if (grant.terminalId !== terminalId) continue
      this.standingConsent.delete(key)
      forgotten = true
    }
    if (removed || unmuted || forgotten) this.persist()
    return removed
  }

  listClosedTerminals(): ClosedTerminalRecord[] {
    return [...this.closedTerminals]
  }

  setClosedTerminals(closed: ClosedTerminalRecord[]): void {
    this.closedTerminals = [...closed]
    this.persist()
  }

  /** Standing permissions between runs; read once at startup by the peer service. */
  listStandingConsent(): StandingConsentRecord[] {
    return [...this.standingConsent.values()]
  }

  /** `since` records it; `null` takes it back. */
  setStandingConsent(terminalId: string, publicKey: string, since: number | null): void {
    const key = consentKey(terminalId, publicKey)
    const changed = since === null ? this.standingConsent.delete(key) : this.standingConsent.get(key)?.since !== since
    if (since !== null) this.standingConsent.set(key, { terminalId, publicKey, since })
    if (changed) this.persist()
  }

  /** Panes the owner has muted; read once at startup by the peer service. */
  listMutedTerminals(): string[] {
    return [...this.mutedTerminals]
  }

  setTerminalMuted(terminalId: string, muted: boolean): void {
    const changed = muted ? !this.mutedTerminals.has(terminalId) : this.mutedTerminals.delete(terminalId)
    if (muted) this.mutedTerminals.add(terminalId)
    if (changed) this.persist()
  }

  /** When this installation was asked a one-time question, or undefined. Not part of `snapshot()`. */
  askedAt(question: AskedQuestion): number | undefined {
    return this.asked[question]
  }

  /** Records that the question has been put. The first date stands. */
  markAsked(question: AskedQuestion, at: number = this.now()): void {
    if (this.asked[question] !== undefined) return
    this.asked = { ...this.asked, [question]: at }
    this.persist()
  }

  /** How this installation is painted; from memory, since a window is coloured before it exists. */
  getAppearance(): Appearance {
    return this.appearance
  }

  /** Replaces the whole choice, sanitised here: the last place before the bytes hit the disk. */
  setAppearance(appearance: unknown): Appearance {
    this.appearance = sanitizeAppearance(appearance)
    this.persist()
    return this.appearance
  }

  /** The update check's preference and clock. Automatic when the field is missing, or every older file goes quiet. */
  updateSettings(): UpdateSettings {
    return {
      automatic: this.updates.automatic ?? true,
      lastCheckedAt: this.updates.lastCheckedAt ?? null,
      lastSeenVersion: this.updates.lastSeenVersion ?? null
    }
  }

  setUpdateAutomatic(automatic: boolean): void {
    if ((this.updates.automatic ?? true) === automatic) return
    this.updates = { ...this.updates, automatic }
    this.persist()
  }

  /** Whether a new worktree gets the agent CLIs' trust of its main checkout. On unless turned off. */
  trustNewWorktrees(): boolean {
    return this.agents.trustNewWorktrees ?? true
  }

  setTrustNewWorktrees(on: boolean): void {
    if (this.trustNewWorktrees() === on) return
    this.agents = { ...this.agents, trustNewWorktrees: on }
    this.persist()
  }

  /** The rate limit's clock, on disk so an hour of restarts is one check. */
  recordUpdateCheck(at: number): void {
    this.updates = { ...this.updates, lastCheckedAt: at }
    this.persist()
  }

  /** The newest version a check saw, or null when it saw no release at all. */
  rememberLatestVersion(version: string | null): void {
    if ((this.updates.lastSeenVersion ?? null) === version) return
    this.updates = version === null ? omitLastSeen(this.updates) : { ...this.updates, lastSeenVersion: version }
    this.persist()
  }

  snapshot(): WorkspaceSnapshot {
    return {
      projects: this.listProjects(),
      worktrees: this.listWorktrees(),
      layouts: [...this.layouts.values()],
      terminals: this.listTerminals()
    }
  }

  /** Waits for every scheduled write and surfaces the last write failure once. */
  async flush(): Promise<void> {
    let awaited: Promise<void>
    do {
      awaited = this.queue
      await awaited
    } while (awaited !== this.queue)

    const error = this.writeError
    if (error !== undefined) {
      this.writeError = undefined
      throw error
    }
  }

  private persist(): void {
    // One queued write already covers whatever mutations land before it runs.
    if (this.queued) return
    this.queued = true
    this.queue = this.queue.then(async () => {
      this.queued = false
      try {
        if (!(await this.keepUnreadableFile())) return
        await writeJsonFileAtomically(this.filePath, this.document())
        this.reportedWriteFailure = false
      } catch (error) {
        this.writeError = error
        // Said the first time: finding out at shutdown is too late.
        if (!this.reportedWriteFailure) {
          this.reportedWriteFailure = true
          this.onProblem({ kind: 'writeFailed', filePath: this.filePath, reason: describeError(error) })
        }
      }
    })
  }

  /** Moves an unreadable file aside before anything writes over it; false stops the write. */
  private async keepUnreadableFile(): Promise<boolean> {
    if (this.unreadableReason === undefined) return true
    const keptAt = `${this.filePath}.unreadable-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}`
    try {
      await rename(this.filePath, keptAt)
    } catch (error) {
      this.onProblem({ kind: 'notWritten', filePath: this.filePath, reason: describeError(error) })
      return false
    }
    this.unreadableReason = undefined
    this.onProblem({ kind: 'keptAside', filePath: this.filePath, keptAt })
    return true
  }

  private document(): WorkspaceDocument {
    return {
      ...emptyWorkspaceDocument(),
      ...this.snapshot(),
      closedTerminals: this.listClosedTerminals(),
      mutedTerminals: this.listMutedTerminals(),
      standingConsent: this.listStandingConsent(),
      asked: this.asked,
      appearance: this.appearance,
      updates: this.updates,
      agents: this.agents
    }
  }
}

/** One pane, one teammate: a pane-only key would be "anyone may type here". */
function consentKey(terminalId: string, publicKey: string): string {
  return `${terminalId}\u0000${publicKey}`
}

/** The record without a version in it, so memory matches the JSON it writes. */
function omitLastSeen(updates: UpdateRecord): UpdateRecord {
  const { lastSeenVersion: _dropped, ...rest } = updates
  return rest
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
