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
  | 'focus-previous-pane'
  | 'expand-pane'
  | 'previous-worktree'
  | 'next-worktree'
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
  // Brackets, the pair every app that walks a list of things uses for it, and
  // unshifted for the reason the help chord below is: `matchesChord` compares
  // `KeyboardEvent.key`, and on a US layout shift and a bracket produce a brace
  // instead. A chord written as "shift plus bracket" would be a binding for a
  // character whose key name is not the one in the table.
  { command: 'focus-previous-pane', chord: { key: '[' }, title: 'Focus previous pane' },
  { command: 'focus-next-pane', chord: { key: ']' }, title: 'Focus next pane' },
  // Return, because maximising a pane is the same gesture as opening the thing
  // that has the focus, and shifted because an unshifted ⌘↩ is a send key in
  // half the things people run inside these panes. Pressed again it restores —
  // one chord for both halves, so there is nothing to remember about getting
  // back.
  //
  // Spelled the American way, against the prose of this repository, because the
  // menu bar is where this label is read and it sits two rows above Electron's
  // own `minimize` and `zoom` roles. Those are the platform's words and cannot
  // be changed; one menu with both spellings of the same sound in it reads as a
  // typo, and the app's item is the half that can move.
  { command: 'expand-pane', chord: { key: 'Enter', shift: true }, title: 'Maximize pane' },
  // The arrows, because the list these walk is drawn vertically and up and down
  // are what a person reaches for against a vertical list. With alt, because ⌘↑
  // and ⌘↓ alone are document-movement keys inside a pane — an agent's prompt
  // and every editor in one answer to them — and taking them at the window
  // level would be taking them from every pane in it.
  { command: 'previous-worktree', chord: { key: 'ArrowUp', alt: true }, title: 'Previous worktree' },
  { command: 'next-worktree', chord: { key: 'ArrowDown', alt: true }, title: 'Next worktree' },
  { command: 'open-palette', chord: { key: 'k' }, title: 'Go to worktree or command' },
  { command: 'find-in-pane', chord: { key: 'f' }, title: 'Find in pane' },
  // Named after the screen it opens rather than after what the screen does: the
  // board's own heading is "All panes", and a menu command is a noun or a verb
  // phrase, never a description of an ordering.
  { command: 'open-dashboard', chord: { key: 'e' }, title: 'All panes' },
  // Comma, because on this platform that is where settings live and nobody has
  // to be told. The menu bar carries it too, as Settings… in the application
  // menu, which is the platform's name for the item and where a Mac user looks
  // for it; `menuBar.ts` is where that label is chosen.
  { command: 'open-appearance', chord: { key: ',' }, title: 'Appearance' },
  // Slash, which is what a person presses when they want to be told how
  // something works, and the one chord in this table that is worth pressing
  // precisely because you do not know the others yet. Deliberately not a shift
  // chord: `matchesChord` compares `KeyboardEvent.key`, and on a US layout
  // shift and a punctuation key produce a different character entirely — the
  // comma becomes `<` — so a binding written as "shift plus slash" would never
  // fire for the question mark it was meant to be.
  // What the Help menu's one item is called. The topics behind it cover more
  // than the chords, but a menu item is a label and the chords are what people
  // press this for.
  { command: 'open-help', chord: { key: '/' }, title: 'Shortcuts' }
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
