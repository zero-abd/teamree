// What each agent in a worktree is doing, for the sidebar. Teamree watches a
// PTY, not an agent's protocol: the readings are bytes arriving, how the process
// ended, the title, the bell, and — outranking all of them — what the agent's hooks report.

import type { AgentEvent, AgentKind, PaneWatcher, Terminal } from '@shared/entities'
import type { TitleOpinion } from '@shared/titleOpinion'

export type AgentActivity =
  /** The pane has said it wants something: it rang the bell, or its title says so. */
  | 'waiting'
  /** Output is still arriving. */
  | 'working'
  /** Running, but it has stopped saying things, and has said nothing about why. */
  | 'quiet'
  /** Exited cleanly. */
  | 'done'
  /** Exited with a non-zero status, or on a signal. */
  | 'failed'

export type AgentRow = {
  terminalId: string
  /** The agent, when the pane runs one; absent for a plain shell. */
  agent: AgentKind | undefined
  /** What to call it: the agent's name, or the terminal's own title. */
  label: string
  activity: AgentActivity
  /** Milliseconds since output last arrived. */
  quietFor: number
  /** The last line worth showing, or null. A quotation, not a reading. */
  evidence: string | null
}

/** One phrase per state, shared by the sidebar and the dashboard. */
export const ACTIVITY_LABEL: Record<AgentActivity, string> = {
  waiting: 'waiting on you',
  working: 'working',
  // Not "waiting — no output": beside `waiting on you` the two opposite
  // states began with the same word.
  quiet: 'quiet — no output',
  done: 'finished',
  failed: 'exited with an error'
}

/** Whose eyes are on a pane, by name: "2 watching" leaves out the half that matters. */
export function watchedBy(watchers: readonly PaneWatcher[]): string {
  const who = listOf(watchers.map((watcher) => watcher.handle))
  return who === '' ? 'nobody is watching' : `${who}watching`
}

/**
 * Whose keystrokes are landing in a pane, right now. The caller must filter by
 * the clock first: this must never be shown about somebody who has stopped.
 */
export function typedBy(typists: readonly { handle: string }[]): string {
  const who = listOf(typists.map((typist) => typist.handle))
  return who === '' ? 'nobody is typing' : `${who}typing`
}

/** "ana is", "ana and bo are", "" — the half of a sentence both phrases share. */
function listOf(handles: readonly string[]): string {
  if (handles.length === 0) return ''
  if (handles.length === 1) return `${handles[0]} is `
  const last = handles[handles.length - 1]
  return `${handles.slice(0, -1).join(', ')} and ${last} are `
}

/**
 * The one-word form, for counts and column headings. `waiting` is nouned
 * "asking" because `quiet` already has "waiting".
 */
export const ACTIVITY_NOUN: Record<AgentActivity, string> = {
  waiting: 'asking',
  working: 'working',
  quiet: 'waiting',
  done: 'finished',
  failed: 'failed'
}

/**
 * The facts an activity is read from. Narrower than `Terminal` so a teammate's
 * pane, which crosses the wire as metadata, is read by the same function.
 */
export type PaneActivitySource = {
  running: boolean
  exitCode?: number
  busy: boolean
  /** What the pane's own title says, when it says anything. */
  titleSays?: TitleOpinion
  /** When the bell last rang, if it rang in the burst of output that just ended. */
  lastBellAt?: number
  /** What the agent last reported about itself, when it reports at all. */
  agentEvent?: AgentEvent
}

/**
 * Notification types about the agent rather than aimed at you. An unknown type
 * is read as a request: a request missed is worse than a needless glance.
 */
const NOT_A_REQUEST = new Set([
  'auth_success',
  'agent_completed',
  'quota_auto_resume_fired',
  'quota_auto_resume_stale',
  'quota_auto_resume_disabled'
])

/**
 * What the agent's last word says the pane is doing, or null. `UserPromptSubmit`
 * stands however long the pane is silent: a model call prints nothing.
 */
export function agentSays(event: AgentEvent | undefined): AgentActivity | null {
  if (event === undefined) return null
  switch (event.event) {
    case 'Notification':
      return event.detail !== undefined && NOT_A_REQUEST.has(event.detail) ? null : 'waiting'
    case 'UserPromptSubmit':
      return 'working'
    case 'Stop':
    case 'SessionStart':
    case 'SessionEnd':
      return 'quiet'
  }
}

/**
 * The order is the argument: exit, then the agent's own word, then a title
 * saying waiting (an agent can print its question and sit on it), then the bell,
 * then the readings of silence. A stale "working" title ranks below the bell on purpose.
 */
export function activityOf(terminal: PaneActivitySource): AgentActivity {
  if (!terminal.running) return terminal.exitCode === 0 ? 'done' : 'failed'
  const said = agentSays(terminal.agentEvent)
  if (said !== null) return said
  if (terminal.titleSays === 'waiting') return 'waiting'
  if (terminal.busy) return 'working'
  if (terminal.lastBellAt !== undefined) return 'waiting'
  return terminal.titleSays === 'working' ? 'working' : 'quiet'
}

/**
 * The rows for one worktree, in the order their panes were opened. Plain
 * shells included, or the count on the row disagrees with what is open.
 */
export function agentRows(
  terminals: readonly Terminal[],
  worktreeId: string,
  now: number,
  evidence: Readonly<Record<string, string | null>> = {}
): AgentRow[] {
  const mine = terminals.filter((terminal) => terminal.worktreeId === worktreeId)
  const names = paneNames(mine)
  return mine.map((terminal, index) => ({
    terminalId: terminal.id,
    agent: terminal.agent,
    label: names[index] ?? paneName(terminal),
    activity: activityOf(terminal),
    quietFor: Math.max(0, now - terminal.lastOutputAt),
    evidence: evidence[terminal.id] ?? null
  }))
}

/** Everything a pane's name can be read from; a teammate's pane is these fields minus the first. */
export type PaneNameSource = { label?: string; agent?: AgentKind; title: string; shell: string }

/**
 * What one pane is called, in order of who said it: a typed name beats the
 * program's own, since three agents on three approaches all call themselves `claude`.
 */
export function paneName(pane: PaneNameSource): string {
  const label = pane.label?.trim()
  if (label !== undefined && label.length > 0) return label
  return pane.agent ?? paneLabel(pane)
}

/**
 * The names for one worktree's panes, disambiguated: unnamed duplicates get an
 * index counted among themselves; names a person typed are left exactly as typed.
 */
export function paneNames(panes: readonly PaneNameSource[]): string[] {
  const names = panes.map(paneName)
  const chosen = panes.map((pane) => (pane.label?.trim() ?? '').length > 0)
  const totals = new Map<string, number>()
  for (const [index, name] of names.entries()) {
    if (chosen[index]) continue
    totals.set(name, (totals.get(name) ?? 0) + 1)
  }

  const seen = new Map<string, number>()
  return names.map((name, index) => {
    if (chosen[index] || (totals.get(name) ?? 0) < 2) return name
    const position = (seen.get(name) ?? 0) + 1
    seen.set(name, position)
    return `${name} ${position}`
  })
}

/**
 * How much of a name a row draws. Applied where it is drawn and nowhere else:
 * the record and the tooltip keep the whole name.
 */
export const PANE_NAME_MAX_CHARS = 32

export function truncateName(name: string, maxChars: number = PANE_NAME_MAX_CHARS): string {
  return name.length <= maxChars ? name : `${name.slice(0, maxChars - 1).trimEnd()}…`
}

/**
 * What to call a pane with no agent in it. A program's own title is the best
 * name it has, except bash's default (user, host, path), which changes as you cd.
 */
export function paneLabel(terminal: { title: string; shell: string }): string {
  const title = terminal.title.trim()
  if (title.length === 0 || isDefaultShellTitle(title)) return shellName(terminal.shell)
  // A path-only title carries its information at the end a one-line row ellipsises away.
  return isPathOnly(title) ? basename(title) : title
}

/** The `\u@\h: \w` title bash and dash write by default. */
function isDefaultShellTitle(title: string): boolean {
  return /^[^\s:@]+@[^\s:@]+:\s*\S*$/.test(title)
}

function isPathOnly(title: string): boolean {
  return /^(?:~|\.{1,2})?[/\\]\S*$/.test(title) || /^[A-Za-z]:\\\S*$/.test(title)
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** `/bin/zsh` and `C:\Windows\System32\cmd.exe` are both just the shell. */
function shellName(shell: string): string {
  return basename(shell.trim()).replace(/\.exe$/i, '') || 'shell'
}

/**
 * What the worktree as a whole is doing, for the collapsed row. Ordered by
 * what would make someone look: failed over waiting over working.
 */
export function worktreeActivity(rows: readonly AgentRow[]): AgentActivity | null {
  if (rows.length === 0) return null
  if (rows.some((row) => row.activity === 'failed')) return 'failed'
  if (rows.some((row) => row.activity === 'waiting')) return 'waiting'
  if (rows.some((row) => row.activity === 'working')) return 'working'
  if (rows.some((row) => row.activity === 'quiet')) return 'quiet'
  return 'done'
}

/**
 * How long since anything happened, in the shortest form that is still true.
 * Rounded down on purpose: a staleness number must never flatter.
 */
export function sinceLabel(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000)
  if (seconds < 10) return 'now'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** The same age as a phrase: "45s ago", "3m ago", and "now", which takes no "ago". */
export function agoLabel(milliseconds: number): string {
  const since = sinceLabel(milliseconds)
  return since === 'now' ? since : `${since} ago`
}
