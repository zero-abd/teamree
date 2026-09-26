// The menu bar extra's menu and icon, read from the runtime's own records so they hold with no
// window open. Pure: `statusItem.ts` draws what these return.

import type { Terminal, UpdateState, Worktree } from '../../shared/entities'
import { activityOf } from '../../shared/paneActivity'

export type MenuBarState = {
  /** In the order the sidebar lists them. */
  worktrees: readonly Pick<Worktree, 'id' | 'name'>[]
  terminals: readonly Terminal[]
  /** What the window calls each pane, by terminal id; empty with no window. */
  paneNames: Readonly<Record<string, string>>
  update: UpdateState | null
}

export type MenuBarAction =
  | { kind: 'reveal'; worktreeId: string; terminalId: string }
  | { kind: 'open' | 'new-task' | 'quick-note' | 'check-updates' | 'restart' | 'settings' | 'quit' }

export type MenuBarEntry =
  | { type: 'item'; label: string; enabled: boolean; action?: MenuBarAction; asking?: true }
  | { type: 'separator' }

export type AskingPane = { terminalId: string; worktreeId: string; label: string }

/** More than this and the menu is a list to scroll; the rest is one item that opens the window. */
export const MOST_ASKING_SHOWN = 8

export function askingPanes(state: MenuBarState): AskingPane[] {
  return state.worktrees.flatMap((worktree) =>
    state.terminals
      .filter((terminal) => terminal.worktreeId === worktree.id && activityOf(terminal) === 'waiting')
      .map((terminal) => {
        const pane = state.paneNames[terminal.id] ?? (terminal.label?.trim() || terminal.title)
        const label = pane === worktree.name ? pane : `${worktree.name} — ${pane}`
        return { terminalId: terminal.id, worktreeId: worktree.id, label }
      })
  )
}

/** The mark alone, or with a dot while an agent asks; the count beside it from two. */
export function statusIcon(asking: number): { image: 'idle' | 'asking'; title: string; tooltip: string } {
  if (asking === 0) return { image: 'idle', title: '', tooltip: 'teamree' }
  return { image: 'asking', title: asking > 1 ? String(asking) : '', tooltip: `teamree — ${asking} asking` }
}

export function menuBarMenu(state: MenuBarState): MenuBarEntry[] {
  const asking = askingPanes(state)
  const shown: MenuBarEntry[] = asking.slice(0, MOST_ASKING_SHOWN).map((pane) => ({
    type: 'item',
    label: pane.label,
    enabled: true,
    asking: true,
    action: { kind: 'reveal', worktreeId: pane.worktreeId, terminalId: pane.terminalId }
  }))
  const hidden = asking.length - shown.length
  if (hidden > 0) shown.push({ type: 'item', label: `${hidden} More…`, enabled: true, action: { kind: 'open' } })
  const item = (label: string, kind: Exclude<MenuBarAction['kind'], 'reveal'>): MenuBarEntry => ({
    type: 'item',
    label,
    enabled: true,
    action: { kind }
  })
  return [
    ...shown,
    { type: 'item', label: runningLabel(state.terminals), enabled: false },
    { type: 'separator' },
    item('New Task…', 'new-task'),
    item('Quick Note…', 'quick-note'),
    { type: 'separator' },
    item('Open teamree', 'open'),
    updateItem(state.update),
    item('Settings…', 'settings'),
    { type: 'separator' },
    item('Quit teamree', 'quit')
  ]
}

function runningLabel(terminals: readonly Terminal[]): string {
  const running = terminals.filter(
    (terminal) => (terminal.agent ?? terminal.foregroundAgent) !== undefined && activityOf(terminal) === 'working'
  ).length
  if (running === 0) return 'No Agents Running'
  return `${running} ${running === 1 ? 'Agent' : 'Agents'} Running`
}

/** The app menu's Check for Updates…, or what the update card would say instead. */
function updateItem(update: UpdateState | null): MenuBarEntry {
  const install = update?.install
  if (install?.state === 'ready' && !install.blocked) {
    return { type: 'item', label: 'Restart to Update', enabled: true, action: { kind: 'restart' } }
  }
  if (install?.state === 'downloading') return { type: 'item', label: 'Downloading Update…', enabled: false }
  if (update?.checking) return { type: 'item', label: 'Checking for Updates…', enabled: false }
  return { type: 'item', label: 'Check for Updates…', enabled: true, action: { kind: 'check-updates' } }
}

/** One line per entry, a dot on an agent asking; for tests and review. */
export function menuAsText(entries: readonly MenuBarEntry[]): string {
  return entries
    .map((entry) => {
      if (entry.type === 'separator') return '---'
      return `${entry.asking ? '● ' : '  '}${entry.label}${entry.enabled ? '' : ' (disabled)'}`
    })
    .join('\n')
}
