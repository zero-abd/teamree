// The one table of workspace key bindings. The hint strings shown in menus and
// the status bar are derived from it, so a rebind cannot leave a stale label.

import type { Chord, ModifierState, PlatformModifier } from './platformModifier'
import { formatChord, matchesChord } from './platformModifier'

export type WorkspaceCommand =
  | 'split-right'
  | 'split-down'
  | 'close-pane'
  | 'new-terminal'
  | 'new-worktree'
  | 'toggle-sidebar'
  | 'toggle-right-panel'
  | 'focus-next-pane'
  | 'focus-previous-pane'
  | 'expand-pane'
  | 'previous-worktree'
  | 'next-worktree'
  | 'open-palette'
  | 'find-in-pane'
  | 'open-dashboard'
  | 'open-appearance'
  | 'open-settings'
  | 'commit-changes'
  | 'push-worktree'
  | 'open-help'

export type WorkspaceShortcut = {
  command: WorkspaceCommand
  /** The key that runs it; absent for a command with no chord to spare, which still gets a menu item and palette row. */
  chord?: Chord
  title: string
}

export const WORKSPACE_SHORTCUTS: readonly WorkspaceShortcut[] = [
  { command: 'split-right', chord: { key: 'd' }, title: 'Split pane right' },
  { command: 'split-down', chord: { key: 'd', shift: true }, title: 'Split pane down' },
  { command: 'close-pane', chord: { key: 'w' }, title: 'Close pane' },
  { command: 'new-terminal', chord: { key: 't' }, title: 'New terminal' },
  { command: 'new-worktree', chord: { key: 'n' }, title: 'New task' },
  { command: 'toggle-sidebar', chord: { key: 'b' }, title: 'Toggle sidebar' },
  // J: the side-panel key in the editors people run in these panes.
  { command: 'toggle-right-panel', chord: { key: 'j' }, title: 'Toggle right panel' },
  // Unshifted: `matchesChord` compares `KeyboardEvent.key`, and shift+bracket yields a brace.
  { command: 'focus-previous-pane', chord: { key: '[' }, title: 'Focus previous pane' },
  { command: 'focus-next-pane', chord: { key: ']' }, title: 'Focus next pane' },
  // Shifted, since ⌘↩ is a send key in many pane programs; pressed again it restores. American
  // spelling to match Electron's own `minimize` role in the same menu.
  { command: 'expand-pane', chord: { key: 'Enter', shift: true }, title: 'Maximize pane' },
  // With alt: bare ⌘↑/⌘↓ are document keys inside a pane.
  { command: 'previous-worktree', chord: { key: 'ArrowUp', alt: true }, title: 'Previous worktree' },
  { command: 'next-worktree', chord: { key: 'ArrowDown', alt: true }, title: 'Next worktree' },
  { command: 'open-palette', chord: { key: 'k' }, title: 'Go to worktree or command' },
  { command: 'find-in-pane', chord: { key: 'f' }, title: 'Find in pane' },
  // Named for the screen it opens ("All panes").
  { command: 'open-dashboard', chord: { key: 'e' }, title: 'All panes' },
  // ⌘, opens the settings page; `menuBar.ts` labels it Settings… in the application menu.
  { command: 'open-settings', chord: { key: ',' }, title: 'Settings' },
  // No chord: shift+comma yields `<`, so ⌘⇧, cannot be bound. Menu, palette and rail reach it.
  { command: 'open-appearance', title: 'Appearance' },
  // No chords: ⌘P and ⌘⇧P are print and palette everywhere else. Commit opens the panel with the
  // message box, hence the ellipsis.
  { command: 'commit-changes', title: 'Commit…' },
  { command: 'push-worktree', title: 'Push' },
  // Unshifted slash: shift+slash yields `?`, whose key name is not this one.
  { command: 'open-help', chord: { key: '/' }, title: 'Shortcuts' }
]

export function commandForEvent(
  event: ModifierState & { key: string },
  modifier: PlatformModifier
): WorkspaceCommand | null {
  for (const shortcut of WORKSPACE_SHORTCUTS) {
    if (shortcut.chord && matchesChord(event, shortcut.chord, modifier)) return shortcut.command
  }
  return null
}

/**
 * The command this name stands for, or null if this window has no such command.
 *
 * The table is the authority on what a command is, so the question is asked
 * here rather than anywhere that happens to be holding a string. It is asked at
 * all because the menu bar brought a name back across a process boundary: what
 * arrives is the `command` of an item this window itself published a moment
 * earlier, and "it can only be one of ours" is the kind of thing that stays
 * true right up until it does not.
 */
export function commandNamed(value: string): WorkspaceCommand | null {
  const shortcut = WORKSPACE_SHORTCUTS.find((entry) => entry.command === value)
  return shortcut ? shortcut.command : null
}

export function shortcutHint(command: WorkspaceCommand, modifier: PlatformModifier): string {
  const shortcut = WORKSPACE_SHORTCUTS.find((entry) => entry.command === command)
  return shortcut?.chord ? formatChord(shortcut.chord, modifier) : ''
}
