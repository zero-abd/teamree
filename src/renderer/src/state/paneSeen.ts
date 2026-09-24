// When this person last had each pane in front of them: one number per terminal
// id, and a pane is unread when it has printed since. Kept in this window's
// `localStorage`: it is a fact about a reader, not the work, so not the workspace file.

import type { Layout, Terminal } from '@shared/entities'
import { collectTerminalIds, shownRoot } from '../panes/paneLayout'

/** When each pane was last in front of this person, by terminal id. */
export type PaneSeen = Record<string, number>

const STORAGE_KEY = 'teamree.workspace.paneSeen'

/** More panes than a window has ever held; the oldest go first past it. */
const MAX_SEEN_PANES = 256

/**
 * How often a pane being looked at writes down that it is. Focus leaving writes the time, but a
 * window killed with a pane focused never has focus leave; half a minute bounds what that costs.
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
    // A private window, cleared data, or a record this version cannot read: nothing remembered is the first-launch state anyway.
    return {}
  }
}

export function writePaneSeen(storage: Pick<Storage, 'setItem'> | undefined, seen: PaneSeen): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(newest(seen)))
  } catch {
    // Storage full or blocked is not worth failing the click that read a pane.
  }
}

/** The most recently seen panes, so a long-lived window cannot grow this record without end. */
function newest(seen: PaneSeen): PaneSeen {
  const entries = Object.entries(seen)
  if (entries.length <= MAX_SEEN_PANES) return seen
  entries.sort(([, one], [, other]) => other - one)
  return Object.fromEntries(entries.slice(0, MAX_SEEN_PANES))
}

/**
 * The record with these panes seen now. Returns its input when nothing changes: a new object on
 * every clock beat re-renders the sidebar, the strip and the board for a fact that did not change.
 */
export function markSeen(seen: PaneSeen, terminalIds: readonly string[], now: number): PaneSeen {
  const fresh = terminalIds.filter((terminalId) => seen[terminalId] !== now)
  if (fresh.length === 0) return seen
  const next = { ...seen }
  for (const terminalId of fresh) next[terminalId] = now
  return next
}

/** Drops panes the runtime no longer lists. */
export function forgetClosedPanes(seen: PaneSeen, terminals: Readonly<Record<string, Terminal>>): PaneSeen {
  const entries = Object.entries(seen).filter(([terminalId]) => terminalId in terminals)
  return entries.length === Object.keys(seen).length ? seen : Object.fromEntries(entries)
}

/**
 * Whether a pane has printed since this person last had it in view. A pane in view is never unread
 * however long the debounce runs: a rule, not a race. No record means unread: `lastOutputAt` starts at open.
 */
export function isPaneUnread(
  terminal: Pick<Terminal, 'lastOutputAt'>,
  seenAt: number | undefined,
  inView: boolean
): boolean {
  if (inView) return false
  return terminal.lastOutputAt > (seenAt ?? 0)
}

/** Every pane that has printed since it was last looked at. */
export function unreadPaneIds(
  terminals: Readonly<Record<string, Terminal>>,
  seen: PaneSeen,
  inView: readonly string[]
): ReadonlySet<string> {
  const unread = new Set<string>()
  for (const [terminalId, terminal] of Object.entries(terminals)) {
    if (isPaneUnread(terminal, seen[terminalId], inView.includes(terminalId))) unread.add(terminalId)
  }
  return unread
}

/**
 * What the main area is showing, as far as panes are concerned. One question, asked by the workspace
 * (which marks panes read) and by `isPaneUnread`; two readings of it would be two answers.
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
 * The panes on screen right now: none while the board, teamwork, settings or help holds the main
 * area (see `WorkspaceArea`), and one leaf while maximised.
 */
export function panesOnScreen(state: FrontOfWindow): string[] {
  if (state.dashboardOpen || state.settingsOpen || state.helpOpen || state.teamworkProjectId !== null) return []
  if (state.activeWorktreeId === null) return []
  const layout = state.layouts[state.activeWorktreeId]
  return collectTerminalIds(shownRoot(layout?.root ?? null, state.expandedTerminalId))
}

/** The one pane this person is looking at, or null — null while a teammate's pane holds focus, as `focusPane` and the tab strip apply it. */
export function paneInFront(state: FrontOfWindow): string | null {
  if (state.focusedWatchId !== null) return null
  if (state.activeWorktreeId === null) return null
  const focused = state.layouts[state.activeWorktreeId]?.focusedTerminalId ?? null
  if (focused === null) return null
  return panesOnScreen(state).includes(focused) ? focused : null
}

/** The panes this person can see: every one on screen while the window has focus, else only the focused one. */
export function panesInView(state: FrontOfWindow, windowFocused: boolean): string[] {
  if (windowFocused) return panesOnScreen(state)
  const inFront = paneInFront(state)
  return inFront === null ? [] : [inFront]
}
