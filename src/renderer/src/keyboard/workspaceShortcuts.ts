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
  | 'focus-next-pane'
  | 'open-palette'
  | 'find-in-pane'
  | 'open-dashboard'
  | 'open-appearance'
  | 'open-help'

export type WorkspaceShortcut = {
  command: WorkspaceCommand
  chord: Chord
  title: string
}

export const WORKSPACE_SHORTCUTS: readonly WorkspaceShortcut[] = [
  { command: 'split-right', chord: { key: 'd' }, title: 'Split pane right' },
  { command: 'split-down', chord: { key: 'd', shift: true }, title: 'Split pane down' },
  { command: 'close-pane', chord: { key: 'w' }, title: 'Close pane' },
  { command: 'new-terminal', chord: { key: 't' }, title: 'New terminal' },
  { command: 'new-worktree', chord: { key: 'n' }, title: 'New task' },
  { command: 'toggle-sidebar', chord: { key: 'b' }, title: 'Toggle sidebar' },
  { command: 'focus-next-pane', chord: { key: ']' }, title: 'Focus next pane' },
  { command: 'open-palette', chord: { key: 'k' }, title: 'Go to worktree or command' },
  { command: 'find-in-pane', chord: { key: 'f' }, title: 'Find in pane' },
  { command: 'open-dashboard', chord: { key: 'e' }, title: 'Every pane, by what needs you' },
  // Comma, because on this platform that is where settings live and nobody has
  // to be told. It is not in the application menu — see appMenu.ts, which
  // carries Electron's own roles and nothing invented — so the key reaches the
  // renderer rather than being eaten by a menu equivalent.
  { command: 'open-appearance', chord: { key: ',' }, title: 'Appearance' },
  // Slash, which is what a person presses when they want to be told how
  // something works, and the one chord in this table that is worth pressing
  // precisely because you do not know the others yet. Deliberately not a shift
  // chord: `matchesChord` compares `KeyboardEvent.key`, and on a US layout
  // shift and a punctuation key produce a different character entirely — the
  // comma becomes `<` — so a binding written as "shift plus slash" would never
  // fire for the question mark it was meant to be.
  { command: 'open-help', chord: { key: '/' }, title: 'Shortcuts and what a worktree is' }
]

export function commandForEvent(
  event: ModifierState & { key: string },
  modifier: PlatformModifier
): WorkspaceCommand | null {
  for (const shortcut of WORKSPACE_SHORTCUTS) {
    if (matchesChord(event, shortcut.chord, modifier)) return shortcut.command
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
  return shortcut ? formatChord(shortcut.chord, modifier) : ''
}
