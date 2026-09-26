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
// in the table's order: "New Task, New Terminal, Close Pane" is a File menu and
// "Close Pane, New Terminal, New Task" is a list. `menuBar.test.ts` pins it.

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
export type MenuBarSection = 'application' | 'file' | 'edit' | 'view' | 'text' | 'window' | 'help'

type Placement = {
  section: MenuBarSection
  /**
   * What the item is called, when the menu names it rather than the table does.
   *
   * There are two of these and there should never be a third. Both are the
   * platform's wording rather than a second opinion about a command: macOS
   * writes its settings item `Settings…`, and an item that opens an editor is
   * written with an ellipsis. Anything else here would be a second wording of a
   * command that already has one, which is the drift this file is arranged to
   * prevent — and `menuLabel` is what every other surface reads, so a wording
   * chosen here reaches the palette and the shortcut strip rather than being
   * contradicted by them.
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
  'open-settings': { section: 'application', label: 'Settings…' },

  'new-worktree': { section: 'file' },
  'new-child-task': { section: 'file' },
  'new-terminal': { section: 'file' },
  'new-markdown': { section: 'file' },
  'add-project': { section: 'file' },
  'clone-repository': { section: 'file' },
  'go-to-file': { section: 'file' },
  'close-pane': { section: 'file' },
  'reopen-closed-pane': { section: 'file' },
  'save-file': { section: 'file' },
  'save-all': { section: 'file' },
  // What a person does with a worktree once the agent has stopped, and until
  // now the two things the menu bar could not reach at all. Under File rather
  // than in a menu of their own: File is already where this app keeps the
  // commands that act on the checkout in front of you.
  'review-changes': { section: 'file' },
  'commit-changes': { section: 'file' },
  'push-worktree': { section: 'file' },

  // Find is in Edit on this platform and has been since before the app existed.
  'find-in-pane': { section: 'edit' },

  'open-palette': { section: 'view' },
  // Between the palette and the board, because all three answer "show me
  // something else" — and these two are the answer for the case the palette is
  // three presses too slow for, which is moving one row at a time.
  'previous-worktree': { section: 'view' },
  'next-worktree': { section: 'view' },
  'next-needing': { section: 'view' },
  'previous-needing': { section: 'view' },
  'open-dashboard': { section: 'view' },
  'toggle-sidebar': { section: 'view' },
  'toggle-right-panel': { section: 'view' },
  'focus-sidebar': { section: 'view' },
  'focus-panes': { section: 'view' },
  'focus-right-panel': { section: 'view' },
  'focus-next-region': { section: 'view' },
  'focus-previous-region': { section: 'view' },
  // The theme editor, which used to be the thing `Settings…` opened. It is a
  // view of the window rather than a setting of the machine, and this is the
  // menu somebody looks in for how the window looks.
  'open-appearance': { section: 'view', label: 'Appearance…' },

  // View's own group, where the zoom roles were.
  'actual-size': { section: 'text' },
  'bigger-text': { section: 'text' },
  'smaller-text': { section: 'text' },

  // Splitting and walking panes is arranging the window, which is the Window
  // menu's whole subject — it already holds Minimize, Zoom and Bring All to
  // Front.
  'split-right': { section: 'window' },
  'split-down': { section: 'window' },
  'focus-previous-pane': { section: 'window' },
  'focus-next-pane': { section: 'window' },
  'select-previous-pane': { section: 'window' },
  'select-next-pane': { section: 'window' },
  'previous-file-tab': { section: 'window' },
  'next-file-tab': { section: 'window' },
  // Which pane fills the window is the same subject as how they are arranged,
  // so it is read under the same menu — and under the walk rather than above
  // it, because it is the thing you do once you have arrived.
  'expand-pane': { section: 'window' },

  // And the Help menu, which every macOS app has and this one did not.
  'open-help': { section: 'help' }
}

/** Insertion order of the record above, which is the order inside each menu. */
const ORDER: readonly string[] = Object.keys(PLACEMENT)

/**
 * Every command in the order the menus read, for anything that wants to offer
 * the same list in the same order.
 */
export const MENU_ORDER = ORDER as readonly WorkspaceCommand[]

/**
 * What this command is called in the menu, palette and Help: the table's title unless the menu has the
 * platform's word for it. With `panels`, a panel toggle says Show or Hide as the panel stands.
 */
export function menuLabel(command: WorkspaceCommand, panels?: PanelState): string {
  return (
    PLACEMENT[command].label ??
    (panels ? panelLabel(command, panels) : null) ??
    WORKSPACE_SHORTCUTS.find((shortcut) => shortcut.command === command)?.title ??
    command
  )
}

/** Whether each side panel is on screen; absent reads as shown. */
export type PanelState = Pick<CommandState, 'sidebarVisible' | 'rightPanelOpen'>

/** Finder's wording: a panel's toggle names what choosing it does now. Null for every other command. */
function panelLabel(command: WorkspaceCommand, panels: PanelState): string | null {
  if (command === 'toggle-sidebar') return panels.sidebarVisible === false ? 'Show Sidebar' : 'Hide Sidebar'
  if (command === 'toggle-right-panel') return panels.rightPanelOpen === false ? 'Show Right Panel' : 'Hide Right Panel'
  return null
}

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
 * The keys Electron does not spell the way `KeyboardEvent.key` does.
 *
 * Only the arrows, and only because the table binds two of them: the browser
 * calls the key `ArrowUp` and Electron's accelerator parser calls it `Up`, and
 * nothing anywhere would tell you which of the two a menu item silently failed
 * to register. Exported so the round-trip in `menuBar.test.ts` reads the same
 * table on the way back rather than repeating it — a second copy of this is how
 * a menu comes to advertise a chord that does not fire. Everything else — the
 * letters, the punctuation, `Enter` — is already spelt the same in both.
 */
export const ACCELERATOR_KEY_NAMES: Readonly<Record<string, string>> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right'
}

/**
 * A chord as Electron spells an accelerator.
 *
 * `CommandOrControl` rather than `Command`, for the same reason
 * `platformModifier.ts` has two tables: the modifier is ⌘ on a Mac and Ctrl
 * everywhere else, and one token says so. Most key names go through untouched
 * because Electron's key codes are the characters themselves — `,`, `/`, `]` —
 * and a letter is written uppercase the way its accelerators are written; the
 * arrows are the exception, and `ACCELERATOR_KEY_NAMES` above is all of it.
 */
export function acceleratorForChord(chord: Chord): string {
  const parts = chord.bare ? [] : [chord.ctrl ? 'Control' : 'CommandOrControl']
  if (chord.control) parts.push('Control')
  if (chord.alt) parts.push('Alt')
  if (chord.shift) parts.push('Shift')
  parts.push(ACCELERATOR_KEY_NAMES[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key))
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
        label: placement.label ?? panelLabel(shortcut.command, state) ?? shortcut.title,
        // Empty for a command with no chord, which the main process draws as an
        // item with nothing beside it.
        accelerator: shortcut.chord ? acceleratorForChord(shortcut.chord) : '',
        section: placement.section,
        enabled: isCommandAvailable(shortcut.command, state)
      }
    })
    .sort((left, right) => ORDER.indexOf(left.command) - ORDER.indexOf(right.command))
}
