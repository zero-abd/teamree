// Durable workspace state: the projects a user tracks, the worktrees under them,
// and the pane layout per worktree. State is held in memory and mirrored to one
// JSON file; reads are synchronous because handlers answer from memory, and
// writes are coalesced so a burst of mutations costs one write. Each write is
// copied to `.bak`, which is loaded when the file cannot be read.

import { constants } from 'node:fs'
import { copyFile, rename, rm } from 'node:fs/promises'
import type { Layout, Project, Worktree, WorkspaceFileProblem } from '../../shared/entities'
import type { ClosedTerminalRecord, TerminalRecord } from '../terminals/session-restore'
import { samePath } from '../git/pathIdentity'
import { openJsonFile, writeJsonFileAtomically } from './atomicJsonFile'
import {
  DEFAULT_APPEARANCE,
  DEFAULT_LIGHT_THEME_ID,
  DEFAULT_THEME_ID,
  isPristine,
  sanitizeAppearance,
  type Appearance
} from '../../shared/theme'
import type { RuntimeSettings } from '../../shared/settings'
import {
  emptyWorkspaceDocument,
  parseWorkspaceDocument,
  runtimeSettings,
  type AskedQuestion,
  type AskedQuestions,
  type AgentsRecord,
  type SettingsRecord,
  type QuickNoteRecord,
  type StandingConsentRecord,
  type UpdateRecord,
  type WorkspaceDocument
} from './workspaceDocument'

/** The update check's preference and clock, with the defaults filled in. */
export type UpdateSettings = {
  automatic: boolean
  lastCheckedAt: number | null
  lastSucceededAt: number | null
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
  /** The file could not be read and the backup was loaded in its place. */
  | { kind: 'restored'; filePath: string; backupPath: string }
  /** A write landed after `writeFailed`. */
  | { kind: 'saved'; filePath: string }

export function describeStoreProblem(problem: StoreProblem): string {
  switch (problem.kind) {
    case 'unreadable':
      return `${problem.filePath} could not be read (${problem.reason}).`
    case 'keptAside':
      return `${problem.filePath} could not be read and was kept at ${problem.keptAt} before a new one was written.`
    case 'notWritten':
      return (
        `${problem.filePath} could not be read and could not be moved aside (${problem.reason}), ` +
        'so nothing is being saved rather than writing over it.'
      )
    case 'writeFailed':
      return `${problem.filePath} could not be written (${problem.reason}); nothing has been saved since.`
    case 'restored':
      return `${problem.filePath} could not be read; loaded ${problem.backupPath} instead.`
    case 'saved':
      return `${problem.filePath} was written again.`
  }
}

const CLOSED_KEPT_MS = 14 * 24 * 60 * 60_000
const SAVE_RETRY_MS = 5_000

const BACKUP_SUFFIX = '.bak'

export type WorkspaceStoreOptions = {
  /** Defaults to reporting; never to silence. */
  onProblem?: (problem: StoreProblem) => void
  now?: () => number
  /** How soon a failed write is tried again. */
  retryMs?: number
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
  private settings: SettingsRecord = {}
  private quickNote: QuickNoteRecord = {}

  private queue: Promise<void> = Promise.resolve()
  private queued = false
  private writeError: unknown
  private saveFailure: { reason: string; diskFull: boolean } | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private readonly onProblem: (problem: StoreProblem) => void
  private readonly now: () => number
  private readonly retryMs: number
  /** Why the file could not be read at open, for the whole session. */
  private unreadableReason: string | undefined
  /** Set while the unreadable file is still in place, so nothing may write over it. */
  private unreadablePending = false
  private keptAt: string | undefined
  private saidNotWritten = false
  private loadProblem: WorkspaceFileProblem | undefined

  private constructor(
    readonly filePath: string,
    document: WorkspaceDocument,
    options: WorkspaceStoreOptions
  ) {
    this.onProblem = options.onProblem ?? ((problem) => console.error('[workspace]', describeStoreProblem(problem)))
    this.now = options.now ?? Date.now
    this.retryMs = options.retryMs ?? SAVE_RETRY_MS
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
    this.settings = document.settings
    this.quickNote = document.quickNote
    this.moveOldDefaultTheme()
  }

  // Absolute Black, then Charcoal and Light, were the defaults before Studio: an untouched one was never chosen, so it moves once.
  private moveOldDefaultTheme(): void {
    if (this.settings.themeMigratedToStudio === true) return
    const { themeId, light } = this.appearance
    const oldDark = themeId === 'charcoal' || (themeId === 'black' && this.settings.themeMigratedToCharcoal !== true)
    const moveDark = oldDark && isPristine(this.appearance)
    const moveLight = light !== undefined && light.themeId === 'light' && isPristine(light)
    if (!moveDark && !moveLight) return
    this.appearance = {
      ...this.appearance,
      ...(moveDark ? { themeId: DEFAULT_THEME_ID } : {}),
      ...(moveLight ? { light: { ...light, themeId: DEFAULT_LIGHT_THEME_ID } } : {})
    }
    this.settings = { ...this.settings, themeMigratedToCharcoal: true, themeMigratedToStudio: true }
    this.persist()
  }

  /**
   * Opens the file, its backup when the file cannot be read, or starts empty.
   * An unreadable file is moved aside before anything is written in its place.
   */
  static async open(filePath: string, options: WorkspaceStoreOptions = {}): Promise<WorkspaceStore> {
    const read = await openJsonFile(filePath)
    const backupPath = filePath + BACKUP_SUFFIX
    const backup = read.kind === 'unreadable' ? await openJsonFile(backupPath) : undefined
    const loaded = read.kind === 'parsed' ? read : backup?.kind === 'parsed' ? backup : undefined
    const document = loaded === undefined ? emptyWorkspaceDocument() : parseWorkspaceDocument(loaded.value)
    const store = new WorkspaceStore(filePath, document, options)
    if (read.kind !== 'unreadable') return store
    store.unreadableReason = read.reason
    store.unreadablePending = true
    store.onProblem({ kind: 'unreadable', filePath, reason: read.reason })
    // A write the constructor queued may have moved it aside already.
    await store.settled()
    const keptAt = await store.keepUnreadableFile()
    if (backup?.kind === 'parsed' && keptAt !== undefined) {
      store.loadProblem = { kind: 'restored', filePath, keptAt }
      store.onProblem({ kind: 'restored', filePath, backupPath })
      store.persist()
    } else {
      store.loadProblem = { kind: 'unreadable', filePath, ...(keptAt === undefined ? {} : { keptAt }) }
    }
    return store
  }

  /** Why the file on disk could not be read at open, when it could not. */
  get unreadable(): string | undefined {
    return this.unreadableReason
  }

  /** What the window should say about the file, oldest first. */
  problems(): WorkspaceFileProblem[] {
    const problems: WorkspaceFileProblem[] = this.loadProblem === undefined ? [] : [this.loadProblem]
    if (this.saveFailure !== undefined)
      problems.push({ kind: 'saveFailed', filePath: this.filePath, ...this.saveFailure })
    return problems
  }

  /** Writes now; true when the file is saved. */
  async retrySave(): Promise<boolean> {
    this.persist()
    await this.settled()
    return this.saveFailure === undefined && !this.unreadablePending
  }

  /** Waits for the queued save and its backup, then writes nothing more. */
  async close(): Promise<void> {
    this.closed = true
    this.stopRetrying()
    await this.settled()
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
    // A theme written from here on is a choice, an old default included.
    if (this.settings.themeMigratedToStudio !== true)
      this.settings = { ...this.settings, themeMigratedToCharcoal: true, themeMigratedToStudio: true }
    this.persist()
    return this.appearance
  }

  /** The update check's preference and clock. Automatic when the field is missing, or every older file goes quiet. */
  updateSettings(): UpdateSettings {
    return {
      automatic: this.updates.automatic ?? true,
      lastCheckedAt: this.updates.lastCheckedAt ?? null,
      lastSucceededAt: this.updates.lastSucceededAt ?? null,
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

  runtimeSettings(): RuntimeSettings {
    return runtimeSettings(this.settings)
  }

  /** Omitted keys stay as they are; an empty string removes one. False when nothing changed. */
  setRuntimeSettings(changes: Partial<RuntimeSettings>): boolean {
    const current = this.runtimeSettings()
    const changed = Object.entries(changes).filter(
      ([key, value]) => value !== undefined && (current[key as keyof RuntimeSettings] ?? '') !== value
    )
    if (changed.length === 0) return false
    const next: Record<string, unknown> = { ...this.settings, ...Object.fromEntries(changed) }
    for (const [key, value] of changed) if (value === '') delete next[key]
    this.settings = next as SettingsRecord
    this.persist()
    return true
  }

  /** The project the last Quick Note went to. */
  quickNoteProject(): string | undefined {
    return this.quickNote.projectId
  }

  setQuickNoteProject(projectId: string): void {
    if (this.quickNote.projectId === projectId) return
    this.quickNote = { projectId }
    this.persist()
  }

  /** The rate limit's clock, on disk so an hour of restarts is one check. */
  recordUpdateCheck(at: number, succeeded: boolean): void {
    this.updates = { ...this.updates, lastCheckedAt: at, ...(succeeded ? { lastSucceededAt: at } : {}) }
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
    await this.settled()
    const error = this.writeError
    if (error !== undefined) {
      this.writeError = undefined
      throw error
    }
  }

  private async settled(): Promise<void> {
    let awaited: Promise<void>
    do {
      awaited = this.queue
      await awaited
    } while (awaited !== this.queue)
  }

  private persist(): void {
    // One queued write already covers whatever mutations land before it runs.
    if (this.queued || this.closed) return
    this.queued = true
    this.queue = this.queue.then(async () => {
      this.queued = false
      if (this.unreadablePending && (await this.keepUnreadableFile()) === undefined) return
      try {
        await writeJsonFileAtomically(this.filePath, this.document())
      } catch (error) {
        this.writeFailed(error)
        return
      }
      await this.backUp()
      this.writeError = undefined
      this.stopRetrying()
      if (this.saveFailure === undefined) return
      this.saveFailure = undefined
      this.onProblem({ kind: 'saved', filePath: this.filePath })
    })
  }

  private writeFailed(error: unknown): void {
    this.writeError = error
    this.stopRetrying()
    // A timer, not a watch: nothing says when a full disk frees up.
    if (!this.closed) {
      this.retryTimer = setTimeout(() => this.persist(), this.retryMs)
      this.retryTimer.unref()
    }
    // Said the first time: finding out at shutdown is too late.
    if (this.saveFailure !== undefined) return
    const code = (error as NodeJS.ErrnoException).code
    this.saveFailure = { reason: describeError(error), diskFull: code === 'ENOSPC' || code === 'EDQUOT' }
    this.onProblem({ kind: 'writeFailed', filePath: this.filePath, reason: this.saveFailure.reason })
  }

  private stopRetrying(): void {
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }

  /** A copy of what was just written; a clone where the disk can, so it costs no space until one changes. */
  private async backUp(): Promise<void> {
    const staged = `${this.filePath}${BACKUP_SUFFIX}.${process.pid}.tmp`
    try {
      await copyFile(this.filePath, staged, constants.COPYFILE_FICLONE)
      await rename(staged, this.filePath + BACKUP_SUFFIX)
    } catch {
      await rm(staged, { force: true }).catch(() => {})
    }
  }

  /** Moves the unreadable file aside so nothing writes over it; undefined while it could not be. */
  private async keepUnreadableFile(): Promise<string | undefined> {
    if (!this.unreadablePending) return this.keptAt
    const keptAt = `${this.filePath}.unreadable-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}`
    try {
      await rename(this.filePath, keptAt)
    } catch (error) {
      if (!this.saidNotWritten)
        this.onProblem({ kind: 'notWritten', filePath: this.filePath, reason: describeError(error) })
      this.saidNotWritten = true
      return undefined
    }
    this.unreadablePending = false
    this.keptAt = keptAt
    this.onProblem({ kind: 'keptAside', filePath: this.filePath, keptAt })
    return keptAt
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
      agents: this.agents,
      settings: this.settings,
      quickNote: this.quickNote
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
