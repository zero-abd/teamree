// Whether the conversation a pane is about to ask for is on this machine, asked
// of the agent's own store (written when there is something to write, not at
// start). Everything here reads: `~/.claude.json`'s trust flag is never written.

import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentKind } from './agent-command'

/** What this file can say about a conversation: it is there, it is not, or it cannot tell. */
export type ConversationEvidence = 'present' | 'absent' | 'unknown'

/** As much of a terminal's record as the question needs. */
export type ConversationQuestion = {
  agent: AgentKind
  cwd: string
  /** The id we pinned at launch, where the agent let us choose one. */
  agentSessionId?: string
}

/**
 * Claude Code's name for a directory inside its store: every `/` and `.` turned
 * into `-`, observed (`/Users/abd/.teamree/x` -> `-Users-abd--teamree-x`).
 * A wrong slug reads as "no conversation" for every pane.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, '-')
}

/** Where an agent keeps its conversations, honouring the variable that moves it. */
function storeRoot(home: string, override: string | undefined, directory: string): string {
  const configured = override?.trim()
  return configured !== undefined && configured.length > 0 ? configured : path.join(home, directory)
}

/**
 * A session id this file is willing to build a filename out of. Narrower than
 * `isUsableSessionId`: a separator or `..` is a path traversal here.
 */
function isUsableFileName(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value) && value.length <= 128
}

/** Whether the conversation this pane would resume is on this disk. `home` is a test seam. */
export function conversationOnDisk(question: ConversationQuestion, home: string = os.homedir()): ConversationEvidence {
  // Both stores are keyed by the cwd the agent saw, symlinks followed: `/tmp`
  // on a Mac is `/private/tmp` to the process, and the two spell different slugs.
  const asked = { ...question, cwd: resolved(question.cwd) }
  if (asked.agent === 'claude') return claudeConversation(asked, home)
  if (asked.agent === 'codex') return codexConversation(asked, home)
  // gemini, opencode and droid: their stores are not known well enough to call
  // a missing file proof of a missing conversation.
  return 'unknown'
}

/**
 * `~/.claude/projects/<slug of cwd>/<session id>.jsonl`, one file per
 * conversation. Without an id the question is what `--continue` would ask.
 */
function claudeConversation(question: ConversationQuestion, home: string): ConversationEvidence {
  // No store at all proves nothing.
  if (!existsSync(claudeStoreRoot(home))) return 'unknown'

  const sessionId = question.agentSessionId
  if (sessionId !== undefined) {
    if (!isUsableFileName(sessionId)) return 'unknown'
    return existsSync(claudeTranscriptPath(question.cwd, sessionId, home)) ? 'present' : 'absent'
  }
  return listing(claudeProjectDirectory(question.cwd, home)).some((entry) => entry.endsWith('.jsonl'))
    ? 'present'
    : 'absent'
}

function claudeStoreRoot(home: string): string {
  return storeRoot(home, process.env.CLAUDE_CONFIG_DIR, '.claude')
}

/** Where Claude Code keeps every conversation had in one directory. */
export function claudeProjectDirectory(cwd: string, home: string = os.homedir()): string {
  return path.join(claudeStoreRoot(home), 'projects', claudeProjectSlug(resolved(cwd)))
}

/** The one file a resume of this session would read. Exported for tests. */
export function claudeTranscriptPath(cwd: string, sessionId: string, home: string = os.homedir()): string {
  return path.join(claudeProjectDirectory(cwd, home), `${sessionId}.jsonl`)
}

/** The path with its symlinks followed, or the path itself if it is not there. */
function resolved(cwd: string): string {
  try {
    return realpathSync(cwd)
  } catch {
    // Unmounted or moved; the literal path is the best guess left.
    return cwd
  }
}

/**
 * `~/.codex/sessions/<year>/<month>/<day>/rollout-<timestamp>-<id>.jsonl`. The
 * codex CLI has no flag to pin an id, so the question is usually answered by
 * cwd, which every rollout records in its first line and `codex resume` filters on.
 */
function codexConversation(question: ConversationQuestion, home: string): ConversationEvidence {
  const sessions = path.join(storeRoot(home, process.env.CODEX_HOME, '.codex'), 'sessions')
  if (!existsSync(sessions)) return 'unknown'

  const sessionId = question.agentSessionId
  if (sessionId !== undefined && !isUsableFileName(sessionId)) return 'unknown'
  // The `session_meta` line carries the cwd near its front; searched as text, not parsed.
  const wanted = `"cwd":${JSON.stringify(question.cwd)}`

  let examined = 0
  for (const file of rolloutFiles(sessions)) {
    examined += 1
    // A store big enough to make this a scan hands the pane back to the heuristic.
    if (examined > MAX_ROLLOUTS_SEARCHED) return 'unknown'
    if (sessionId !== undefined) {
      if (path.basename(file).endsWith(`-${sessionId}.jsonl`)) return 'present'
      continue
    }
    if (head(file).includes(wanted)) return 'present'
  }
  return 'absent'
}

/** How many rollout files are worth looking at before a startup is being slowed down. */
const MAX_ROLLOUTS_SEARCHED = 500

/** Enough of a rollout's first line to carry the cwd, which sits near its front. */
const ROLLOUT_HEAD_BYTES = 4096

/**
 * Every rollout under a sessions directory, newest day first and lazy: the
 * session asked about is nearly always recent, and the caller stops at the first match.
 */
function* rolloutFiles(directory: string): Generator<string> {
  for (const entry of listing(directory).sort().reverse()) {
    const full = path.join(directory, entry)
    if (entry.endsWith('.jsonl')) {
      if (entry.startsWith('rollout-')) yield full
      continue
    }
    // Year, month, day: recursed into rather than assumed.
    yield* rolloutFiles(full)
  }
}

/** A directory's entries, or none — a store that is not there is not an error here. */
function listing(directory: string): string[] {
  try {
    return readdirSync(directory)
  } catch {
    return []
  }
}

/** The first `ROLLOUT_HEAD_BYTES` of a file, as text. */
function head(file: string): string {
  let handle: number | undefined
  try {
    handle = openSync(file, 'r')
    const buffer = Buffer.alloc(ROLLOUT_HEAD_BYTES)
    const read = readSync(handle, buffer, 0, ROLLOUT_HEAD_BYTES, 0)
    return buffer.subarray(0, read).toString('utf8')
  } catch {
    // Deleted between the listing and the open, or unreadable.
    return ''
  } finally {
    if (handle !== undefined) closeSync(handle)
  }
}
