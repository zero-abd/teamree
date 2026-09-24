// The one table of workspace key bindings. The hint strings shown in menus and
// the status bar are derived from it, so a rebind cannot leave a stale label.

import type { Chord, ModifierState, PlatformModifier } from './platformModifier'
import { formatChord, holdsModifier, matchesChord } from './platformModifier'

export type WorkspaceCommand =
  | 'split-right'
  | 'split-down'
  | 'close-pane'
  | 'reopen-closed-pane'
  | 'save-file'
  | 'save-all'
  | 'new-terminal'
  | 'new-markdown'
  | 'new-worktree'
  | 'toggle-sidebar'
  | 'toggle-right-panel'
  | 'focus-sidebar'
  | 'focus-panes'
  | 'focus-right-panel'
  | 'focus-next-region'
  | 'focus-previous-region'
  | 'focus-next-pane'
  | 'focus-previous-pane'
  | 'select-next-pane'
  | 'select-previous-pane'
  | 'next-file-tab'
  | 'previous-file-tab'
  | 'expand-pane'
  | 'previous-worktree'
  | 'next-worktree'
  | 'open-palette'
  | 'go-to-file'
  | 'find-in-pane'
  | 'open-dashboard'
  | 'open-appearance'
  | 'open-settings'
  | 'add-project'
  | 'clone-repository'
  | 'review-changes'
  | 'commit-changes'
  | 'push-worktree'
  | 'open-help'
  | 'bigger-text'
  | 'smaller-text'
  | 'actual-size'

export type WorkspaceShortcut = {
  command: WorkspaceCommand
  /** The key that runs it; absent for a command with no chord to spare, which still gets a menu item and palette row. */
  chord?: Chord
  title: string
}

export const WORKSPACE_SHORTCUTS: readonly WorkspaceShortcut[] = [
  { command: 'split-right', chord: { key: 'd' }, title: 'Split Pane Right' },
  { command: 'split-down', chord: { key: 'd', shift: true }, title: 'Split Pane Down' },
  { command: 'close-pane', chord: { key: 'w' }, title: 'Close Pane' },
  { command: 'reopen-closed-pane', chord: { key: 't', shift: true }, title: 'Reopen Closed Pane' },
  { command: 'save-file', chord: { key: 's' }, title: 'Save' },
  { command: 'save-all', chord: { key: 's', alt: true }, title: 'Save All' },
  { command: 'new-terminal', chord: { key: 't' }, title: 'New Terminal' },
  // Shifted, because ⌘M is the platform's minimise.
  { command: 'new-markdown', chord: { key: 'm', shift: true }, title: 'New Markdown' },
  { command: 'new-worktree', chord: { key: 'n' }, title: 'New Task' },
  { command: 'toggle-sidebar', chord: { key: 'b' }, title: 'Show/Hide Sidebar' },
  // J: the side-panel key in the editors people run in these panes.
  { command: 'toggle-right-panel', chord: { key: 'j' }, title: 'Show/Hide Right Panel' },
  { command: 'focus-sidebar', title: 'Focus Sidebar' },
  { command: 'focus-panes', title: 'Focus Panes' },
  { command: 'focus-right-panel', title: 'Focus Right Panel' },
  // Bare F6, as Mac apps and editors walk their regions; the only way out of a terminal, which eats Tab.
  { command: 'focus-next-region', chord: { key: 'F6', bare: true }, title: 'Focus Next Region' },
  { command: 'focus-previous-region', chord: { key: 'F6', bare: true, shift: true }, title: 'Focus Previous Region' },
  // Unshifted: `matchesChord` compares `KeyboardEvent.key`, and shift+bracket yields a brace.
  { command: 'focus-previous-pane', chord: { key: '[' }, title: 'Focus Previous Pane' },
  { command: 'focus-next-pane', chord: { key: ']' }, title: 'Focus Next Pane' },
  // Control on a Mac too, as in Safari and Terminal; the strip's tabs only, where ⌘] also visits teammates' panes.
  { command: 'select-next-pane', chord: { key: 'Tab', ctrl: true }, title: 'Select Next Pane' },
  { command: 'select-previous-pane', chord: { key: 'Tab', ctrl: true, shift: true }, title: 'Select Previous Pane' },
  // Within the file column, as editors page their tabs.
  { command: 'next-file-tab', chord: { key: 'PageDown', ctrl: true }, title: 'Next File Tab' },
  { command: 'previous-file-tab', chord: { key: 'PageUp', ctrl: true }, title: 'Previous File Tab' },
  // Shifted, since ⌘↩ is a send key in many pane programs; pressed again it restores. American
  // spelling to match Electron's own `minimize` role in the same menu.
  { command: 'expand-pane', chord: { key: 'Enter', shift: true }, title: 'Maximize Pane' },
  // With alt: bare ⌘↑/⌘↓ are document keys inside a pane.
  { command: 'previous-worktree', chord: { key: 'ArrowUp', alt: true }, title: 'Previous Worktree' },
  { command: 'next-worktree', chord: { key: 'ArrowDown', alt: true }, title: 'Next Worktree' },
  { command: 'open-palette', chord: { key: 'k' }, title: 'Go to Worktree or Command' },
  // ⌘P as in every editor; this window has nothing to print.
  { command: 'go-to-file', chord: { key: 'p' }, title: 'Go to File…' },
  { command: 'find-in-pane', chord: { key: 'f' }, title: 'Find in Pane' },
  // Named for the screen it opens ("All panes").
  { command: 'open-dashboard', chord: { key: 'e' }, title: 'All Panes' },
  // ⌘, opens the settings page; `menuBar.ts` labels it Settings… in the application menu.
  { command: 'open-settings', chord: { key: ',' }, title: 'Settings' },
  // No chord: shift+comma yields `<`, so ⌘⇧, cannot be bound. Menu, palette and rail reach it.
  { command: 'open-appearance', title: 'Appearance' },
  // The picker straight away; cloning is the other way in.
  { command: 'add-project', title: 'Add Project…' },
  { command: 'clone-repository', title: 'Clone Repository…' },
  // No chords: ⌘⇧P is a palette everywhere else. Commit opens the panel with the message box,
  // hence the ellipsis.
  { command: 'review-changes', chord: { key: 'r', shift: true }, title: 'Review Changes' },
  { command: 'commit-changes', title: 'Commit…' },
  { command: 'push-worktree', title: 'Push' },
  // Unshifted slash: shift+slash yields `?`, whose key name is not this one.
  { command: 'open-help', chord: { key: '/' }, title: 'Shortcuts' },
  // Terminal text, not the window: `commandForEvent` also reads `+` as `=`.
  { command: 'bigger-text', chord: { key: '=' }, title: 'Bigger Text' },
  { command: 'smaller-text', chord: { key: '-' }, title: 'Smaller Text' },
  { command: 'actual-size', chord: { key: '0' }, title: 'Actual Size' }
]

export function commandForEvent(
  event: ModifierState & { key: string },
  modifier: PlatformModifier
): WorkspaceCommand | null {
  // ⌘+ is shift+= on a US layout and an unshifted key on others; either way it is ⌘=.
  const pressed = event.key === '+' ? { ...event, key: '=', shiftKey: false } : event
  for (const shortcut of WORKSPACE_SHORTCUTS) {
    if (shortcut.chord && matchesChord(pressed, shortcut.chord, modifier)) return shortcut.command
  }
  return null
}

/** ⌘1–⌘9 as a tab number, or null. Outside the table: nine rows would crowd the menu bar and palette. */
export function paneNumberForEvent(event: ModifierState & { key: string }, modifier: PlatformModifier): number | null {
  if (!holdsModifier(event, modifier) || event.shiftKey || event.altKey) return null
  return /^[1-9]$/.test(event.key) ? Number(event.key) : null
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
