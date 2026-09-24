// What each workspace command does, and whether it could do anything right now. The menu bar
// greys items with the same predicate the dispatcher refuses on, so the two cannot disagree.
// The modal guards live here too: the menu bar is reachable while a modal is up.

import type { ConsentRequest, Layout, WorktreeStatus } from '@shared/entities'
import type { RightPanelTab } from '../workspace/rightPanel/rightPanelState'
import { fileColumnIn, fileLeavesIn, isFilePaneId } from '@shared/filePane'
import { firstQuestion } from '../dialogs/modalLayer'
import { collectTerminalIds, paneStops } from '../panes/paneLayout'
import { focusedTreeProject } from '../sidebar/treeKeys'
import { worktreeOrder } from '../sidebar/worktreeOrder'
import { focusedRegion, regionAfter, requestRegionFocus } from '../shell/regions'
import { numberedTab, tabAfter } from '../workspace/paneTabs'
import { TERMINAL_FONT_DEFAULT_PX, TERMINAL_FONT_MAX_PX, TERMINAL_FONT_MIN_PX } from '../state/preferences'
import type { DialogState } from '../state/workspaceStore'
import type { WorkspaceCommand } from './workspaceShortcuts'

/** As much of the store as availability reads, structural so a test can state only its three fields. */
export type CommandState = {
  consent: Readonly<Record<string, { requests: ConsentRequest[] }>>
  dialog: DialogState
  projects: readonly { id: string }[]
  worktrees: readonly { id: string; projectId: string; missing?: true; state?: string }[]
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
  /** Absent reads as the default size. */
  terminalFontSize?: number
  /** Code panes with edits not on disk; absent reads as none. */
  editedFiles?: Readonly<Record<string, unknown>>
  /** File panes showing their diff; absent reads as none. */
  diffPanes?: Readonly<Record<string, unknown>>
  /** Absent reads as shown, for both. */
  sidebarVisible?: boolean
  rightPanelOpen?: boolean
}

/** The store's own methods, named so this module does not import the store. */
export type CommandActions = {
  splitFocusedPane: (direction: 'row' | 'column') => Promise<void>
  closeTerminal: (terminalId: string) => Promise<void>
  saveFiles: (paneIds: readonly string[]) => Promise<boolean>
  createTerminal: (worktreeId: string) => Promise<void>
  newMarkdown: (worktreeId: string) => void
  closeWatchedPane: (id: string) => void
  focusNextPane: () => void
  focusPreviousPane: () => void
  showPane: (paneId: string) => void
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
  setTerminalFontSize: (size: number) => void
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

/** The project a new task would be made in: the focused sidebar row's, else the open worktree's, else the first. */
function projectForNewTask(state: CommandState): string | undefined {
  const focused = focusedTreeProject()
  if (focused !== null && state.projects.some((project) => project.id === focused)) return focused
  const active = state.worktrees.find((worktree) => worktree.id === state.activeWorktreeId)
  return active?.projectId ?? state.projects[0]?.id
}

/** A focused pane of your own, or null; split and find refuse a watched pane. */
function ownFocusedPane(state: CommandState): string | null {
  if (state.focusedWatchId !== null) return null
  return activeLayout(state)?.focusedTerminalId ?? null
}

/** The strip's tabs, every kind, in the order it draws them (`paneTabs`); the file column is one. */
function stripTabs(state: CommandState): string[] {
  return paneStops(activeLayout(state)?.root ?? null)
}

/** The file column's tabs while one of them has the focus, else none. */
function focusedColumnTabs(state: CommandState): string[] {
  const focused = ownFocusedPane(state)
  const tabs = fileLeavesIn(fileColumnIn(activeLayout(state)?.root ?? null)).map((leaf) => leaf.terminalId)
  return focused !== null && tabs.includes(focused) ? tabs : []
}

/** The tab the strip marks; none while a teammate's pane has the focus. */
function stripFocus(state: CommandState): string | null {
  return state.focusedWatchId === null ? (activeLayout(state)?.focusedTerminalId ?? null) : null
}

/** The tab ⌘`n` would show now, or null; refused under the same modal guards as the table's commands. */
export function paneNumberTarget(n: number, state: CommandState): string | null {
  if (firstQuestion(state.consent) !== null || state.dialog) return null
  return numberedTab(stripTabs(state), n)
}

/** The focused pane when it is a code pane with edits to save. */
function editedFocus(state: CommandState): string | null {
  const focused = ownFocusedPane(state)
  return focused !== null && state.editedFiles?.[focused] !== undefined ? focused : null
}

function fontSize(state: CommandState): number {
  return state.terminalFontSize ?? TERMINAL_FONT_DEFAULT_PX
}

/** Whether choosing this command now would do anything; each answer is the condition the action itself checks. */
export function isCommandAvailable(command: WorkspaceCommand, state: CommandState): boolean {
  // A remote-keystrokes question owns the window outright, the palette included.
  if (firstQuestion(state.consent) !== null) return false

  // A dialog of this window's own too, except the palette, whose two chords switch or close it.
  if (state.dialog) {
    if (state.dialog.kind !== 'palette' || (command !== 'open-palette' && command !== 'go-to-file')) return false
  }

  switch (command) {
    case 'split-right':
    case 'split-down':
      return ownFocusedPane(state) !== null
    case 'find-in-pane': {
      // A file pane's own text has its editor's find, which takes the chord while this item is greyed.
      const focused = ownFocusedPane(state)
      return focused !== null && (!isFilePaneId(focused) || state.diffPanes?.[focused] !== undefined)
    }
    case 'close-pane':
      // Either kind: closing a teammate's pane is how a watch stops.
      return state.focusedWatchId !== null || activeLayout(state)?.focusedTerminalId != null
    case 'save-file':
      return editedFocus(state) !== null
    case 'save-all':
      return Object.keys(state.editedFiles ?? {}).length > 0
    case 'new-terminal':
    case 'new-markdown':
      // A worktree whose checkout has gone from disk would fail with a path.
      return (
        state.activeWorktreeId !== null &&
        !state.worktrees.some((worktree) => worktree.id === state.activeWorktreeId && worktree.missing === true)
      )
    case 'go-to-file':
      return state.worktrees.some(
        (worktree) => worktree.id === state.activeWorktreeId && worktree.state === 'ready' && worktree.missing !== true
      )
    case 'toggle-right-panel':
    case 'focus-right-panel':
      // The panel shows one worktree's files, changes and panes; with none
      // open it has nothing to show and the item says so.
      return state.activeWorktreeId !== null
    case 'new-worktree':
      return projectForNewTask(state) !== undefined
    case 'focus-next-pane':
    case 'focus-previous-pane':
      // Two or more, counting watched panes as the walk does; with one, `focusPane` returns early.
      return collectTerminalIds(activeLayout(state)?.root ?? null).length + state.watches.length >= 2
    case 'select-next-pane':
    case 'select-previous-pane':
      return stripTabs(state).length >= 2
    case 'next-file-tab':
    case 'previous-file-tab':
      return focusedColumnTabs(state).length >= 2
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
    case 'bigger-text':
      return fontSize(state) < TERMINAL_FONT_MAX_PX
    case 'smaller-text':
      return fontSize(state) > TERMINAL_FONT_MIN_PX
    case 'actual-size':
      return fontSize(state) !== TERMINAL_FONT_DEFAULT_PX
    case 'open-palette':
    case 'open-appearance':
    case 'open-settings':
    case 'open-help':
      // Four views, none of which needs anything to be open.
      return true
    case 'focus-sidebar':
    case 'focus-panes':
    case 'focus-next-region':
    case 'focus-previous-region':
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
    case 'save-file': {
      const focused = editedFocus(store)
      if (focused) void store.saveFiles([focused])
      break
    }
    case 'save-all':
      void store.saveFiles(Object.keys(store.editedFiles ?? {}))
      break
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
    case 'focus-sidebar':
      if (store.sidebarVisible === false) store.toggleSidebar()
      requestRegionFocus('sidebar')
      break
    case 'focus-panes':
      requestRegionFocus('panes')
      break
    case 'focus-right-panel':
      if (store.rightPanelOpen === false) store.toggleRightPanel()
      requestRegionFocus('panel')
      break
    case 'focus-next-region':
    case 'focus-previous-region': {
      const next = regionAfter(focusedRegion(), command === 'focus-next-region' ? 1 : -1)
      if (next) requestRegionFocus(next)
      break
    }
    case 'focus-next-pane':
      store.focusNextPane()
      break
    case 'focus-previous-pane':
      store.focusPreviousPane()
      break
    case 'select-next-pane':
    case 'select-previous-pane': {
      const next = tabAfter(stripTabs(store), stripFocus(store), command === 'select-next-pane' ? 1 : -1)
      if (next) store.showPane(next)
      break
    }
    case 'next-file-tab':
    case 'previous-file-tab': {
      const next = tabAfter(focusedColumnTabs(store), ownFocusedPane(store), command === 'next-file-tab' ? 1 : -1)
      if (next) store.showPane(next)
      break
    }
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
    case 'go-to-file': {
      // The chord of the mode on screen puts the palette away; the other one switches to its mode.
      const mode = command === 'go-to-file' ? 'files' : 'all'
      if (store.dialog?.kind === 'palette' && (store.dialog.mode ?? 'all') === mode) store.closeDialog()
      else store.openDialog(mode === 'files' ? { kind: 'palette', mode } : { kind: 'palette' })
      break
    }
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
    case 'bigger-text':
      store.setTerminalFontSize(fontSize(store) + 1)
      break
    case 'smaller-text':
      store.setTerminalFontSize(fontSize(store) - 1)
      break
    case 'actual-size':
      store.setTerminalFontSize(TERMINAL_FONT_DEFAULT_PX)
      break
  }
}
