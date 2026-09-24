// What each agent in a worktree is doing, for the sidebar. Teamree watches a
// PTY, not an agent's protocol: the readings are bytes arriving, how the process
// ended, the title, the bell, and — outranking all of them — what the agent's hooks report.

import type { AgentEvent, AgentKind, PaneWatcher, Terminal } from '@shared/entities'
import { hookQuestion, isAnswerOrHint, type ScreenOpinion } from '@shared/screenOpinion'
import type { TitleOpinion } from '@shared/titleOpinion'
import { harnessName } from '../agents/harnesses'
import { paneInWorktree, worktreeDisplay, type WorktreeNameSource } from './worktreeDisplay'

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
  /** What the row draws beside the glyph; see `paneText`. */
  text: string
  activity: AgentActivity
  /** Milliseconds since output last arrived. */
  quietFor: number
  /** The last line worth showing, or null. A quotation, not a reading. */
  evidence: string | null
}

/** What a dot is coloured: `idle` is a quiet pane with no agent, drawn grey; a stopped agent is hollow. */
export type DotTone = AgentActivity | 'idle'

/** The one word for each tone, wherever a dot is explained: rows, hovers, tabs and the board's legend. */
export const TONE_LABEL: Record<DotTone, string> = {
  failed: 'failed',
  waiting: 'asking',
  working: 'working',
  quiet: 'stopped',
  idle: 'idle',
  done: 'finished'
}

/** The order attention is owed in; the board's legend and its sort. */
export const TONES_BY_ATTENTION: readonly DotTone[] = ['failed', 'waiting', 'working', 'quiet', 'idle', 'done']

export function dotTone(activity: AgentActivity, agent: AgentKind | undefined): DotTone {
  return activity === 'quiet' && agent === undefined ? 'idle' : activity
}

/** The one dot's classes: the tone alone. Unread is the name's weight, never the dot. */
export function dotClass(tone: DotTone | null): string {
  return `activity${tone === null ? '' : ` activity--${tone}`}`
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
 * The facts an activity is read from. Narrower than `Terminal` so a teammate's
 * pane, which crosses the wire as metadata, is read by the same function.
 */
export type PaneActivitySource = {
  agent?: AgentKind
  foregroundAgent?: AgentKind
  running: boolean
  exitCode?: number
  busy: boolean
  /** What the pane's own title says, when it says anything. */
  titleSays?: TitleOpinion
  /** What the bottom of its screen says. */
  screenSays?: ScreenOpinion
  /** When the bell last rang, if it rang in the burst of output that just ended. */
  lastBellAt?: number
  /** What the agent last reported about itself, when it reports at all. */
  agentEvent?: AgentEvent
  tookTurn?: boolean
}

/**
 * Notification types about the agent rather than aimed at you. An unknown type
 * is read as a request: a request missed is worse than a needless glance.
 */
const NOT_A_REQUEST = new Set([
  'auth_success',
  // Claude's reminder that a finished turn is still finished; a hookless agent says nothing, and must read the same.
  'idle_prompt',
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
 * The order is the argument: exit, then the agent's own word, then a title or
 * screen saying waiting (an agent can print its question and sit on it), then the bell,
 * then the readings of silence. A stale "working" title ranks below the bell on purpose.
 */
export function activityOf(terminal: PaneActivitySource): AgentActivity {
  if (!terminal.running) {
    if (terminal.exitCode !== 0) return 'failed'
    // Declining a trust prompt also exits 0; only an agent that took a turn finished one.
    return terminal.tookTurn === false ? 'quiet' : 'done'
  }
  const said = agentSays(terminal.agentEvent)
  if (said !== null) return said
  // A shell rings for a failed tab completion: only an agent can be asking.
  const agent = terminal.agent ?? terminal.foregroundAgent
  if (agent !== undefined && (terminal.titleSays === 'waiting' || terminal.screenSays === 'waiting')) return 'waiting'
  if (terminal.busy) return 'working'
  if (agent !== undefined && terminal.lastBellAt !== undefined) return 'waiting'
  return terminal.titleSays === 'working' ? 'working' : 'quiet'
}

/**
 * The rows for one worktree, in the order their panes were opened. Plain
 * shells included, or the count on the row disagrees with what is open.
 */
export function agentRows(
  terminals: readonly Terminal[],
  worktree: string | (WorktreeNameSource & { id: string }),
  now: number,
  evidence: Readonly<Record<string, string | null>> = {}
): AgentRow[] {
  const worktreeId = typeof worktree === 'string' ? worktree : worktree.id
  const mine = terminals.filter((terminal) => terminal.worktreeId === worktreeId)
  const names = paneNames(mine, typeof worktree === 'string' ? undefined : worktree)
  return mine.map((terminal, index) => {
    const label = names[index] ?? paneName(terminal)
    const activity = activityOf(terminal)
    const line = evidence[terminal.id] ?? null
    return {
      terminalId: terminal.id,
      agent: paneAgent(terminal),
      label,
      text: paneText(terminal, label),
      activity,
      quietFor: Math.max(0, now - terminal.lastOutputAt),
      evidence: activity === 'waiting' ? askingLine(line, terminal.agentEvent) : line
    }
  })
}

/** An asking pane's line: never an answer or a key hint; the hook's words when the screen has nothing better. */
export function askingLine(line: string | null, said: AgentEvent | undefined): string | null {
  if (line !== null && !isAnswerOrHint(line)) return line
  return said?.event === 'Notification' ? hookQuestion(said.message) : null
}

/** Everything a pane's name can be read from; a teammate's pane is these fields minus `foregroundAgent`. */
export type PaneNameSource = {
  label?: string
  agent?: AgentKind
  foregroundAgent?: AgentKind
  title: string
  shell: string
  ordinal?: number
}

/** The agent a pane runs: the one it was started as, else one seen in its foreground. */
export function paneAgent(pane: PaneNameSource): AgentKind | undefined {
  return pane.agent ?? pane.foregroundAgent
}

/** What a row draws beside the glyph: nothing for an agent's own bare name, else the name whole, never a lone number. */
export function paneText(pane: PaneNameSource, name: string): string {
  const agent = paneAgent(pane)
  if (agent === undefined || isNamed(pane)) return name
  return name === harnessName(agent) ? '' : name
}

function isNamed(pane: PaneNameSource): boolean {
  return (pane.label?.trim() ?? '').length > 0
}

/**
 * What one pane is called, in order of who said it: a typed name beats the
 * program's own, since three agents on three approaches all call themselves `claude`. Unnumbered; see `paneNames`.
 */
export function paneName(pane: PaneNameSource): string {
  const label = pane.label?.trim()
  if (label !== undefined && label.length > 0) return label
  const agent = paneAgent(pane)
  return agent === undefined ? paneLabel(pane) : harnessName(agent)
}

/** Whether the name is the program the pane was started as, which its `ordinal` counts; a title or a typed agent is not. */
function hasOwnNumber(pane: PaneNameSource): boolean {
  if (pane.ordinal === undefined || isNamed(pane)) return false
  if (pane.agent !== undefined) return true
  return pane.foregroundAgent === undefined && paneLabel(pane) === shellName(pane.shell)
}

/**
 * One worktree's panes named, in the order they were opened. A task's only agent goes by the task. Of panes
 * of one program, the lowest number goes bare and the rest show theirs; any other name read twice gets the next free.
 */
export function paneNames(panes: readonly PaneNameSource[], worktree?: WorktreeNameSource): string[] {
  const shown = panes.map((pane) => paneInWorktree(pane, worktree))
  const [agent, ...more] = shown.filter((pane) => pane.agent !== undefined)
  const task = worktree?.task?.trim() ? worktreeDisplay(worktree).title : undefined
  const titled = task !== undefined && agent !== undefined && more.length === 0 && !isNamed(agent) ? agent : null
  const numbered = shown.filter(hasOwnNumber)
  const names = shown.map((pane) => {
    if (pane === titled && task !== undefined) return task
    const name = paneName(pane)
    if (!hasOwnNumber(pane)) return name
    const lowest = Math.min(...numbered.filter((other) => paneName(other) === name).map((other) => other.ordinal ?? 1))
    return pane.ordinal === undefined || pane.ordinal <= lowest ? name : `${name} ${pane.ordinal}`
  })
  const fixed = shown.map((pane) => isNamed(pane) || hasOwnNumber(pane) || pane === titled)
  const taken = new Set(names.filter((_name, index) => fixed[index]))
  return names.map((name, index) => {
    if (fixed[index]) return name
    let free = name
    for (let next = 2; taken.has(free); next += 1) free = `${name} ${next}`
    taken.add(free)
    return free
  })
}

/** `paneNames` by terminal id, for a surface that lists the panes in another order than they were opened. */
export function paneNamesById(
  panes: readonly (PaneNameSource & { id: string })[],
  worktree?: WorktreeNameSource
): Record<string, string> {
  const names = paneNames(panes, worktree)
  return Object.fromEntries(panes.map((pane, index) => [pane.id, names[index] ?? paneName(pane)]))
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

/** The collapsed row's dot: idle unless one of its quiet panes runs an agent. */
export function worktreeTone(rows: readonly AgentRow[]): DotTone | null {
  const overall = worktreeActivity(rows)
  if (overall !== 'quiet') return overall
  return rows.some((row) => row.activity === 'quiet' && row.agent !== undefined) ? 'quiet' : 'idle'
}

/** How many panes there are, by the one rule every count follows: terminals the runtime lists, file panes aside. */
export type PaneCount = {
  /** In the worktree on screen: what its Panes tab lists. */
  here: number
  /** In every listed worktree: what the board lists. */
  total: number
  /** How many worktrees those are spread over. */
  worktrees: number
}

export function paneCount(
  terminals: readonly { worktreeId: string }[],
  worktreeIds: readonly string[],
  activeWorktreeId: string | null
): PaneCount {
  const listed = new Set(worktreeIds)
  const counted = terminals.filter((terminal) => listed.has(terminal.worktreeId))
  return {
    here: counted.filter((terminal) => terminal.worktreeId === activeWorktreeId).length,
    total: counted.length,
    worktrees: new Set(counted.map((terminal) => terminal.worktreeId)).size
  }
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
