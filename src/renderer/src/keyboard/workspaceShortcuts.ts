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
  /**
   * The key that runs it, when there is one.
   *
   * Absent for a command that belongs in this table and has no chord to spare.
   * The table is the one list of what this window can be asked to do — the menu
   * bar, the palette and the help page are all built from it — and a command
   * left out of it to avoid inventing a keystroke is a command with no menu
   * item and no palette row. Better to say there is no key: the menu draws the
   * item with nothing beside it, and `shortcutHint` answers with an empty
   * string, which every caller already renders as no chord at all.
   */
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
  // The panel on the other side — files, changes and panes of the worktree on
  // screen. J, because it is the letter the editors people run in these panes
  // already use for the panel beside the editor, and it is free.
  { command: 'toggle-right-panel', chord: { key: 'j' }, title: 'Toggle right panel' },
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
  // to be told — and it opens the settings page, which is the page with the CLI
  // link, the update preference, the terminal text size, the default agent and
  // the relay on it. It used to open the theme editor, so ⌘, in a window whose
  // owner wanted to change where teamree's binary points landed on 42 colour
  // swatches. The menu bar carries it as Settings… in the application menu,
  // which is the platform's name for the item; `menuBar.ts` chooses that label.
  { command: 'open-settings', chord: { key: ',' }, title: 'Settings' },
  // And the theme editor, with no chord of its own. ⌘⇧, is the obvious second
  // punctuation chord and is not one this window can bind: `matchesChord`
  // compares `KeyboardEvent.key`, and shift and a comma produce `<` on a US
  // layout, so the binding would be for a character whose key name is not the
  // one written here. It keeps its menu item, its palette row and its rail
  // button, which is three ways in and none of them a key that does nothing.
  { command: 'open-appearance', title: 'Appearance' },
  // The two git commands. No chords — ⌘P and ⌘⇧P are a print dialog and a
  // palette everywhere else, and taking either would surprise more people than
  // it helped — but they belong in this table all the same: it is what the menu
  // bar and the palette are built from, and until now neither could reach the
  // two things a person does with a worktree once the agent has finished.
  //
  // Commit asks for a message, so it opens the panel that has the box for one,
  // and the ellipsis says so.
  { command: 'commit-changes', title: 'Commit…' },
  { command: 'push-worktree', title: 'Push' },
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
