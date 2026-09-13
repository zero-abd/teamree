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
  { command: 'open-appearance', chord: { key: ',' }, title: 'Appearance' }
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

export function shortcutHint(command: WorkspaceCommand, modifier: PlatformModifier): string {
  const shortcut = WORKSPACE_SHORTCUTS.find((entry) => entry.command === command)
  return shortcut ? formatChord(shortcut.chord, modifier) : ''
}
