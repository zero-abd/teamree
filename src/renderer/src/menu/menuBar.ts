// Which menu each of this window's commands is read under, and what the main
// process is told to draw.
//
// macOS's own guidance is the plainest sentence in it: use the menu bar to give
// people easy access to all the commands they need to do things in your app.
// Until this file existed teamree's menu bar was Electron's stock roles — About,
// Services, Undo, Zoom, Minimize — and not one thing teamree itself does. Every
// command the app has was reachable by a chord nobody had been told or by
// finding the right thing to click. The menu bar is where a new user *looks* to
// find out what an app can do, and it is where VoiceOver and the Help menu's own
// search reach; neither of those had anything to find.
//
// **There is one list of commands and it is not this one.** Labels and chords
// come out of `WORKSPACE_SHORTCUTS`, which is the same table the key handler
// reads, so a menu item cannot advertise a chord that does not fire or miss one
// that does. What this file adds is the one thing that table cannot know — where
// in a menu bar a reader would look for each command — and it adds it as a total
// `Record<WorkspaceCommand, …>`, the same trick `helpTopics.ts` uses: binding a
// new command without saying which menu it belongs in stops the build here,
// rather than quietly leaving it off the menu bar with every test still green.
//
// The order inside a menu is the order the record is written in. That is a real
// property of the language — string keys enumerate in insertion order — and it
// is the reason the record below reads File, then Edit, then View, rather than
// in the table's order: "New task, New terminal, Close pane" is a File menu and
// "Close pane, New terminal, New task" is a list. `menuBar.test.ts` pins it.

import type { Chord } from '../keyboard/platformModifier'
import { isCommandAvailable, type CommandState } from '../keyboard/workspaceCommands'
import { WORKSPACE_SHORTCUTS, type WorkspaceCommand, type WorkspaceShortcut } from '../keyboard/workspaceShortcuts'

/**
 * The menus teamree's own commands go in.
 *
 * `application` is the menu named after the app, which exists only on macOS —
 * the main process folds it into File on the platforms that have no such menu,
 * because that is where those platforms keep the same items.
 */
export type MenuBarSection = 'application' | 'file' | 'edit' | 'view' | 'window' | 'help'

/** The menus in the order they sit in the bar, for the main process to follow. */
export const MENU_BAR_SECTIONS: readonly MenuBarSection[] = ['application', 'file', 'edit', 'view', 'window', 'help']

type Placement = {
  section: MenuBarSection
  /**
   * What the item is called, when the platform names it rather than this app.
   *
   * There is exactly one of these and there should never be a second. Anything
   * else would be a second wording of a command that already has one, which is
   * the drift this whole file is arranged to prevent.
   */
  label?: string
}

/**
 * Where each command is read.
 *
 * Total on purpose: a command added to `WORKSPACE_SHORTCUTS` with no opinion
 * about which menu a reader would look in fails to compile here. A lookup with
 * a default would have put it in whichever menu was least wrong and said
 * nothing at all.
 */
const PLACEMENT: Record<WorkspaceCommand, Placement> = {
  // macOS keeps an app's settings in the menu named after the app, and calls
  // the item Settings… whatever the app calls the thing it opens. This is the
  // one label not taken from the shortcut table, and it is not this app's word:
  // an item called anything else there is an item Mac users do not find. Off
  // macOS the main process folds this section into File and the word goes with
  // it, which is where Windows keeps the same item; the platforms that would
  // want a different word are not ones this app ships on.
  'open-appearance': { section: 'application', label: 'Settings…' },

  'new-worktree': { section: 'file' },
  'new-terminal': { section: 'file' },
  'close-pane': { section: 'file' },

  // Find is in Edit on this platform and has been since before the app existed.
  'find-in-pane': { section: 'edit' },

  'open-palette': { section: 'view' },
  'open-dashboard': { section: 'view' },
  'toggle-sidebar': { section: 'view' },

  // Splitting and walking panes is arranging the window, which is the Window
  // menu's whole subject — it already holds Minimize, Zoom and Bring All to
  // Front.
  'split-right': { section: 'window' },
  'split-down': { section: 'window' },
  'focus-next-pane': { section: 'window' },

  // And the Help menu, which every macOS app has and this one did not.
  'open-help': { section: 'help' }
}

/** Insertion order of the record above, which is the order inside each menu. */
const ORDER: readonly string[] = Object.keys(PLACEMENT)

/**
 * One item of the menu bar, in the shape that crosses to the main process.
 *
 * Flat rather than nested by menu: everything on this wire is compared for
 * equality on every store change and rebuilt by a process that has to check it
 * came from the window, and both of those are simpler over a list of strings
 * than over a tree.
 */
export type MenuBarItem = {
  command: WorkspaceCommand
  label: string
  /** Electron's spelling, e.g. `CommandOrControl+Shift+D`. */
  accelerator: string
  section: MenuBarSection
  enabled: boolean
}

/**
 * A chord as Electron spells an accelerator.
 *
 * `CommandOrControl` rather than `Command`, for the same reason
 * `platformModifier.ts` has two tables: the modifier is ⌘ on a Mac and Ctrl
 * everywhere else, and one token says so. The key names go through untouched
 * because Electron's key codes are the characters themselves — `,`, `/`, `]` —
 * and a letter is written uppercase the way its accelerators are written.
 */
export function acceleratorForChord(chord: Chord): string {
  const parts = ['CommandOrControl']
  if (chord.alt) parts.push('Alt')
  if (chord.shift) parts.push('Shift')
  parts.push(chord.key.length === 1 ? chord.key.toUpperCase() : chord.key)
  return parts.join('+')
}

/**
 * The whole of teamree's menu bar, against the window as it is right now.
 *
 * `enabled` is `isCommandAvailable` — the same predicate the key handler
 * refuses on — so a live item and a working chord are one answer rather than
 * two. An item that cannot do anything is greyed rather than left to be pressed
 * and ignored: this app's standing rule, and a menu bar is where breaking it
 * shows most, because every item is on screen at once.
 */
export function menuBarSpec(
  state: CommandState,
  shortcuts: readonly WorkspaceShortcut[] = WORKSPACE_SHORTCUTS
): MenuBarItem[] {
  return shortcuts
    .map((shortcut) => {
      const placement = PLACEMENT[shortcut.command]
      return {
        command: shortcut.command,
        label: placement.label ?? shortcut.title,
        accelerator: acceleratorForChord(shortcut.chord),
        section: placement.section,
        enabled: isCommandAvailable(shortcut.command, state)
      }
    })
    .sort((left, right) => ORDER.indexOf(left.command) - ORDER.indexOf(right.command))
}
