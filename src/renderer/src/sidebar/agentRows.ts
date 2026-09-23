// What each agent in a worktree is doing, for the sidebar.
//
// This is the question the app exists to answer and did not: with five agents
// running, which of them needs you. Git chips cannot say — a worktree whose
// agent finished twenty minutes ago and one whose agent is mid-edit look
// identical through them.
//
// What is knowable here is deliberately narrower than what a reader might want.
// Teamree watches a PTY, not an agent's protocol, so there is no "thinking" and
// no "waiting for permission" — only whether bytes are still arriving, and how
// the process ended. Every state below is one of those two facts, and none of
// them is a guess dressed up as a reading.

import type { AgentKind, PaneWatcher, Terminal } from '@shared/entities'

export type AgentActivity =
  /** Output is still arriving. */
  | 'working'
  /** Running, but it has stopped saying things — which is what waiting looks like. */
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
  /**
   * The last line the pane printed that is worth showing, or null when there is
   * none. It is a quotation, not a reading: "running tests" on a row means the
   * pane printed those words, not that teamree knows tests are running.
   */
  evidence: string | null
}

/**
 * One phrase per state, wherever a state is spelled out to a reader.
 *
 * Here rather than in a component because the sidebar and the dashboard both
 * say these words, and two files describing the same four states is how an app
 * ends up calling one of them two different things.
 */
export const ACTIVITY_LABEL: Record<AgentActivity, string> = {
  working: 'working',
  quiet: 'waiting — no output',
  done: 'finished',
  failed: 'exited with an error'
}

/**
 * Whose eyes are on a pane, in words rather than as a number.
 *
 * Here with the rest of the phrases, because the sidebar and anything else that
 * ever says this must say it the same way — and because "2 watching" tells an
 * owner that something is happening without telling them the half that
 * matters, which is who.
 */
export function watchedBy(watchers: readonly PaneWatcher[]): string {
  const who = listOf(watchers.map((watcher) => watcher.handle))
  return who === '' ? 'nobody is watching' : `${who}watching`
}

/**
 * Whose keystrokes are landing in a pane, right now, in the same words.
 *
 * The present tense is the whole point and is why the caller has to have
 * filtered by the clock first: this is the sentence that stands between a
 * teammate running something as the owner and the owner not knowing it
 * happened, and it must never be shown about somebody who has stopped.
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

/** The one-word form, for counts and column headings. */
export const ACTIVITY_NOUN: Record<AgentActivity, string> = {
  working: 'working',
  quiet: 'waiting',
  done: 'finished',
  failed: 'failed'
}

/**
 * The two facts an activity is read from, and nothing else.
 *
 * Narrower than `Terminal` so a teammate's pane — which crosses the wire as
 * metadata and has no cwd, no columns and no scrollback — is read by this
 * function rather than by a second one written to agree with it.
 */
export type PaneActivitySource = { running: boolean; exitCode?: number; busy: boolean }

export function activityOf(terminal: PaneActivitySource): AgentActivity {
  if (!terminal.running) return terminal.exitCode === 0 ? 'done' : 'failed'
  return terminal.busy ? 'working' : 'quiet'
}

/**
 * The rows for one worktree, in the order their panes were opened.
 *
 * Plain shells are included. A terminal someone left a build running in is as
 * much a thing that might want attention as an agent is, and hiding it would
 * make the count on the row disagree with what is actually open.
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

/**
 * Everything a pane's name can be read from: the name somebody gave it, the
 * agent it runs, and the two raw facts underneath both.
 *
 * A teammate's pane is exactly these fields minus the first, which is why they
 * are listed rather than a `Terminal` being asked for.
 */
export type PaneNameSource = { label?: string; agent?: AgentKind; title: string; shell: string }

/**
 * What one pane is called, in order of who said it.
 *
 * The name a person typed beats the program's own, because the program's own
 * is what made this necessary: three agents started on three approaches all
 * call themselves `claude`, and a sidebar that answers "which of these is the
 * auth refactor" with the binary's name is answering a question nobody asked.
 */
export function paneName(pane: PaneNameSource): string {
  const label = pane.label?.trim()
  if (label !== undefined && label.length > 0) return label
  return pane.agent ?? paneLabel(pane)
}

/**
 * The names for one worktree's panes, disambiguated against each other.
 *
 * Two panes reading `claude` are the gap this whole file is about, and a name
 * that does not tell two things apart is not a name. So panes that would read
 * identically and were named by nobody get an index — `claude 1`, `claude 2` —
 * counted only among themselves.
 *
 * Panes a person named are left exactly as they typed them, duplicates
 * included. Numbering somebody's own words back at them would be the app
 * overruling the one thing on the row it did not make up.
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
 * How much of a name a row draws.
 *
 * Applied where the name is drawn and nowhere else: a pane started from a
 * three-line task description is called that, in the record and in the
 * tooltip, and the strip along the top is merely narrow. Shortening it on the
 * way in would make the app forget what it was told to stay inside a CSS box.
 */
export const PANE_NAME_MAX_CHARS = 32

export function truncateName(name: string, maxChars: number = PANE_NAME_MAX_CHARS): string {
  return name.length <= maxChars ? name : `${name.slice(0, maxChars - 1).trimEnd()}…`
}

/**
 * What to call a pane with no agent in it.
 *
 * Takes the title and the shell rather than a `Terminal`, because a teammate's
 * pane arrives as exactly those two facts: the rule for turning them into a
 * name lives here once, on the reading machine, instead of being applied by the
 * owner and shipped as a string the reader cannot check.
 *
 * A program's own title is the best name it will ever have, except for the one
 * a plain shell sets: bash's default is the user, the host and the path, which
 * is long, changes as you cd, and repeats what the worktree row above already
 * says. The shell's own name is shorter and no less informative.
 */
export function paneLabel(terminal: { title: string; shell: string }): string {
  const title = terminal.title.trim()
  if (title.length === 0 || isDefaultShellTitle(title)) return shellName(terminal.shell)
  // A title that is only a path carries its information at the end — exactly
  // the end a one-line row ellipsises away.
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
 * What the worktree as a whole is doing, for the collapsed row.
 *
 * Ordered by what would make someone look: anything failed outranks anything
 * working, because a failure is finished and wrong while work in progress is
 * merely unfinished.
 */
export function worktreeActivity(rows: readonly AgentRow[]): AgentActivity | null {
  if (rows.length === 0) return null
  if (rows.some((row) => row.activity === 'failed')) return 'failed'
  if (rows.some((row) => row.activity === 'working')) return 'working'
  if (rows.some((row) => row.activity === 'quiet')) return 'quiet'
  return 'done'
}

/**
 * How long since anything happened, in the shortest form that is still true.
 *
 * Rounded down on purpose: "4m" while the fifth minute is running reads as
 * less stale than it is, which is the wrong way round for a number whose whole
 * job is to tell you something has been sitting there.
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
