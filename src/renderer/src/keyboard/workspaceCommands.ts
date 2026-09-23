// What each workspace command does, and whether it could do anything if it were
// asked right now.
//
// This used to be a switch inside the window's keydown listener, which was fine
// while a chord was the only way to reach a command. It is not any more: the
// macOS menu bar carries the same twelve commands, a menu item is chosen with
// the mouse as well as with a key, and a menu item has to know *before* it is
// drawn whether choosing it would do anything — that is what greying it out
// means. So the two halves live here, together, and both callers go through
// them.
//
// Keeping them together is the point rather than a tidy-up. `isCommandAvailable`
// is the same predicate the menu greys an item out with and the dispatcher
// refuses on, so a menu item that looks live and a chord that does nothing
// cannot disagree: there is one answer and both read it. The alternative —
// enablement worked out in the menu builder, behaviour worked out in the
// dispatcher — is two statements of one rule, and the way that fails is the
// menu saying "Close pane" in black letters over a window with no pane in it.
//
// The modal guards are in here for the same reason, and they are not a detail.
// A question about a teammate's keystrokes is a modal this window did not open
// and the one modal here that refuses to be dismissed; a chord that fired under
// it acted on a window the owner cannot see and cannot get back to. That
// argument is `modalLayer.ts`'s and it now has to hold for a menu item too,
// because the menu bar is reachable while a modal is up.

import type { ConsentRequest, Layout, WorktreeStatus } from '@shared/entities'
import type { RightPanelTab } from '../workspace/rightPanel/rightPanelState'
import { firstQuestion } from '../dialogs/modalLayer'
import { collectTerminalIds } from '../panes/paneLayout'
import { worktreeOrder } from '../sidebar/worktreeOrder'
import type { DialogState } from '../state/workspaceStore'
import type { WorkspaceCommand } from './workspaceShortcuts'

/**
 * As much of the store as deciding availability actually reads.
 *
 * Written structurally, the way `modalLayer.ts` writes its own slice, so that a
 * test can state the three fields a case is about instead of building a
 * workspace. The real store satisfies it because these are its own field names
 * and types.
 */
export type CommandState = {
  consent: Readonly<Record<string, { requests: ConsentRequest[] }>>
  dialog: DialogState
  projects: readonly { id: string }[]
  worktrees: readonly { id: string; projectId: string }[]
  activeWorktreeId: string | null
  layouts: Readonly<Record<string, Layout>>
  watches: readonly unknown[]
  focusedWatchId: string | null
  /**
   * What git last said about each worktree. Only the two git commands read it,
   * and only to answer whether there is anything for them to do — the counts
   * the header chips are drawn from, read here rather than restated.
   */
  statuses: Readonly<Record<string, Partial<WorktreeStatus>>>
  /** A push already in flight, which is the one thing that makes Push inert. */
  pushing: boolean
}

/** The store's own methods, named so this module does not import the store. */
export type CommandActions = {
  splitFocusedPane: (direction: 'row' | 'column') => Promise<void>
  closeTerminal: (terminalId: string) => Promise<void>
  createTerminal: (worktreeId: string) => Promise<void>
  closeWatchedPane: (id: string) => void
  focusNextPane: () => void
  focusPreviousPane: () => void
  toggleExpandedPane: () => void
  stepWorktree: (step: 1 | -1) => void
  openPaneSearch: () => void
  toggleSidebar: () => void
  toggleRightPanel: () => void
  toggleDashboard: () => void
  toggleHelp: () => void
  openDialog: (dialog: NonNullable<DialogState>) => void
  closeDialog: () => void
  toggleSettings: () => void
  showRightPanelTab: (tab: RightPanelTab) => void
  pushActiveWorktree: () => Promise<void>
}

export type Workspace = CommandState & CommandActions

/** What git said about the worktree that is open, or undefined when none is. */
function activeStatus(state: CommandState): Partial<WorktreeStatus> | undefined {
  return state.activeWorktreeId ? state.statuses[state.activeWorktreeId] : undefined
}

/**
 * How many paths the worktree has changed, counted the way the header counts
 * them — staged, unstaged, untracked and conflicted, which is every path git
 * would have something to commit for.
 */
function changedCount(status: Partial<WorktreeStatus> | undefined): number {
  if (!status) return 0
  return (status.staged ?? 0) + (status.unstaged ?? 0) + (status.untracked ?? 0) + (status.conflicted ?? 0)
}

/** The layout of the worktree that is open, or undefined when none is. */
function activeLayout(state: CommandState): Layout | undefined {
  return state.activeWorktreeId ? state.layouts[state.activeWorktreeId] : undefined
}

/** The project a new task would be made in, the way the chord picks one. */
function projectForNewTask(state: CommandState): string | undefined {
  const active = state.worktrees.find((worktree) => worktree.id === state.activeWorktreeId)
  return active?.projectId ?? state.projects[0]?.id
}

/**
 * A pane of your own that a command could act on, or null.
 *
 * Null when a teammate's pane has the focus as well as when nothing does,
 * because the commands that ask for this — split and find — are refused on a
 * watched pane: the tree a split would go in is on somebody else's machine, and
 * a watched pane's scrollback is a picture rather than a buffer to search.
 */
function ownFocusedPane(state: CommandState): string | null {
  if (state.focusedWatchId !== null) return null
  return activeLayout(state)?.focusedTerminalId ?? null
}

/**
 * Whether choosing this command now would do anything at all.
 *
 * The house rule is that nothing is offered that cannot work, and a menu bar is
 * where that rule is most visible: every item is on screen at once, so an item
 * that is enabled and inert is a promise being broken in front of the reader
 * rather than a button they never found. Each answer below is the same
 * condition the action itself checks and returns on, read off the store rather
 * than restated — `splitFocusedPane` refuses a watched pane and a layout with
 * no focused terminal, `openPaneSearch` refuses exactly the same two, and so on
 * down. Where an action has no such condition the answer is simply true.
 */
export function isCommandAvailable(command: WorkspaceCommand, state: CommandState): boolean {
  // A question about a teammate's keystrokes owns the window outright. Nothing
  // is available under it — not even the palette, which is the one exception
  // the dialog case below makes.
  if (firstQuestion(state.consent) !== null) return false

  // A dialog of this window's own owns the keyboard too, with the palette's
  // exception: its own command closes it again, the way every palette does.
  if (state.dialog) return command === 'open-palette' && state.dialog.kind === 'palette'

  switch (command) {
    case 'split-right':
    case 'split-down':
    case 'find-in-pane':
      return ownFocusedPane(state) !== null
    case 'close-pane':
      // Either kind of pane: closing a teammate's is the whole of stopping the
      // watch, so it counts as something the command can do.
      return state.focusedWatchId !== null || activeLayout(state)?.focusedTerminalId != null
    case 'new-terminal':
      return state.activeWorktreeId !== null
    case 'toggle-right-panel':
      // The panel shows one worktree's files, changes and panes; with none
      // open it has nothing to show and the item says so.
      return state.activeWorktreeId !== null
    case 'new-worktree':
      return projectForNewTask(state) !== undefined
    case 'focus-next-pane':
    case 'focus-previous-pane':
      // Two or more in the cycle, counting a teammate's pane the way the walk
      // itself does. With one pane the walk lands on the pane that already has
      // the focus and `focusPane` returns early — nothing happens — and an item
      // that is lit over nothing happening is exactly what this rule forbids.
      // Both directions, because a cycle of one is as circular one way as the
      // other.
      return collectTerminalIds(activeLayout(state)?.root ?? null).length + state.watches.length >= 2
    case 'expand-pane':
      // A pane of your own, which is `splitFocusedPane`'s rule and here for the
      // same reason: a teammate's pane is not in this tree, so there is no tree
      // for it to fill. Available with one pane too — maximising a lone pane
      // hides the tab strip and the header around it, which is a thing somebody
      // can want and a thing this does.
      return ownFocusedPane(state) !== null
    case 'previous-worktree':
    case 'next-worktree':
      // Two rows in the sidebar to move between. With one, the walk wraps
      // straight back onto the worktree that is already open, and the rule
      // against offering what cannot do anything covers a command that lands
      // where it started as squarely as one that lands nowhere. Counted off the
      // sidebar's own order, so a worktree whose project is not on screen — one
      // this window could not walk to — is not counted as somewhere to go.
      return worktreeOrder(state.projects, state.worktrees).length >= 2
    case 'commit-changes':
      // Something to commit. The same count the header's Changes chip is drawn
      // from, so the menu item and the chip cannot disagree about whether this
      // worktree has anything in it.
      return changedCount(activeStatus(state)) > 0
    case 'push-worktree':
      // Something to send, and nothing already being sent: `pushActiveWorktree`
      // returns early while one is in flight, and an item that is lit over a
      // function that returns early is the thing this rule forbids.
      return !state.pushing && (activeStatus(state)?.ahead ?? 0) > 0
    case 'toggle-sidebar':
    case 'open-palette':
    case 'open-dashboard':
    case 'open-appearance':
    case 'open-settings':
    case 'open-help':
      // Five views and a sidebar, none of which needs anything to be open.
      return true
  }
}

/**
 * Runs the command, if it is one the window could run.
 *
 * The availability check is repeated here rather than left to the caller, and
 * that is deliberate: a menu item is drawn from a snapshot of the store and
 * chosen some time afterwards, so the state it was enabled against is not
 * necessarily the state it arrives in. The window can change between the two —
 * a pane can exit, a teammate's question can land — and the menu Electron is
 * showing at that moment is the one built before it did.
 */
export function runWorkspaceCommand(command: WorkspaceCommand, store: Workspace): void {
  if (!isCommandAvailable(command, store)) return

  switch (command) {
    case 'split-right':
      void store.splitFocusedPane('row')
      break
    case 'split-down':
      void store.splitFocusedPane('column')
      break
    case 'close-pane': {
      // A teammate's pane closes with the same command as your own, and for
      // this one closing is the whole of stopping the watch: the pane is the
      // subscription, and nothing flows once it is gone.
      if (store.focusedWatchId !== null) {
        store.closeWatchedPane(store.focusedWatchId)
        break
      }
      const focused = activeLayout(store)?.focusedTerminalId
      if (focused) void store.closeTerminal(focused)
      break
    }
    case 'new-terminal':
      if (store.activeWorktreeId) void store.createTerminal(store.activeWorktreeId)
      break
    case 'new-worktree': {
      const projectId = projectForNewTask(store)
      if (projectId) store.openDialog({ kind: 'new-task', projectId })
      break
    }
    case 'toggle-sidebar':
      store.toggleSidebar()
      break
    case 'toggle-right-panel':
      store.toggleRightPanel()
      break
    case 'focus-next-pane':
      store.focusNextPane()
      break
    case 'focus-previous-pane':
      store.focusPreviousPane()
      break
    case 'expand-pane':
      store.toggleExpandedPane()
      break
    case 'previous-worktree':
      store.stepWorktree(-1)
      break
    case 'next-worktree':
      store.stepWorktree(1)
      break
    case 'open-palette':
      // Available with the palette already up, which is the one case a dialog
      // lets through, and there the command is the one that puts it away.
      if (store.dialog?.kind === 'palette') store.closeDialog()
      else store.openDialog({ kind: 'palette' })
      break
    case 'find-in-pane':
      store.openPaneSearch()
      break
    case 'open-dashboard':
      store.toggleDashboard()
      break
    case 'open-appearance':
      store.openDialog({ kind: 'appearance' })
      break
    case 'open-settings':
      store.toggleSettings()
      break
    case 'commit-changes':
      // The message box is on the changes tab, so this is the command that
      // puts that tab on screen. Shows rather than toggles: somebody who asked
      // to commit with the tab already up meant to commit, and closing it
      // under them would be the opposite of what they pressed.
      store.showRightPanelTab('changes')
      break
    case 'push-worktree':
      void store.pushActiveWorktree()
      break
    case 'open-help':
      store.toggleHelp()
      break
  }
}
