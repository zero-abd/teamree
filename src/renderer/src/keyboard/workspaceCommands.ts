// What each workspace command does, and whether it could do anything right now. The menu bar
// greys items with the same predicate the dispatcher refuses on, so the two cannot disagree.
// The modal guards live here too: the menu bar is reachable while a modal is up.

import type { ConsentRequest, Layout, WorktreeStatus } from '@shared/entities'
import type { RightPanelTab } from '../workspace/rightPanel/rightPanelState'
import { isFilePaneId } from '@shared/filePane'
import { firstQuestion } from '../dialogs/modalLayer'
import { collectTerminalIds } from '../panes/paneLayout'
import { worktreeOrder } from '../sidebar/worktreeOrder'
import type { DialogState } from '../state/workspaceStore'
import type { WorkspaceCommand } from './workspaceShortcuts'

/** As much of the store as availability reads, structural so a test can state only its three fields. */
export type CommandState = {
  consent: Readonly<Record<string, { requests: ConsentRequest[] }>>
  dialog: DialogState
  projects: readonly { id: string }[]
  worktrees: readonly { id: string; projectId: string; missing?: true }[]
  activeWorktreeId: string | null
  layouts: Readonly<Record<string, Layout>>
  watches: readonly unknown[]
  focusedWatchId: string | null
  /** What git last said about each worktree; only Commit and Push read it, from the header's counts. */
  statuses: Readonly<Record<string, Partial<WorktreeStatus>>>
  /** A push already in flight, which is the one thing that makes Push inert. */
  pushing: boolean
  /** A markdown editor holds the keyboard; ⌘B and ⌘E are bold and code there. */
  editingMarkdown?: boolean
}

/** The store's own methods, named so this module does not import the store. */
export type CommandActions = {
  splitFocusedPane: (direction: 'row' | 'column') => Promise<void>
  closeTerminal: (terminalId: string) => Promise<void>
  createTerminal: (worktreeId: string) => Promise<void>
  newMarkdown: (worktreeId: string) => void
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

/** Changed paths, counted as the header counts them: staged, unstaged, untracked and conflicted. */
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

/** A focused pane of your own, or null; split and find refuse a watched pane. */
function ownFocusedPane(state: CommandState): string | null {
  if (state.focusedWatchId !== null) return null
  return activeLayout(state)?.focusedTerminalId ?? null
}

/** Whether choosing this command now would do anything; each answer is the condition the action itself checks. */
export function isCommandAvailable(command: WorkspaceCommand, state: CommandState): boolean {
  // A remote-keystrokes question owns the window outright, the palette included.
  if (firstQuestion(state.consent) !== null) return false

  // A dialog of this window's own too, except the palette, whose command closes it.
  if (state.dialog) return command === 'open-palette' && state.dialog.kind === 'palette'

  switch (command) {
    case 'split-right':
    case 'split-down':
      return ownFocusedPane(state) !== null
    case 'find-in-pane': {
      // A file pane has no scrollback to search.
      const focused = ownFocusedPane(state)
      return focused !== null && !isFilePaneId(focused)
    }
    case 'close-pane':
      // Either kind: closing a teammate's pane is how a watch stops.
      return state.focusedWatchId !== null || activeLayout(state)?.focusedTerminalId != null
    case 'new-terminal':
    case 'new-markdown':
      // A worktree whose checkout has gone from disk would fail with a path.
      return (
        state.activeWorktreeId !== null &&
        !state.worktrees.some((worktree) => worktree.id === state.activeWorktreeId && worktree.missing === true)
      )
    case 'toggle-right-panel':
      // The panel shows one worktree's files, changes and panes; with none
      // open it has nothing to show and the item says so.
      return state.activeWorktreeId !== null
    case 'new-worktree':
      return projectForNewTask(state) !== undefined
    case 'focus-next-pane':
    case 'focus-previous-pane':
      // Two or more, counting watched panes as the walk does; with one, `focusPane` returns early.
      return collectTerminalIds(activeLayout(state)?.root ?? null).length + state.watches.length >= 2
    case 'expand-pane':
      // A pane of your own, as `splitFocusedPane` requires; a lone pane can still be maximised.
      return ownFocusedPane(state) !== null
    case 'previous-worktree':
    case 'next-worktree':
      // Two rows in sidebar order; with one the walk lands where it started.
      return worktreeOrder(state.projects, state.worktrees).length >= 2
    case 'commit-changes':
      // The same count as the header's Changes chip.
      return changedCount(activeStatus(state)) > 0
    case 'push-worktree':
      // Nothing already in flight: `pushActiveWorktree` returns early while one is.
      return !state.pushing && (activeStatus(state)?.ahead ?? 0) > 0
    case 'toggle-sidebar':
    case 'open-dashboard':
      // Greyed while the editor types: on macOS only a disabled item lets ⌘B and ⌘E reach the page.
      return state.editingMarkdown !== true
    case 'open-palette':
    case 'open-appearance':
    case 'open-settings':
    case 'open-help':
      // Four views, none of which needs anything to be open.
      return true
  }
}

/** Runs the command if available, checked again: the menu was built from an older snapshot of the store. */
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
      // Closing a watched pane is the whole of stopping the watch.
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
    case 'new-markdown':
      if (store.activeWorktreeId) store.newMarkdown(store.activeWorktreeId)
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
      // The one case a dialog lets through: here the command puts the palette away.
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
      // Shows rather than toggles: somebody asking to commit meant to commit.
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
