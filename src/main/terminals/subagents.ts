// The subagents a Claude Code pane's session starts, from two sources: the
// pane's own SubagentStart/SubagentStop hooks, and the session's files under
// the agent's store, read on a poll so nothing a hook missed stays missing.
// Only sessions a teamree pane runs are ever read. docs/plans/subagent-sidebar.md

import { open, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Subagent, SubagentLine, SubagentStatus, SubagentTranscript } from '../../shared/entities'
import { claudeProjectDirectory } from './agent-conversations'

/** What the agent writes beside each subagent's transcript, as far as it is read here. */
type Meta = {
  agentType?: string
  description?: string
  toolUseId?: string
  parentAgentId?: string
  requestShape?: string
  worktreePath?: string
  worktreeBranch?: string
}

type Ending = { status: Exclude<SubagentStatus, 'running'>; at: number }

/** Where a transcript has been read up to; a partial last line waits in `carry`. */
type Scan = { offset: number; carry: Buffer }

type Session = {
  /** `<project dir>/<session id>`, which holds `subagents/`. */
  directory: string
  /** `<project dir>/<session id>.jsonl`. */
  transcript: string
  scans: Map<string, Scan>
  metas: Map<string, { meta: Meta; mtimeMs: number; bornAt: number; lastWriteAt: number }>
  /** By agent id, from `<task-notification>`s in any transcript of the session. */
  notified: Map<string, Ending>
  /** By tool use id, from `tool_result`s. */
  results: Map<string, Ending>
}

type Hooked = { sessionId: string; agentType?: string; startedAt?: number; stoppedAt?: number }

type Pane = {
  cwd: string
  /** When this pane's agent process started; a subagent silent since then is not running. */
  since: number
  isRunning: () => boolean
  sessions: Map<string, Session>
  hooked: Map<string, Hooked>
  shown: Subagent[]
  refreshing?: Promise<void>
  again: boolean
}

export type SubagentTrackerOptions = {
  onChange: (terminalId: string) => void
  /** The store directory for a cwd; tests point it at a tree they built. */
  projectDirectory?: (cwd: string) => string
  /** 0 turns the poll off. */
  pollMs?: number
  clock?: () => number
}

/** Finished subagents kept per pane beside every running one. */
export const FINISHED_SHOWN = 5

/** How close a disk ending must be to a hook's for the disk's more specific word to stand. */
const SAME_ENDING_MS = 5_000

const POLL_MS = 2_000
const READ_CHUNK_BYTES = 1 << 20
const TRANSCRIPT_MAX_BYTES = 8 << 20
const TRANSCRIPT_MAX_LINES = 500
const LINE_MAX_CHARS = 4_000
const RESULT_MAX_CHARS = 600

const USABLE_ID = /^[A-Za-z0-9_-]{1,128}$/

export class SubagentTracker {
  readonly #panes = new Map<string, Pane>()
  readonly #options: SubagentTrackerOptions
  readonly #clock: () => number
  #timer: ReturnType<typeof setInterval> | undefined

  constructor(options: SubagentTrackerOptions) {
    this.#options = options
    this.#clock = options.clock ?? Date.now
  }

  /** Starts (or restarts, on a relaunch) following one pane's session. */
  track(terminalId: string, pane: { cwd: string; sessionId?: string; isRunning: () => boolean }): Promise<void> {
    const state: Pane = {
      cwd: pane.cwd,
      since: this.#clock(),
      isRunning: pane.isRunning,
      sessions: new Map(),
      hooked: new Map(),
      shown: this.#panes.get(terminalId)?.shown ?? [],
      again: false
    }
    this.#panes.set(terminalId, state)
    if (pane.sessionId !== undefined) this.#addSession(state, pane.sessionId)
    this.#startPoll()
    return this.refresh(terminalId)
  }

  untrack(terminalId: string): void {
    this.#panes.delete(terminalId)
    if (this.#panes.size === 0) this.#stopPoll()
  }

  /** What the pane shows; undefined for a pane not followed or with none. */
  list(terminalId: string): Subagent[] | undefined {
    const shown = this.#panes.get(terminalId)?.shown
    return shown === undefined || shown.length === 0 ? undefined : shown
  }

  /** A session id the pane's hook reported; a new one is read at once. */
  noteSession(terminalId: string, sessionId: string, transcriptPath?: string): void {
    const pane = this.#panes.get(terminalId)
    if (pane === undefined || !USABLE_ID.test(sessionId)) return
    if (pane.sessions.has(sessionId)) return
    this.#addSession(pane, sessionId, transcriptPath)
    void this.refresh(terminalId)
  }

  /** A SubagentStart or SubagentStop hook. */
  hook(
    terminalId: string,
    event: {
      event: 'SubagentStart' | 'SubagentStop'
      at: number
      sessionId: string
      agentId: string
      agentType?: string
      transcriptPath?: string
    }
  ): void {
    const pane = this.#panes.get(terminalId)
    if (pane === undefined || !USABLE_ID.test(event.agentId)) return
    if (!pane.sessions.has(event.sessionId)) this.#addSession(pane, event.sessionId, event.transcriptPath)
    const before = pane.hooked.get(event.agentId)
    const next: Hooked = { ...before, sessionId: event.sessionId }
    if (event.agentType !== undefined) next.agentType = event.agentType
    if (event.event === 'SubagentStart') {
      next.startedAt = event.at
      delete next.stoppedAt
    } else {
      next.stoppedAt = event.at
    }
    pane.hooked.set(event.agentId, next)
    this.#compose(terminalId, pane)
    void this.refresh(terminalId)
  }

  /** Reads every followed pane's sessions, or one pane's; concurrent calls fold into one more pass. */
  async refresh(terminalId?: string): Promise<void> {
    if (terminalId === undefined) {
      await Promise.all([...this.#panes.keys()].map((id) => this.refresh(id)))
      return
    }
    const pane = this.#panes.get(terminalId)
    if (pane === undefined) return
    if (pane.refreshing !== undefined) {
      pane.again = true
      return pane.refreshing
    }
    pane.refreshing = (async () => {
      do {
        pane.again = false
        for (const session of pane.sessions.values()) await readSession(session)
        if (this.#panes.get(terminalId) !== pane) return
        this.#compose(terminalId, pane)
      } while (pane.again)
    })().finally(() => {
      pane.refreshing = undefined
    })
    return pane.refreshing
  }

  /** One subagent's transcript, read now. */
  async transcript(terminalId: string, agentId: string): Promise<SubagentTranscript | undefined> {
    const pane = this.#panes.get(terminalId)
    if (pane === undefined || !USABLE_ID.test(agentId)) return undefined
    for (const session of pane.sessions.values()) {
      if (!session.metas.has(agentId) && !pane.hooked.has(agentId)) continue
      const file = agentTranscriptPath(session, agentId)
      const read = await readTail(file)
      if (read === undefined) continue
      return { agentId, ...transcriptLines(read.text, read.truncated) }
    }
    return undefined
  }

  close(): void {
    this.#panes.clear()
    this.#stopPoll()
  }

  #addSession(pane: Pane, sessionId: string, transcriptPath?: string): void {
    if (!USABLE_ID.test(sessionId)) return
    // The hook's path wins: it is where the agent actually writes, whatever its config dir.
    const fromHook =
      transcriptPath !== undefined && path.basename(transcriptPath) === `${sessionId}.jsonl`
        ? path.dirname(transcriptPath)
        : undefined
    const project = fromHook ?? (this.#options.projectDirectory ?? claudeProjectDirectory)(pane.cwd)
    pane.sessions.set(sessionId, {
      directory: path.join(project, sessionId),
      transcript: path.join(project, `${sessionId}.jsonl`),
      scans: new Map(),
      metas: new Map(),
      notified: new Map(),
      results: new Map()
    })
  }

  #compose(terminalId: string, pane: Pane): void {
    const shown = composeSubagents(pane, this.#clock())
    if (JSON.stringify(shown) === JSON.stringify(pane.shown)) return
    pane.shown = shown
    this.#options.onChange(terminalId)
  }

  #startPoll(): void {
    const every = this.#options.pollMs ?? POLL_MS
    if (this.#timer !== undefined || every <= 0) return
    this.#timer = setInterval(() => void this.refresh(), every)
    this.#timer.unref?.()
  }

  #stopPoll(): void {
    if (this.#timer === undefined) return
    clearInterval(this.#timer)
    this.#timer = undefined
  }
}

/** Every subagent the pane's sessions know of, running first, then the latest finished. */
function composeSubagents(pane: Pane, now: number): Subagent[] {
  const live = pane.isRunning()
  const all: Subagent[] = []
  const seen = new Set<string>()
  for (const session of pane.sessions.values()) {
    for (const [id, entry] of session.metas) {
      seen.add(id)
      const hooked = pane.hooked.get(id)
      const disk = diskEnding(session, id, entry.meta)
      all.push(
        subagentFrom(id, {
          meta: entry.meta,
          startedAt: hooked?.startedAt ?? entry.bornAt,
          lastWriteAt: entry.lastWriteAt,
          ...(hooked === undefined ? {} : { hooked }),
          ...(disk === undefined ? {} : { disk }),
          live,
          since: pane.since,
          now
        })
      )
    }
  }
  // A hook ahead of its files: shown from what the hook said.
  for (const [id, hooked] of pane.hooked) {
    if (seen.has(id)) continue
    const startedAt = hooked.startedAt ?? hooked.stoppedAt ?? now
    all.push(subagentFrom(id, { meta: {}, startedAt, lastWriteAt: startedAt, hooked, live, since: pane.since, now }))
  }
  const running = all.filter((agent) => agent.status === 'running')
  const finished = all
    .filter((agent) => agent.status !== 'running')
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, FINISHED_SHOWN)
  return [...running, ...finished].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
}

/** The end the session's files record for one subagent, if any. */
function diskEnding(session: Session, id: string, meta: Meta): Ending | undefined {
  const notified = session.notified.get(id)
  // A background agent's tool result is its launch receipt, not its end.
  const result =
    meta.requestShape !== 'background' && meta.toolUseId !== undefined ? session.results.get(meta.toolUseId) : undefined
  if (notified === undefined) return result
  if (result === undefined) return notified
  return notified.at >= result.at ? notified : result
}

type Evidence = {
  meta: Meta
  startedAt: number
  lastWriteAt: number
  hooked?: Hooked
  disk?: Ending
  live: boolean
  since: number
  now: number
}

/** One subagent's row. The latest ending stands unless something started it again afterwards. */
export function subagentFrom(id: string, evidence: Evidence): Subagent {
  const { meta, hooked, disk } = evidence
  const hookEnding: Ending | undefined =
    hooked?.stoppedAt === undefined ? undefined : { status: 'done', at: hooked.stoppedAt }
  let ending: Ending | undefined
  if (disk === undefined) ending = hookEnding
  else if (hookEnding === undefined) ending = disk
  else ending = hookEnding.at > disk.at + SAME_ENDING_MS ? hookEnding : disk
  // SendMessage wakes a finished agent: a start, or writes, after its end.
  const restarted =
    ending !== undefined &&
    evidence.live &&
    ((hooked?.startedAt ?? 0) > ending.at || evidence.lastWriteAt > ending.at + SAME_ENDING_MS)
  if (restarted) ending = undefined
  if (ending === undefined) {
    const active = evidence.live && (hooked?.startedAt !== undefined || evidence.lastWriteAt >= evidence.since)
    if (!active) ending = { status: 'stopped', at: Math.max(evidence.lastWriteAt, evidence.startedAt) }
  }
  const agentType = meta.agentType ?? hooked?.agentType
  return {
    id,
    description: meta.description?.trim() || agentType || 'agent',
    ...(agentType === undefined ? {} : { agentType }),
    ...(meta.parentAgentId === undefined ? {} : { parentId: meta.parentAgentId }),
    status: ending?.status ?? 'running',
    startedAt: evidence.startedAt,
    ...(ending === undefined ? {} : { endedAt: ending.at }),
    ...(meta.worktreePath === undefined ? {} : { worktreePath: meta.worktreePath }),
    ...(meta.worktreeBranch === undefined ? {} : { branch: meta.worktreeBranch })
  }
}

/** Reads what changed in one session: new or rewritten meta files, then transcripts' new bytes. */
async function readSession(session: Session): Promise<void> {
  const folder = path.join(session.directory, 'subagents')
  let names: string[]
  try {
    names = await readdir(folder)
  } catch {
    // No subagent yet; the main transcript is not worth reading until there is one.
    return
  }
  for (const name of names) {
    const match = /^agent-([A-Za-z0-9_-]+)\.meta\.json$/.exec(name)
    if (match === null) continue
    const id = match[1]!
    const file = path.join(folder, name)
    const info = await stat(file).catch(() => null)
    if (info === null) continue
    const transcript = await stat(agentTranscriptPath(session, id)).catch(() => null)
    const known = session.metas.get(id)
    const lastWriteAt = Math.round(transcript?.mtimeMs ?? info.mtimeMs)
    if (known !== undefined && known.mtimeMs === info.mtimeMs) {
      known.lastWriteAt = lastWriteAt
      continue
    }
    const meta = await readMeta(file)
    if (meta === undefined) continue
    // Birth time where the filesystem keeps one; the meta is written as the agent starts.
    const bornAt = Math.round(info.birthtimeMs > 0 ? info.birthtimeMs : info.ctimeMs)
    session.metas.set(id, { meta, mtimeMs: info.mtimeMs, bornAt: known?.bornAt ?? bornAt, lastWriteAt })
  }
  // Endings land in the transcript of whoever started the agent: the session's, or a parent agent's.
  const parents = new Set<string>()
  for (const { meta } of session.metas.values()) if (meta.parentAgentId !== undefined) parents.add(meta.parentAgentId)
  const transcripts = [session.transcript, ...[...parents].map((id) => agentTranscriptPath(session, id))]
  for (const file of transcripts) await scanTranscript(session, file)
}

function agentTranscriptPath(session: Session, agentId: string): string {
  return path.join(session.directory, 'subagents', `agent-${agentId}.jsonl`)
}

async function readMeta(file: string): Promise<Meta | undefined> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    // Caught mid-write; the next pass reads it whole.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const meta: Meta = {}
  for (const key of [
    'agentType',
    'description',
    'toolUseId',
    'parentAgentId',
    'requestShape',
    'worktreePath',
    'worktreeBranch'
  ] as const) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) meta[key] = value.slice(0, 512)
  }
  return meta
}

/** Reads a transcript's bytes since the last pass, one line at a time; a shrunk file is read again. */
async function scanTranscript(session: Session, file: string): Promise<void> {
  const size = (await stat(file).catch(() => null))?.size
  if (size === undefined) return
  let scan = session.scans.get(file)
  if (scan === undefined || size < scan.offset) {
    scan = { offset: 0, carry: Buffer.alloc(0) }
    session.scans.set(file, scan)
  }
  if (size === scan.offset) return
  const handle = await open(file, 'r').catch(() => null)
  if (handle === null) return
  try {
    while (scan.offset < size) {
      const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, size - scan.offset))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, scan.offset)
      if (bytesRead === 0) break
      scan.offset += bytesRead
      const joined = Buffer.concat([scan.carry, buffer.subarray(0, bytesRead)])
      const end = joined.lastIndexOf(0x0a)
      if (end === -1) {
        scan.carry = joined
        continue
      }
      scan.carry = Buffer.from(joined.subarray(end + 1))
      for (const line of joined.subarray(0, end).toString('utf8').split('\n')) readLine(session, line)
    }
  } finally {
    await handle.close()
  }
}

/** Takes the endings out of one transcript line; everything else in it is ignored. */
export function readLine(session: Pick<Session, 'notified' | 'results'>, line: string): void {
  const notifies = line.includes('<task-id>')
  const results = line.includes('"tool_result"')
  if (!notifies && !results) return
  let entry: { timestamp?: unknown; message?: { content?: unknown } }
  try {
    entry = JSON.parse(line) as typeof entry
  } catch {
    return
  }
  const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
  if (Number.isNaN(at)) return
  if (notifies) {
    for (const chunk of line.split('<task-id>').slice(1)) {
      const id = /^([A-Za-z0-9_-]+)<\/task-id>/.exec(chunk)?.[1]
      const status = /<status>([a-z_]+)<\/status>/.exec(chunk)?.[1]
      if (id === undefined || status === undefined) continue
      const known = session.notified.get(id)
      if (known === undefined || known.at <= at) session.notified.set(id, { status: notifiedStatus(status), at })
    }
  }
  const content = entry.message?.content
  if (results && Array.isArray(content)) {
    for (const block of content as Array<{ type?: unknown; tool_use_id?: unknown; is_error?: unknown }>) {
      if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      session.results.set(block.tool_use_id, { status: block.is_error === true ? 'failed' : 'done', at })
    }
  }
}

function notifiedStatus(status: string): Ending['status'] {
  if (status === 'completed') return 'done'
  if (status === 'killed') return 'stopped'
  return 'failed'
}

/** A file's text, only its last `TRANSCRIPT_MAX_BYTES` when longer, from a whole line on. */
async function readTail(file: string): Promise<{ text: string; truncated: boolean } | undefined> {
  const handle = await open(file, 'r').catch(() => null)
  if (handle === null) return undefined
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - TRANSCRIPT_MAX_BYTES)
    const buffer = Buffer.alloc(size - start)
    await handle.read(buffer, 0, buffer.length, start)
    let text = buffer.toString('utf8')
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    return { text, truncated: start > 0 }
  } finally {
    await handle.close()
  }
}

/** A transcript as prompt, text, tool and result lines, newest `TRANSCRIPT_MAX_LINES` kept. */
export function transcriptLines(text: string, truncated = false): { lines: SubagentLine[]; truncated: boolean } {
  const lines: SubagentLine[] = []
  for (const raw of text.split('\n')) {
    if (raw.trim().length === 0) continue
    let entry: { type?: unknown; timestamp?: unknown; message?: { content?: unknown } }
    try {
      entry = JSON.parse(raw) as typeof entry
    } catch {
      continue
    }
    if (entry.type !== 'user' && entry.type !== 'assistant') continue
    const parsed = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
    const at = Number.isNaN(parsed) ? {} : { at: parsed }
    const push = (kind: SubagentLine['kind'], body: string, cap = LINE_MAX_CHARS): void => {
      const trimmed = body.trim()
      if (trimmed.length > 0) lines.push({ kind, text: clip(trimmed, cap), ...at })
    }
    const content = entry.message?.content
    if (typeof content === 'string') {
      push(entry.type === 'user' ? 'prompt' : 'text', content)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        push(entry.type === 'user' ? 'prompt' : 'text', block.text)
      } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
        push('tool', `${block.name} ${toolSummary(block.input)}`, RESULT_MAX_CHARS)
      } else if (block?.type === 'tool_result') {
        push('result', resultText(block.content), RESULT_MAX_CHARS)
      }
    }
  }
  const kept = lines.slice(-TRANSCRIPT_MAX_LINES)
  return { lines: kept, truncated: truncated || kept.length < lines.length }
}

function toolSummary(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const fields = input as Record<string, unknown>
  for (const key of ['description', 'command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt']) {
    const value = fields[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return JSON.stringify(input)
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part: { type?: unknown; text?: unknown }) =>
      part?.type === 'text' && typeof part.text === 'string' ? part.text : ''
    )
    .join('\n')
}

function clip(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap - 1)}…`
}
