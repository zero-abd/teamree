// When this person last had each pane in front of them, and what that makes
// unread.
//
// The gap this closes is the one an hour away leaves: the sidebar and the board
// are read the same whether you triaged them a second ago or yesterday, so
// coming back means opening every pane to find out which of them said anything
// while you were gone. Nothing in the workspace file can answer that, because
// nothing in it is about a reader — `lastOutputAt` says when a pane spoke, and
// only this window knows when its owner was listening.
//
// So the record is one number per terminal id: the moment the pane was last in
// front of this person. A pane is unread when it has printed since. That is the
// whole rule, and it is deliberately not a count — how many lines an agent
// printed while you were at lunch is not a thing anybody acts on, and a number
// invites reading it as progress.
//
// Stored in this window's `localStorage`, beside the stored session and on the
// same terms as the sidebar's width: it is a fact about this person at this
// screen rather than about the work, so it has no business in the workspace
// file that a teammate's pull and the CLI both read. The consequence worth
// knowing is that it does not follow you to another machine, which is the same
// bargain `preferences.ts` already makes.

import type { Layout, Terminal } from '@shared/entities'
import { collectTerminalIds, shownRoot } from '../panes/paneLayout'

/** When each pane was last in front of this person, by terminal id. */
export type PaneSeen = Record<string, number>

const STORAGE_KEY = 'teamree.workspace.paneSeen'

/** More panes than a window has ever held; the oldest go first past it. */
const MAX_SEEN_PANES = 256

/**
 * How often a pane that is being looked at writes down that it is.
 *
 * The rule below already refuses to call the pane in front unread, so this is
 * not what keeps the pip off it while somebody watches an agent work. It is
 * what makes the record survive: focus leaving writes the time, and a window
 * that is quit — or killed — with a pane still focused never has focus leave.
 * Half a minute is the most staleness that can cost.
 */
export const SEEN_DEBOUNCE_MS = 30_000

export function readPaneSeen(storage: Pick<Storage, 'getItem'> | undefined): PaneSeen {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    if (raw === null || raw === undefined) return {}
    const record: unknown = JSON.parse(raw)
    if (typeof record !== 'object' || record === null || Array.isArray(record)) return {}
    const seen: PaneSeen = {}
    for (const [terminalId, at] of Object.entries(record)) {
      if (typeof at === 'number' && Number.isFinite(at) && at > 0) seen[terminalId] = at
    }
    return seen
  } catch {
    // A private window, cleared site data, or a record this version cannot
    // read. Nothing remembered is a state this app has to work in anyway — it
    // is what every pane is in the first second of the first launch.
    return {}
  }
}

export function writePaneSeen(storage: Pick<Storage, 'setItem'> | undefined, seen: PaneSeen): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(newest(seen)))
  } catch {
    // Storage can be full or blocked. Forgetting which panes had been read is
    // not worth failing the click that read one.
  }
}

/** The most recently seen panes, so a long-lived window cannot grow this
 *  record without end. The ones dropped are the ones nobody has looked at for
 *  longest, which are the ones whose absence changes least. */
function newest(seen: PaneSeen): PaneSeen {
  const entries = Object.entries(seen)
  if (entries.length <= MAX_SEEN_PANES) return seen
  entries.sort(([, one], [, other]) => other - one)
  return Object.fromEntries(entries.slice(0, MAX_SEEN_PANES))
}

/**
 * The record with these panes seen now.
 *
 * Returns what it was given when there is nothing to write, because the store
 * holds this and a new object on every beat of a clock is a re-render of the
 * sidebar, the strip and the board for a fact that did not change.
 */
export function markSeen(seen: PaneSeen, terminalIds: readonly string[], now: number): PaneSeen {
  const fresh = terminalIds.filter((terminalId) => seen[terminalId] !== now)
  if (fresh.length === 0) return seen
  const next = { ...seen }
  for (const terminalId of fresh) next[terminalId] = now
  return next
}

/** Drops panes the runtime no longer lists, so closing terminals does not leave
 *  this growing for the life of the window. */
export function forgetClosedPanes(seen: PaneSeen, terminals: Readonly<Record<string, Terminal>>): PaneSeen {
  const entries = Object.entries(seen).filter(([terminalId]) => terminalId in terminals)
  return entries.length === Object.keys(seen).length ? seen : Object.fromEntries(entries)
}

/**
 * Whether a pane has said anything since this person last had it in front of
 * them.
 *
 * `inFront` is not a shortcut for the record being up to date; it is the rule.
 * A pane somebody is looking at cannot be unread however long the debounce has
 * to run, and making that structural rather than a race is what stops a pip
 * appearing on the pane whose output is being watched.
 *
 * A pane with no record at all is unread if it has printed, which it always
 * has: a PTY's `lastOutputAt` starts at the moment it opened. That is the
 * honest reading — teamree has never had this pane in front of this person —
 * and it costs nothing, because a pane on screen is written down the moment it
 * appears.
 */
export function isPaneUnread(
  terminal: Pick<Terminal, 'lastOutputAt'>,
  seenAt: number | undefined,
  inFront: boolean
): boolean {
  if (inFront) return false
  return terminal.lastOutputAt > (seenAt ?? 0)
}

/** Every pane that has printed since it was last looked at. */
export function unreadPaneIds(
  terminals: Readonly<Record<string, Terminal>>,
  seen: PaneSeen,
  inFront: string | null
): ReadonlySet<string> {
  const unread = new Set<string>()
  for (const [terminalId, terminal] of Object.entries(terminals)) {
    if (isPaneUnread(terminal, seen[terminalId], terminalId === inFront)) unread.add(terminalId)
  }
  return unread
}

/**
 * What the main area is showing, as far as panes are concerned.
 *
 * Narrower than the store on purpose: this is the one question — which panes is
 * the person actually looking at — and it is asked by the workspace, which
 * marks them read, and by the rule above, which refuses to call the focused one
 * unread. Two readings of that would be two answers.
 */
export type FrontOfWindow = {
  activeWorktreeId: string | null
  layouts: Readonly<Record<string, Layout>>
  expandedTerminalId: string | null
  focusedWatchId: string | null
  dashboardOpen: boolean
  settingsOpen: boolean
  helpOpen: boolean
  teamworkProjectId: string | null
}

/**
 * The panes on screen right now, which is none of them whenever something else
 * has the main area.
 *
 * The board, teamwork, settings and help each replace the panes rather than
 * sharing the window with them — see `WorkspaceArea` — so a worktree opened
 * underneath one of those has been chosen but not yet looked at. Maximising
 * narrows it to one leaf for the same reason: the other panes are not on the
 * screen, whatever the layout says.
 */
export function panesOnScreen(state: FrontOfWindow): string[] {
  if (state.dashboardOpen || state.settingsOpen || state.helpOpen || state.teamworkProjectId !== null) return []
  if (state.activeWorktreeId === null) return []
  const layout = state.layouts[state.activeWorktreeId]
  return collectTerminalIds(shownRoot(layout?.root ?? null, state.expandedTerminalId))
}

/**
 * The one pane this person is looking at, or null.
 *
 * Null while a teammate's pane holds the focus, for the reason `focusPane` and
 * the tab strip both apply it: two panes wearing the focus would be two answers
 * to where the next keystroke goes.
 */
export function paneInFront(state: FrontOfWindow): string | null {
  if (state.focusedWatchId !== null) return null
  if (state.activeWorktreeId === null) return null
  const focused = state.layouts[state.activeWorktreeId]?.focusedTerminalId ?? null
  if (focused === null) return null
  return panesOnScreen(state).includes(focused) ? focused : null
}
