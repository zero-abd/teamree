// Messages between agents, per project, as JSONL under `<userData>/messages/`.
// Each change appends the whole message; reading folds by id, the last line winning.

import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MessageKind, MessageParty, TaskMessage } from '../../shared/messages'

/** Messages kept per project; older ones are dropped at the next compaction. */
export const MAX_MESSAGES_PER_PROJECT = 2000

export type MessageFilter = {
  projectId?: string
  /** Sent by or to this worktree. */
  worktreeId?: string
  /** Sent by or to this pane. */
  terminalId?: string
  kinds?: readonly MessageKind[]
  /** Asks not yet answered, and anything else not yet delivered or read. */
  open?: boolean
  /** The newest this many, still oldest first. */
  limit?: number
}

export type NewMessage = Omit<TaskMessage, 'id' | 'at' | 'state'> & { state?: TaskMessage['state'] }

export class MessageStore {
  private readonly byId = new Map<number, TaskMessage>()
  /** Lines in each project's file, so compaction runs only when the file has grown past twice the cap. */
  private readonly lines = new Map<string, number>()
  private nextId = 1

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
    private readonly cap = MAX_MESSAGES_PER_PROJECT
  ) {
    for (const file of safeList(dir)) {
      if (!file.endsWith('.jsonl')) continue
      const projectId = file.slice(0, -'.jsonl'.length)
      const read = safeRead(join(dir, file)).split('\n')
      let count = 0
      for (const line of read) {
        const message = parseLine(line)
        if (message === undefined || message.projectId !== projectId) continue
        count += 1
        this.byId.set(message.id, message)
        this.nextId = Math.max(this.nextId, message.id + 1)
      }
      this.lines.set(projectId, count)
      this.trim(projectId)
    }
  }

  add(message: NewMessage): TaskMessage {
    const stored: TaskMessage = { ...message, id: this.nextId++, at: this.now(), state: message.state ?? 'queued' }
    this.byId.set(stored.id, stored)
    this.write(stored)
    this.trim(stored.projectId)
    return stored
  }

  get(id: number): TaskMessage | undefined {
    return this.byId.get(id)
  }

  /** An `undefined` in the patch removes that field. */
  update(
    id: number,
    patch: Partial<Pick<TaskMessage, 'state' | 'answeredBy' | 'expiredAt' | 'expiredBy'>>
  ): TaskMessage | undefined {
    const current = this.byId.get(id)
    if (current === undefined) return undefined
    const next: TaskMessage = { ...current, ...patch }
    for (const key of Object.keys(patch) as (keyof typeof patch)[]) if (patch[key] === undefined) delete next[key]
    this.byId.set(id, next)
    this.write(next)
    return next
  }

  list(filter: MessageFilter = {}): TaskMessage[] {
    const matches = [...this.byId.values()]
      .filter((message) => {
        if (filter.projectId !== undefined && message.projectId !== filter.projectId) return false
        if (filter.worktreeId !== undefined && !touches(message, 'worktreeId', filter.worktreeId)) return false
        if (filter.terminalId !== undefined && !touches(message, 'terminalId', filter.terminalId)) return false
        if (filter.kinds !== undefined && !filter.kinds.includes(message.kind)) return false
        return filter.open !== true || isOpen(message)
      })
      .sort((one, other) => one.id - other.id)
    return filter.limit === undefined ? matches : matches.slice(-filter.limit)
  }

  private trim(projectId: string): void {
    const kept = this.list({ projectId })
    for (const dropped of kept.slice(0, Math.max(0, kept.length - this.cap))) this.byId.delete(dropped.id)
    if ((this.lines.get(projectId) ?? 0) > this.cap * 2) this.compact(projectId)
  }

  private compact(projectId: string): void {
    const kept = this.list({ projectId })
    const file = this.fileOf(projectId)
    const temp = `${file}.${process.pid}.tmp`
    try {
      writeFileSync(temp, kept.map((message) => `${JSON.stringify(message)}\n`).join(''))
      renameSync(temp, file)
      this.lines.set(projectId, kept.length)
    } catch (error) {
      console.error('[messages]', error)
    }
  }

  private write(message: TaskMessage): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      appendFileSync(this.fileOf(message.projectId), `${JSON.stringify(message)}\n`)
      this.lines.set(message.projectId, (this.lines.get(message.projectId) ?? 0) + 1)
    } catch (error) {
      // A full disk costs the history, never the message in hand.
      console.error('[messages]', error)
    }
  }

  private fileOf(projectId: string): string {
    return join(this.dir, `${projectId}.jsonl`)
  }
}

/** An ask nobody answered, or anything else nobody has been shown yet. */
export function isOpen(message: TaskMessage): boolean {
  return message.kind === 'ask' ? message.state !== 'answered' : message.state === 'queued'
}

function touches(message: TaskMessage, key: keyof MessageParty, value: string): boolean {
  return message.from[key] === value || message.to[key] === value
}

function parseLine(line: string): TaskMessage | undefined {
  if (line.trim() === '') return undefined
  try {
    const value = JSON.parse(line) as TaskMessage
    const valid =
      typeof value === 'object' &&
      value !== null &&
      Number.isInteger(value.id) &&
      typeof value.projectId === 'string' &&
      typeof value.kind === 'string' &&
      typeof value.text === 'string' &&
      typeof value.from === 'object' &&
      typeof value.to === 'object'
    return valid ? value : undefined
  } catch {
    return undefined
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function safeRead(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}
