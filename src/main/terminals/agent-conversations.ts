// Whether the conversation a pane is about to ask for is on this machine.
//
// A restored agent pane asks its CLI to resume a session id, and that question
// has exactly one right answer ahead of time: is there anything written under
// that id? This app used to answer it from what it had watched the pane do —
// somebody typed into it, so there is probably a conversation — and that
// inference is optimistic in a way a worktree makes routine. Every worktree is
// a directory Claude Code has never seen, so the first launch in one puts up
// "Is this a project you trust?", with "No, exit" selected. An arrow key or an
// Enter at that gate is a keystroke, and the pane wrote down that somebody had
// typed; it is not a conversation, and the agent's store stays empty. The pane
// came back the next launch asking for a session that was never written.
//
// So the question is asked of the store instead. Every one of these CLIs keeps
// its conversations in a directory under the user's home, and the file is
// written when there is something to write rather than when the agent starts —
// observed, not assumed: a `claude` started in a fresh directory, trusted, and
// left alone for a minute leaves nothing in `~/.claude/projects` at all.
//
// Three answers rather than two. `absent` is this file having looked in a store
// it can read and found nothing, which is a fact worth acting on. `unknown` is
// every case where it cannot look — an agent whose store this does not know, a
// store that is not on this disk, a search too large to finish — and it means
// the caller should fall back to what it knew before rather than take a resume
// away on the strength of a directory this file could not find.
//
// Everything here reads. The other way to stop a pane losing a conversation at
// that trust gate is to answer the gate for it — Claude Code records a trusted
// directory in `~/.claude.json` under `projects[<cwd>].hasTrustDialogAccepted`,
// and this app could write that for a worktree it created from a checkout the
// user had already added. It is deliberately not done. That file is another
// tool's live configuration: it is rewritten by every session that tool runs,
// with no protocol for a second writer, so a read-modify-write from here is a
// race against a file full of things this app knows nothing about — and the
// thing at stake, whether a user trusts a directory enough to let an agent run
// in it, is exactly the kind of answer worth being asked for rather than
// assumed. Reading a file to find out what is true costs nobody anything;
// writing one to make something true is a different act.

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
 * Claude Code's name for a directory inside its store: the absolute path with
 * every `/` and every `.` turned into `-`.
 *
 * Read off this machine rather than guessed at — `/Users/abd/repos/teamree` is
 * kept under `-Users-abd-repos-teamree`, and a worktree under a dot-directory,
 * `/Users/abd/.teamree/worktrees/x`, under `-Users-abd--teamree-worktrees-x`,
 * which is the pair that pins the rule down: the separator and the dot both
 * become a dash, and the double dash is the two of them meeting rather than any
 * escaping.
 *
 * A guess at this rule is cheap to make and expensive to be wrong about: a slug
 * that does not match names a directory that does not exist, which reads as "no
 * conversation" for every pane. Hence `agent-conversations.test.ts`, which
 * checks it against a path carrying both characters.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, '-')
}

/**
 * Where an agent keeps its conversations, honouring the variable that moves it.
 *
 * Both CLIs let a user point their whole configuration somewhere else, and a
 * user who has done that has no conversations under their home directory at
 * all. Reading the variable is the difference between finding their store and
 * concluding they have never spoken to an agent.
 */
function storeRoot(home: string, override: string | undefined, directory: string): string {
  const configured = override?.trim()
  return configured !== undefined && configured.length > 0 ? configured : path.join(home, directory)
}

/**
 * A session id this file is willing to build a filename out of.
 *
 * Narrower than `isUsableSessionId`, which vets what may go on a command line:
 * a separator or a `..` is harmless in an argument and is a path traversal
 * here. Both agents mint UUIDs, so nothing legitimate is turned away.
 */
function isUsableFileName(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value) && value.length <= 128
}

/**
 * Whether the conversation this pane would resume is on this disk.
 *
 * `home` is a parameter so the tests can point the whole question at a
 * directory they built, which is the only way to exercise the real slug and the
 * real filenames rather than a mock of them.
 */
export function conversationOnDisk(question: ConversationQuestion, home: string = os.homedir()): ConversationEvidence {
  // Resolved first, because both stores are keyed by the directory the agent
  // itself was in, and an agent asks the operating system where it is — which
  // answers with the symlinks followed. A worktree reached through `/tmp` on a
  // Mac is `/private/tmp` to the process running in it, and the two spell
  // different slugs: the unresolved one would name a directory that does not
  // exist and read as "no conversation" for every pane under it.
  const asked = { ...question, cwd: resolved(question.cwd) }
  if (asked.agent === 'claude') return claudeConversation(asked, home)
  if (asked.agent === 'codex') return codexConversation(asked, home)
  // gemini, opencode and droid. Each keeps its sessions somewhere, and this
  // file does not know where with enough confidence to call a missing file
  // proof of a missing conversation — the wrong directory and every pane loses
  // its resume. Their panes keep the answer the app had before this existed:
  // whether anybody ever typed into them. Say so out loud rather than let it
  // read as an oversight; adding one is a matter of finding its store and
  // checking the shape of it against a real file, as the two above were.
  return 'unknown'
}

/**
 * `~/.claude/projects/<slug of cwd>/<session id>.jsonl`, which is one file per
 * conversation and nothing else.
 *
 * Without an id — an agent pane that was resumed by "the last session here" —
 * the question becomes whether the directory holds any conversation at all,
 * which is exactly what `--continue` would go looking for.
 */
function claudeConversation(question: ConversationQuestion, home: string): ConversationEvidence {
  // No store at all: this machine may never have run Claude Code, or it keeps
  // it somewhere this does not know about. Either way nothing has been proved.
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

/**
 * The one file a resume of this session would read.
 *
 * Exported so a test can write a conversation where the real thing would have
 * written it, rather than where a test thinks it might.
 */
export function claudeTranscriptPath(cwd: string, sessionId: string, home: string = os.homedir()): string {
  return path.join(claudeProjectDirectory(cwd, home), `${sessionId}.jsonl`)
}

/** The path with its symlinks followed, or the path itself if it is not there. */
function resolved(cwd: string): string {
  try {
    return realpathSync(cwd)
  } catch {
    // A checkout on an unmounted volume, or one that has been moved. The
    // literal path is the best guess left and is right whenever nothing in it
    // was a link.
    return cwd
  }
}

/**
 * `~/.codex/sessions/<year>/<month>/<day>/rollout-<timestamp>-<id>.jsonl`, one
 * file per session, laid out by the day it started.
 *
 * Nothing here pins a codex id — its CLI has no flag for it — so in practice
 * the question arrives without one and is answered the way codex's own picker
 * answers it: by the directory the session ran in, which every rollout records
 * in its first line. `codex resume` filters by cwd unless it is asked not to,
 * so "is there a session here" is the same question the resume will ask.
 */
function codexConversation(question: ConversationQuestion, home: string): ConversationEvidence {
  const sessions = path.join(storeRoot(home, process.env.CODEX_HOME, '.codex'), 'sessions')
  if (!existsSync(sessions)) return 'unknown'

  const sessionId = question.agentSessionId
  if (sessionId !== undefined && !isUsableFileName(sessionId)) return 'unknown'
  // The head of the file, where the `session_meta` line carries the cwd. Read as
  // bytes and searched as text: the line runs to several kilobytes of standing
  // instructions after the part that matters, and none of that has to be parsed
  // to answer a yes-or-no question about the first two hundred of them.
  const wanted = `"cwd":${JSON.stringify(question.cwd)}`

  let examined = 0
  for (const file of rolloutFiles(sessions)) {
    examined += 1
    // A store big enough to make this a scan is a store this should stop
    // reading. Saying "unknown" hands the pane back to the heuristic it had
    // before, which is the honest answer to a question this gave up on.
    if (examined > MAX_ROLLOUTS_SEARCHED) return 'unknown'
    if (sessionId !== undefined) {
      if (path.basename(file).endsWith(`-${sessionId}.jsonl`)) return 'present'
      continue
    }
    if (head(file).includes(wanted)) return 'present'
  }
  return 'absent'
}

/**
 * How many rollout files are worth looking at before a startup is being slowed
 * down. One cap for both searches above, which cost different amounts — a name
 * is matched without opening anything — because the number that matters is the
 * one that keeps the expensive one quick, and a second, looser cap for the
 * cheap one would be a number nothing could justify.
 */
const MAX_ROLLOUTS_SEARCHED = 500

/** Enough of a rollout's first line to carry the cwd, which sits near its front. */
const ROLLOUT_HEAD_BYTES = 4096

/**
 * Every rollout under a sessions directory, newest day first.
 *
 * Newest first because the session a pane is asking about is nearly always one
 * of the last few, and the cap above is reached by the panes that have nothing
 * — so the order decides whether the common case reads one file or five hundred.
 * Lazy for the same reason: the caller stops at the first match.
 */
function* rolloutFiles(directory: string): Generator<string> {
  for (const entry of listing(directory).sort().reverse()) {
    const full = path.join(directory, entry)
    if (entry.endsWith('.jsonl')) {
      if (entry.startsWith('rollout-')) yield full
      continue
    }
    // Year, month, day: recursed into rather than assumed, so a layout that
    // gains or loses a level keeps working.
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
    // Deleted between the listing and the open, or unreadable. One file that
    // cannot be read says nothing about the rest of the store.
    return ''
  } finally {
    if (handle !== undefined) closeSync(handle)
  }
}
