// A worktree's past conversations, read from Claude Code's and Codex's own
// stores for its checkout and nowhere else. Read-only; nothing here leaves this machine.

import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { AgentConversation } from '../../shared/entities'
import type { ProfileStores } from './shell-environment'
import {
  claudeProjectSlug,
  claudeStoreRoots,
  codexSessionsDirectories,
  head,
  isUsableFileName,
  MAX_ROLLOUTS_SEARCHED,
  resolved,
  rolloutFiles
} from './agent-conversations'

/** How many conversations a picker is given. */
export const MAX_CONVERSATIONS = 20

/** How much of a first prompt or a title is shown, ellipsis included. */
export const PROMPT_CHARS = 100

/** Transcripts read before giving up on filling the list: a slug folder can hold other checkouts' files. */
const MAX_TRANSCRIPTS_READ = 60

/** Newest first across both agents and every store `conversationOnDisk` reads, at most `MAX_CONVERSATIONS`. */
export async function listConversations(
  cwd: string,
  home: string = os.homedir(),
  profile: ProfileStores = {}
): Promise<AgentConversation[]> {
  const checkout = resolved(cwd)
  const found = await Promise.all([
    ...claudeStoreRoots(home, profile).map((root) =>
      claudeConversations(checkout, path.join(root, 'projects', claudeProjectSlug(checkout)))
    ),
    ...codexSessionsDirectories(home, profile).map((sessions) => codexConversations(checkout, sessions))
  ])
  const seen = new Set<string>()
  return found
    .flat()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((conversation) => {
      const key = `${conversation.agent}:${conversation.sessionId}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, MAX_CONVERSATIONS)
}

type Tally = {
  cwd?: string
  title?: string
  summary?: string
  prompt?: string
  updatedAt?: number
  messages: number
}

async function claudeConversations(checkout: string, directory: string): Promise<AgentConversation[]> {
  const names = (await readdir(directory).catch(() => [] as string[])).filter(
    (name) => name.endsWith('.jsonl') && isUsableFileName(name.slice(0, -'.jsonl'.length))
  )
  const files = await Promise.all(
    names.map(async (name) => {
      const file = path.join(directory, name)
      const modified = await stat(file).then(
        (info) => info.mtimeMs,
        () => -1
      )
      return { file, sessionId: name.slice(0, -'.jsonl'.length), modified }
    })
  )
  files.sort((a, b) => b.modified - a.modified)

  const found: AgentConversation[] = []
  for (const { file, sessionId, modified } of files.slice(0, MAX_TRANSCRIPTS_READ)) {
    if (found.length >= MAX_CONVERSATIONS || modified < 0) break
    const tally = await readClaudeTranscript(file, checkout)
    const conversation = tally && finished('claude', sessionId, tally, modified)
    if (conversation) found.push(conversation)
  }
  return found
}

/** Null when the transcript was had in another directory: two paths can share a slug. */
async function readClaudeTranscript(file: string, checkout: string): Promise<Tally | null> {
  const tally: Tally = { messages: 0 }
  // A reply streams as several lines under one message id.
  const replies = new Set<string>()
  let elsewhere = false
  await eachLine(file, (entry) => {
    if (typeof entry.cwd === 'string' && tally.cwd === undefined) {
      tally.cwd = entry.cwd
      if (entry.cwd !== checkout) {
        elsewhere = true
        return false
      }
    }
    noteTime(tally, entry.timestamp)
    if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') tally.title = entry.customTitle
    if (entry.type === 'summary' && typeof entry.summary === 'string') tally.summary = entry.summary
    if (entry.isSidechain === true) return true
    const message = record(entry.message)
    if (entry.type === 'user' && entry.isMeta !== true) {
      const text = promptText(message?.content)
      if (text !== null && !isCommandEcho(text)) {
        tally.messages += 1
        tally.prompt ??= text
      }
    } else if (entry.type === 'assistant') {
      if (typeof message?.id === 'string') replies.add(message.id)
      else tally.messages += 1
    }
    return true
  })
  if (elsewhere || tally.cwd === undefined) return null
  tally.messages += replies.size
  return tally
}

async function codexConversations(checkout: string, sessions: string): Promise<AgentConversation[]> {
  // The rollout's first line carries the cwd; searched as text before anything is parsed.
  const wanted = `"cwd":${JSON.stringify(checkout)}`
  const found: AgentConversation[] = []
  let examined = 0
  for (const file of rolloutFiles(sessions)) {
    examined += 1
    if (examined > MAX_ROLLOUTS_SEARCHED || found.length >= MAX_CONVERSATIONS) break
    if (!head(file).includes(wanted)) continue
    const read = await readCodexRollout(file, checkout)
    if (read === null) continue
    const modified = await stat(file).then(
      (info) => info.mtimeMs,
      () => 0
    )
    const conversation = finished('codex', read.sessionId, read.tally, modified)
    if (conversation) found.push(conversation)
  }
  return found
}

async function readCodexRollout(file: string, checkout: string): Promise<{ sessionId: string; tally: Tally } | null> {
  const events: Tally = { messages: 0 }
  // Older rollouts carry no events; their message items stand in, less the injected context.
  const items: Tally = { messages: 0 }
  let sessionId: string | undefined
  await eachLine(file, (entry) => {
    const payload = record(entry.payload)
    noteTime(events, entry.timestamp)
    if (entry.type === 'session_meta') {
      if (payload?.cwd !== checkout || typeof payload.id !== 'string') return false
      sessionId = payload.id
      return true
    }
    if (entry.type === 'event_msg' && typeof payload?.message === 'string') {
      if (payload.type === 'user_message') {
        events.messages += 1
        events.prompt ??= payload.message
      } else if (payload.type === 'agent_message') {
        events.messages += 1
      }
    }
    if (entry.type === 'response_item' && payload?.type === 'message') {
      const text = promptText(payload.content)
      if (text !== null && !text.startsWith('<')) {
        items.messages += 1
        if (payload.role === 'user') items.prompt ??= text
      }
    }
    return true
  })
  if (sessionId === undefined || !isUsableFileName(sessionId)) return null
  const tally = events.messages > 0 ? events : { ...items, updatedAt: events.updatedAt }
  return { sessionId, tally }
}

/** The listing's entry, or null for a conversation nobody ever prompted. */
function finished(
  agent: AgentConversation['agent'],
  sessionId: string,
  tally: Tally,
  modified: number
): AgentConversation | null {
  const prompt = tally.prompt === undefined ? '' : oneLine(tally.prompt)
  if (prompt.length === 0) return null
  const title = tally.title ?? tally.summary
  const named = title === undefined ? '' : oneLine(title)
  return {
    agent,
    sessionId,
    ...(named.length === 0 ? {} : { title: named }),
    prompt,
    updatedAt: tally.updatedAt ?? modified,
    messages: tally.messages
  }
}

/** Each line parsed as an object; `visit` returns false to stop reading. */
async function eachLine(file: string, visit: (entry: Record<string, unknown>) => boolean): Promise<void> {
  const stream = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const text of lines) {
      if (text.length === 0) continue
      let entry: unknown
      try {
        entry = JSON.parse(text)
      } catch {
        // A line cut short by a crash mid-write.
        continue
      }
      const parsed = record(entry)
      if (parsed !== null && !visit(parsed)) break
    }
  } catch {
    // Deleted or unreadable mid-read: what was read stands.
  } finally {
    lines.close()
    stream.destroy()
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function noteTime(tally: Tally, timestamp: unknown): void {
  if (typeof timestamp !== 'string') return
  const at = Date.parse(timestamp)
  if (Number.isFinite(at) && (tally.updatedAt === undefined || at > tally.updatedAt)) tally.updatedAt = at
}

/** The words a person typed, or null for a turn that carries only tool results. */
function promptText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const texts = content
    .map((block) => record(block))
    .filter((block) => block !== null && (block.type === 'text' || block.type === 'input_text'))
    .map((block) => (typeof block?.text === 'string' ? block.text : ''))
  return texts.length === 0 ? null : texts.join('\n')
}

/** Slash commands and their output, which Claude Code writes as user turns. */
function isCommandEcho(text: string): boolean {
  return /^<(command-|local-command-|bash-)/.test(text.trimStart())
}

function oneLine(text: string): string {
  const first = text
    .split('\n')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .find((part) => part.length > 0)
  if (first === undefined) return ''
  return first.length <= PROMPT_CHARS ? first : `${first.slice(0, PROMPT_CHARS - 1)}…`
}
