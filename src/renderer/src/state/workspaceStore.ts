// One store for everything the window shows. The runtime is the source of
// truth; this keeps a read model of it plus the purely local bits (which tabs
// are open, which pane has focus, how wide the sidebar is).

import { create } from 'zustand'
import { hasCheckout } from '@shared/entities'
import type {
  CliInstall,
  CliStatus,
  ClosedPane,
  ConsentDecision,
  InstalledAgent,
  Layout,
  MemberList,
  PaneConsent,
  PaneNode,
  PaneWatchers,
  Project,
  PushFailureData,
  RelaySetting,
  RemovedWorktree,
  TeammatePresence,
  TeamworkPublish,
  TeamworkPublishPlan,
  TeamworkPublishProgress,
  TeamworkStatus,
  Terminal,
  UpdateState,
  Worktree,
  WorktreeChange,
  WorktreeChanges,
  WorktreeCommitSummary,
  WorktreeKeep,
  WorktreeLanding,
  WorktreeLog,
  WorktreeMergePreview,
  WorktreeStatus
} from '@shared/entities'
import { DEFAULT_APPEARANCE, type Appearance, type Tone } from '@shared/theme'
import {
  commitLeaf,
  compareLeaf,
  DEFAULT_MARKDOWN_PATH,
  fileColumn,
  fileColumnIn,
  fileLeaf,
  fileLeavesIn,
  type FileLeaf,
  isCommitLeaf,
  isCompareLeaf,
  isFileColumn,
  isFilePaneId,
  isWorktreeFileLeaf,
  isMarkdownPath,
  isReviewLeaf,
  isSharedNoteLeaf,
  sharedNoteLeaf,
  newFilePaneId,
  reviewLeaf,
  shownTabId
} from '@shared/filePane'
import { closePaneWarning } from '../dialogs/closePaneModel'
import { openInBrowser } from '../shell/openInBrowser'
import { noticeLifetime } from '../notices/noticeLifetime'
import { useSharedNotes } from '../teamwork/sharedNotesStore'
import {
  nextToReopen,
  readClosedFiles,
  withClosedFile,
  withoutClosedFile,
  writeClosedFiles,
  type ClosedFile,
  type ClosedFiles
} from './closedPanes'
import type { TaskCreate } from '../dialogs/taskPlan'
import {
  addTab,
  appendPane,
  closePane,
  collectTerminalIds,
  hasTerminal,
  neighbourTerminalId,
  pinTab,
  placeFileColumn,
  setSizesAt,
  showTab,
  foldsColumn,
  planSplit,
  shownRoot,
  splitPane,
  splitPaneWith,
  unfoldedRoot,
  withoutColumn
} from '../panes/paneLayout'
import { worktreeAfter, worktreeOrder } from '../sidebar/worktreeOrder'
import { worktreeDisplay, worktreeLabel } from '../sidebar/worktreeDisplay'
import {
  isWatchedPaneId,
  neighbourWatchId,
  paneCycle,
  watchedPaneId,
  WATCH_TAIL_CHARS,
  type WatchedPane
} from '../panes/watchedPanes'
import { tabAfter } from '../workspace/paneTabs'
import { awaitWorktreeReady } from './awaitWorktreeReady'
import {
  relayLauncherCommand,
  RELAY_PANE_URL_SCHEMES,
  relayUrlFromOutput,
  relayUrlsFromOutput,
  type RelayPaneKind,
  type RelayPaneState
} from '../teamwork/startTeamwork'
import type { ConnectionState } from '../runtimeClient/RuntimeClientContract'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { newPaneRoom, paneGrid, roomForNewPane, type Box, type NewPane } from '../terminal/paneMetrics'
import { leavesRoom, paneCellsIn, placePaneWithin } from '@shared/paneRoom'
import { shownText } from '../terminal/shownPanes'
import { replayLines } from '@shared/outputEvidence'
import type { ScreenChoice } from '@shared/screenOpinion'
import {
  clampSidebarWidth,
  readStoredSidebarWidth,
  writeStoredSidebarWidth,
  SIDEBAR_DEFAULT_PX
} from '../shell/sidebarWidth'
import {
  clampTerminalFontSize,
  readStoredAgentArgs,
  readStoredAgentNotices,
  readStoredDefaultAgent,
  readStoredDiffLayout,
  readStoredEditorCommands,
  readStoredKeepAwake,
  readStoredStartPoints,
  readStoredTerminalFontSize,
  readStoredTerminalOptions,
  sanitizeTerminalOptions,
  type AgentNoticePreference,
  type TerminalOptions,
  type KeepAwakeMode,
  withAgentArgs,
  withEditorCommand,
  withStartPoint,
  writeStoredAgentArgs,
  writeStoredAgentNotices,
  writeStoredDefaultAgent,
  writeStoredDiffLayout,
  writeStoredEditorCommands,
  writeStoredKeepAwake,
  writeStoredStartPoints,
  writeStoredTerminalFontSize,
  writeStoredTerminalOptions
} from './preferences'
import { forgetClosedPanes, markSeen, readPaneSeen, writePaneSeen, type PaneSeen } from './paneSeen'
import type { PatchHunk } from '@shared/patch'
import type { ProjectAddRefusal, ResultOf } from '@shared/methods'
import { parsePastedInvitation, type Invitation } from '@shared/invitation'
import { descendantsOf } from '@shared/taskTree'
import { joinTeam, type JoinStage, type JoinTarget } from '../teamwork/joinTeam'
import type { DiffLayout } from './preferences'
import { createLocalEditFence, createWorkspaceRefresher, refreshTargets, type RefreshTargets } from './workspaceRefresh'
import { readStoredSession, sessionChanged, writeStoredSession } from './storedSession'
import { readSystemTone } from '../theme/systemTone'
import { requestRegionFocus } from '../shell/regions'
import { draftFor, dropDraft, keptDrafts, saverFor } from '../files/fileDrafts'
import {
  changesOnScreen,
  readStoredRightPanel,
  readStoredRightPanelWidth,
  clampRightPanelWidth,
  writeStoredRightPanel,
  writeStoredRightPanelWidth,
  type RightPanelTab
} from '../workspace/rightPanel/rightPanelState'
import { panelCost, sidebarCost, type Sides } from '../workspace/roomForPanes'

export type DialogState =
  /** A picked or dropped folder the runtime would not add as it was. */
  | { kind: 'project-refused'; folder: string; refusal: ProjectAddRefusal }
  | { kind: 'clone-project' }
  | { kind: 'install-cli' }
  | { kind: 'new-task'; projectId: string }
  /** `files`: ⌘P, only the worktree's files. */
  | { kind: 'palette'; mode?: 'files' }
  /** Asked before every removal; `refused` once the runtime has refused one unforced. */
  | { kind: 'confirm-remove'; worktreeId: string; intent: RemoveIntent; refused?: true }
  /** Raised only when the pane is doing work a close would kill. See `closePaneModel`. */
  | { kind: 'confirm-close-pane'; terminalId: string; rest?: readonly string[] }
  /** A file pane with edits not on disk. `rest` is what Close Others closes after Save or Don't Save. */
  | { kind: 'confirm-close-file'; terminalId: string; rest?: readonly string[] }
  /** Edited files asked about before the app quits, the window closes, their worktree is removed, or `ask` is asked. */
  | {
      kind: 'confirm-unsaved'
      paneIds: readonly string[]
      after: 'quit' | 'close' | { remove: string } | { ask: ConfirmAfterUnsaved }
    }
  | ConfirmAfterUnsaved
  /** Throwing away a path's unstaged change, or one hunk of it. */
  | { kind: 'confirm-discard'; worktreeId: string; path: string; hunk?: PatchHunk }
  /** Merging a worktree's branch into the base branch in the project's own checkout. */
  | { kind: 'confirm-merge'; worktreeId: string }
  /** Keeping one run of a task and removing the others; `refused` once the runtime has refused one unforced. */
  | { kind: 'confirm-keep'; worktreeId: string; refused?: true }
  /** An invitation link, opened or pasted, asking where to join from. */
  | { kind: 'join-team'; invitation: Invitation }
  /** A worktree on an existing branch; `pullRequests` lists open pull requests instead of branches. */
  | { kind: 'open-branch'; projectId: string; pullRequests?: true }
  | null

/** Forgetting a project or a worktree, or moving a project's folder to the Trash. */
export type ConfirmAfterUnsaved =
  | { kind: 'confirm-forget'; target: RemoveTarget }
  | { kind: 'confirm-trash-project'; projectId: string }

/** What Remove from teamree forgets. */
export type RemoveTarget = { projectId: string } | { worktreeId: string }

/** A code pane with edits not on disk, and where its file is. */
export type EditedFile = { worktreeId: string; path: string }

/** The three answers to a Save question. */
export type SaveAnswer = 'save' | 'discard' | 'cancel'

/** Why the removal was asked for: a retry removes the old checkout to build a new one, and the confirmation says so. */
export type RemoveIntent = 'remove' | 'retry'

/** What the task composer submits: what to make, who runs it, and from where. */
export type TaskDraft = {
  projectId: string
  startedFrom?: string
  /** An existing branch to open instead of making one (`worktree.create`'s `checkout`), and what it is compared against. */
  checkout?: string
  base?: string
  /** One worktree per entry, in creation order, each already named by `taskCreates`. */
  creates: readonly TaskCreate[]
}

export type Notice = {
  id: number
  text: string
  tone: 'error' | 'info'
  /** One thing to do about the notice: a page to open (`shell/openInBrowser.ts`), a side to hide for room, or an undo. */
  action?: { label: string; url: string } | { label: string; hide: keyof Sides } | { label: string; undo: UndoTarget }
}

/** What an Undo puts back: a removed worktree, or one discard's paths. */
export type UndoTarget =
  | { kind: 'remove'; projectId: string; removedId: string }
  | { kind: 'discard'; worktreeId: string; trashId: string }

/** The last push of one worktree, as the Changes tab shows it. A failure is one clause, and git's words. */
export type PushState =
  | { phase: 'pushing' }
  | { phase: 'pushed'; reviewUrl?: string }
  | { phase: 'failed'; error: string; detail: string }

/** The find bar belongs to the focused pane. `token` changes on every press, which is how a repeat press re-takes an open field. */
export type PaneSearch = { terminalId: string; token: number }

/** How `openFilePane` places a file; see there. */
export type FileOpenMode = 'diff' | 'split' | 'preview' | 'diff-preview'

/** Which of the teamwork panel's three reads last failed, and what each said. */
export type TeamworkReadErrors = { list?: string; relay?: string; status?: string }

/** A relay command running in a pane in this window, one pane per project. Rebuilt from the runtime's list, see `reconcileRelayPanes`. */
export type { RelayPaneKind, RelayPaneState } from '../teamwork/startTeamwork'

/** What Commit takes: the ticked paths plus the index, else the index alone, else every listed change. */
export function commitScope(
  ticked: readonly string[],
  changes: readonly WorktreeChange[]
): 'ticked' | 'staged' | 'all' {
  if (ticked.length > 0) return 'ticked'
  return changes.some((change) => change.staged) ? 'staged' : 'all'
}

/**
 * The worktree id a project's teamwork pane is created under. Namespaced so it cannot collide; the verb
 * is in the id because a `Terminal` carries no command, and a reloaded window has to find a running relay.
 */
export function teamworkPaneWorktreeId(projectId: string, kind: RelayPaneKind): string {
  return `teamwork:${kind}:${projectId}`
}

/** The project and verb an id made by `teamworkPaneWorktreeId` was made from, or null. */
export function teamworkPaneFromWorktreeId(worktreeId: string): { projectId: string; kind: RelayPaneKind } | null {
  const [namespace, kind, ...rest] = worktreeId.split(':')
  // A project id can hold a colon, so the rest is rejoined; the verb is one of three literals.
  const projectId = rest.join(':')
  if (namespace !== 'teamwork' || projectId === '') return null
  if (kind !== 'deploy' && kind !== 'serve' && kind !== 'check') return null
  return { projectId, kind }
}

/**
 * The relay panes this window should show, given what the runtime says is running: a reload empties this
 * map while the relay runs on (the next `serve` dies on `EADDRINUSE`), and a terminal closed elsewhere
 * leaves a dead slot. Dead slots go, unslotted teamwork terminals are adopted, kept slots keep their URL.
 */
export function reconcileRelayPanes(
  panes: Record<string, RelayPaneState>,
  terminals: Record<string, Terminal>
): Record<string, RelayPaneState> {
  const next: Record<string, RelayPaneState> = {}
  for (const terminal of Object.values(terminals)) {
    const owner = teamworkPaneFromWorktreeId(terminal.worktreeId)
    if (owner === null) continue
    const kept = panes[owner.projectId]
    next[owner.projectId] =
      kept?.terminalId === terminal.id
        ? // `running` comes off the record: the runtime is the authority on it.
          kept.running === terminal.running
          ? kept
          : { ...kept, running: terminal.running }
        : { kind: owner.kind, terminalId: terminal.id, url: null, urls: [], running: terminal.running }
  }
  const unchanged =
    Object.keys(next).length === Object.keys(panes).length &&
    Object.entries(next).every(([projectId, pane]) => panes[projectId] === pane)
  return unchanged ? panes : next
}

/** A section of the settings page that can be asked for by name. */
export type SettingsSection = 'agents'

type WorkspaceState = {
  connection: ConnectionState
  runtimeVersion: string | null

  projects: Project[]
  worktrees: Worktree[]
  statuses: Record<string, WorktreeStatus>
  /** When git reads for a worktree started failing, by id; the last good numbers stay on screen but not as current. */
  unreadableSince: Record<string, number>
  terminals: Record<string, Terminal>
  layouts: Record<string, Layout>
  /** The pane filling the workspace, or null. Not in a `Layout`: maximising is a way of looking, not an arrangement. */
  expandedTerminalId: string | null
  /** Worktrees whose file column a split folded to its tab; drawn folded only while `foldsColumn` holds. */
  foldedColumns: Record<string, true>
  /** Draws the worktree's file column in the layout again, narrowed if its old share no longer fits. */
  unfoldColumn: (worktreeId: string) => void

  /** File panes with edits not yet on disk, by pane id; each tab draws a dot. */
  unsavedFiles: Record<string, true>
  /** The code panes among them (markdown saves as it goes), kept drafts from the last launch included. */
  editedFiles: Record<string, EditedFile>
  /** File panes showing their diff rather than their text, by pane id. */
  diffPanes: Record<string, true>
  /** A markdown editor holds the keyboard, so ⌘B and ⌘E are bold and code, not the window's. */
  editingMarkdown: boolean
  /** The worktree whose strip asks for a file name, because NOTES.md is already open. */
  namingMarkdown: string | null
  /** Paths opened in file panes this session, per worktree, latest first; Go to File lists them first. */
  recentFiles: Record<string, readonly string[]>
  /** The pane whose tab shows the name field, or null. */
  editingPaneName: string | null
  /** The worktree whose sidebar row shows the name field, or null. */
  editingWorktreeName: string | null
  /** Bumped when the runtime says a worktree's files moved; a file pane re-reads on it. */
  worktreeFilesEpoch: number

  /** When each pane was last in front of this person, by terminal id. Local, from `localStorage`; see `paneSeen.ts`. */
  paneSeenAt: PaneSeen

  /** Whether each ready worktree would merge into its base, as last read. */
  mergePreviews: Record<string, WorktreeMergePreview>
  /** Where each ready worktree's branch can land, and whether it has, as last read. */
  landings: Record<string, WorktreeLanding>
  /** True while a pull request is being made. */
  openingPullRequest: boolean

  /** The panel right of the panes. Tab, open state and width are this machine's habit; the contents are the worktree's. */
  rightPanelOpen: boolean
  rightPanelTab: RightPanelTab
  rightPanelWidth: number

  changes: Record<string, WorktreeChanges>
  /** What each worktree has committed that its base has not. */
  logs: Record<string, WorktreeLog>
  selectedChangePath: string | null
  /** Paths ticked for the next commit. Held here, not in git's index: browsing must not stage anything. */
  stagedPaths: string[]
  committing: boolean
  pushing: boolean
  pushes: Record<string, PushState>
  /** The worktree whose update from its base is running, or null. */
  updating: string | null
  /** Why each worktree's last update was refused, in one line; cleared by the next attempt. */
  updateErrors: Record<string, string>
  /** Each project's roster, by project id, read on demand: most windows never open one. */
  members: Record<string, MemberList>
  /** True while a roster is being read or written, so the dialog can say so. */
  membersPending: boolean
  /** Why the last attempt to add this machine's key was refused, or null; kept beside the handle box, as `relayError` is. */
  membersError: string | null
  /** Each project's relay, for the ones somebody has looked at. Read beside the roster. */
  relays: Record<string, RelaySetting>
  relayPending: boolean
  /** Why the last relay write was refused, or null. Kept here: the refusal carries the corrected URL, which belongs beside the field. */
  relayError: string | null
  /** True while `origin` is being written, so the button can say so. */
  originPending: boolean
  /** Why the last attempt to set `origin` was refused — git's own words — or null. */
  originError: string | null
  /** The relay command running in a pane, by project id. One per project. */
  relayPanes: Record<string, RelayPaneState>
  /** What committing and pushing the two files would do, by project id; branch and upstream are git's answers. */
  publishPlans: Record<string, TeamworkPublishPlan>
  publishPending: boolean
  /** Why the last attempt could not be made at all, or null. */
  publishError: string | null
  /** What the last attempt did, by project id — including a push that failed. */
  publishResults: Record<string, TeamworkPublish>
  /** What the running publish is doing, by project id, read on a timer: `teamwork.publish` does not answer until the push is over. */
  publishProgress: Record<string, TeamworkPublishProgress>
  /** Whether teamwork is running for each project. Absent means "not asked yet", not "off". */
  teamwork: Record<string, TeamworkStatus>
  /** Why the last read behind the teamwork panel failed, by project id: a read that threw and one in flight both leave the maps empty. */
  teamworkReadErrors: Record<string, TeamworkReadErrors>
  /** What each project's teammates are showing, by project id. */
  teammates: Record<string, TeammatePresence>
  /** Who is reading this machine's panes, by project id. Read on the same invalidation the rest of teamwork is. */
  watchers: Record<string, PaneWatchers>
  /** Whose keystrokes are waiting on this machine's owner, by project id. Read on the teamwork invalidation, not polled. */
  consent: Record<string, PaneConsent>
  /** Teammates' panes open here, in opening order. Closing one closes the subscription, which keeps the relay budget honest. */
  watches: WatchedPane[]
  /** Width fractions for the workspace and each watched pane. Not persisted: the panes only exist while watched. */
  watchSizes: number[]
  /** What each watched pane has printed since opened, trimmed to the last few thousand characters. */
  watchTails: Record<string, string>
  /** The watched pane with the focus, or null. Not in a `Layout`: the runtime would prune it at the next launch. */
  focusedWatchId: string | null
  /** Where this app's CLI is and what is at its link path. Probed once at startup; null means "not asked yet". */
  cli: CliStatus | null
  cliPending: boolean
  /** What the last install did, kept so the panel can say it afterwards. */
  cliInstall: CliInstall | null
  /** Why the last install was refused, or null. Kept beside the button rather than raised as a notice. */
  cliError: string | null
  /** Whether a newer teamree exists. Null means nobody has asked yet. */
  update: UpdateState | null
  /** Settings › Agents › Trust New Worktrees, as the runtime last said. */
  trustNewWorktrees: boolean
  /** Coding agents this machine can run, probed once at startup. */
  agents: InstalledAgent[]
  /** True once the probe has answered; until then an empty `agents` means "not asked yet". */
  agentsProbed: boolean
  /** True while a hunk is being staged or unstaged, so the controls settle. */
  hunkPending: boolean
  /** Removed worktrees that can be restored, newest first, as last read. */
  removedWorktrees: RemovedWorktree[]
  /** Closed terminals the runtime can reopen, and closed file panes, by worktree id, newest first. */
  closedPanes: Record<string, ClosedPane[]>
  closedFiles: ClosedFiles

  collapsedProjects: Record<string, boolean>
  openWorktreeIds: string[]
  activeWorktreeId: string | null
  /** True until `bootstrap` has put the last window's tabs back, or found none to put back. */
  restoring: boolean
  /** Whether the pane dashboard has the main area, replacing the panes rather than sharing with them. */
  dashboardOpen: boolean
  /** Which project's teamwork setup has the main area, or null. About a project, so not bound to a tab. */
  teamworkProjectId: string | null
  /** Whose invitation each project was joined from this run, so its Teamwork page says who it waits for. */
  joinedFrom: Record<string, string>
  /** The Join sheet's press: which stage it is at, or why it stopped. */
  joining: { stage: JoinStage; error: string | null } | null
  /** Whether settings has the main area, and whether help does; neither belongs in a tab. */
  settingsOpen: boolean
  /** The section the settings page opens scrolled to, until it has. */
  settingsSection: SettingsSection | null
  helpOpen: boolean
  /** The theme sheet at the workspace's right edge; the panes stay visible under it. */
  appearanceOpen: boolean

  sidebarWidth: number
  sidebarVisible: boolean
  /** Sides hidden for the panes' room, not by hand: the habit on disk still shows them. */
  roomHid: Sides
  /** Sides a compare on screen hid, shown again when it goes; null with none on screen. */
  compareHid: Sides | null
  paneSearch: PaneSearch | null
  dialog: DialogState
  notices: Notice[]
  /** Pane text size in CSS pixels, the rest of how panes draw, and each project's preferred start point. Held in the store so panes re-render. */
  terminalFontSize: number
  terminalOptions: TerminalOptions
  startPointDefaults: Record<string, string>
  /** Whether an agent stopping while you are elsewhere may say so. The reader is the main process, via `useAgentNotices`. */
  agentNotices: AgentNoticePreference
  /** Whether this Mac may sleep. Held here for the reason `agentNotices` is; `useKeepAwake` publishes it. */
  keepAwake: KeepAwakeMode
  /** Each project's editor: a bundle id from `editors` or a program name. Absent means the first editor found. */
  editorCommands: Record<string, string>
  /** What Open in offers, or null until asked: null is "not looked yet", empty is "found none". */
  editors: ResultOf<'editor.list'>['editors'] | null
  /** Whether the patch in the changes panel is laid out inline or side by side. */
  diffLayout: DiffLayout
  /** The agent kind the composer offers first, and what each kind is launched with. See `preferences.ts`. */
  defaultAgent: string
  agentArgs: Record<string, string>

  /** How this window is painted. Held here so a colour edited in the dialog is live in the panes behind it. */
  appearance: Appearance
  /** What `prefers-color-scheme` says; main points it at the OS under Match System. */
  systemTone: Tone

  bootstrap: () => Promise<void>
  /** Opens the change stream. Returns the stop function an effect cleans up with. */
  startWatching: () => () => void

  /** Answers the refusal when the folder cannot be a project, for the dialog to show; null otherwise. */
  addProject: (path: string, name?: string, init?: boolean) => Promise<ProjectAddRefusal | null>
  /** The OS folder picker, then `addProject`; a refusal opens its dialog. */
  chooseProjectFolder: () => Promise<void>
  /** Clones and adds; answers the one line to show when it did not happen, null when it did. */
  cloneProject: (url: string, path: string) => Promise<string | null>
  /** Creates the worktree, waits for it, then starts the agent in it. */
  startTask: (draft: TaskDraft) => void
  retryWorktree: (worktreeId: string) => void
  /** Asks first, after any unsaved files; nothing is removed until `confirmRemoveWorktree`. */
  removeWorktree: (worktreeId: string) => Promise<void>
  /** The answer to that question; unforced, a refusal asks again. */
  confirmRemoveWorktree: (worktreeId: string, force: boolean) => Promise<void>
  /** Asks first, after any unsaved files; nothing is forgotten until `confirmForget`. */
  removeFromTeamree: (target: RemoveTarget) => Promise<void>
  /** Forgets it in the runtime, then here; the disk is left alone. */
  confirmForget: (target: RemoveTarget) => Promise<void>
  /** Asks first, after any unsaved files; nothing moves until `confirmTrashProject`. */
  trashProject: (projectId: string) => Promise<void>
  confirmTrashProject: (projectId: string) => Promise<void>
  /** Shown at once; a refusal puts the old name back. A blank name is ignored. */
  renameWorktree: (worktreeId: string, name: string) => Promise<void>
  loadRemovedWorktrees: () => Promise<void>
  /** Checks a removed worktree out again with its uncommitted work, and opens it. */
  restoreWorktree: (projectId: string, removedId: string) => Promise<void>
  undo: (target: UndoTarget) => Promise<void>

  openWorktree: (worktreeId: string) => Promise<void>
  closeWorktreeTab: (worktreeId: string) => void
  /** Opens the worktree a pane lives in and puts the focus on that pane. */
  revealPane: (worktreeId: string, terminalId: string) => Promise<void>
  /** Chooses an answer an asking pane's menu offers; one that wants typing, or a menu gone since, goes to the pane. */
  answerPane: (terminalId: string, choice: ScreenChoice) => Promise<void>

  /** Puts the focus on one pane, whether it is yours or a teammate's. */
  focusPane: (paneId: string) => void
  /** Writes down that these panes are in front of this person now. */
  markPanesSeen: (terminalIds: readonly string[]) => void
  /** Adopts a fresh terminal record, e.g. the one a resize answers with. */
  recordTerminal: (terminal: Terminal) => void
  splitFocusedPane: (direction: 'row' | 'column') => Promise<void>
  /** Closes a pane, asking first when the close would kill work. Every close path comes through here, so the question is asked once. */
  closeTerminal: (terminalId: string) => Promise<void>
  loadClosedPanes: (worktreeId: string) => Promise<void>
  /** Brings back the open worktree's last closed pane, of either kind. */
  reopenClosedPane: () => Promise<void>
  /** Brings back one closed terminal, or the last one; an agent resumes its conversation. */
  reopenTerminal: (worktreeId: string, terminalId?: string) => Promise<void>
  /** Names a pane, or clears the name when given nothing. */
  renamePane: (terminalId: string, label: string) => Promise<void>
  /** Opens the tab's name field on a pane, or shuts it with null. */
  editPaneName: (terminalId: string | null) => void
  /** Puts the sidebar row's name field up, showing the sidebar and the project first. */
  editWorktreeName: (worktreeId: string | null) => void
  /** Closes panes in order, stopping at each that `closeTerminal` would ask about; either answer moves on. */
  closePanes: (terminalIds: readonly string[]) => Promise<void>
  /** Every pane of the open worktree but this one, which takes the focus. */
  closeOtherPanes: (terminalId: string) => Promise<void>
  /** Goes through with it, once the question this app asked has been answered. */
  forceCloseTerminal: (terminalId: string) => Promise<void>
  /** Runs an exited pane's program again, in the same pane. */
  relaunchTerminal: (terminalId: string) => Promise<void>
  createTerminal: (worktreeId: string) => Promise<void>
  /**
   * Opens `path` as a tab of the file column, or focuses the tab already on it; `diff` shows its diff,
   * `split` puts it to the right of the focused pane instead, `preview` replaces the preview tab, `diff-preview` both.
   */
  openFilePane: (worktreeId: string, path: string, mode?: FileOpenMode) => void
  /** Opens a path a pane printed: its diff when it has changes, else its code at `line`. */
  openFileAt: (worktreeId: string, path: string, line?: number, column?: number) => Promise<void>
  /** Where the next code pane on this path puts its cursor, until it has; `token` tells two requests apart. */
  goToLine: { worktreeId: string; path: string; line: number; column: number; token: number } | null
  /** Forgets the request once a code pane has gone to it. */
  wentToLine: (token: number) => void
  /** Opens a commit read-only as a tab of the file column, or focuses the tab already on it. */
  openCommit: (worktreeId: string, commit: WorktreeCommitSummary) => void
  /** Opens `worktreeId` with a read-only compare against `otherId` as a tab of its file column, or focuses that tab. */
  openCompare: (worktreeId: string, otherId: string, title: string) => Promise<void>
  /** Opens every change of the worktree as one read-only tab of its file column, zoomed, or focuses that tab. */
  openReview: (worktreeId: string) => void
  /** Opens a note a teammate shared, read-only, as a tab in a worktree of its project; focuses the tab already on it. */
  openSharedNote: (projectId: string, shareId: string, title: string) => Promise<void>
  /** Says something in the corner; an `info` retires itself. */
  showNotice: (text: string, tone?: Notice['tone']) => void
  /** Keeps a preview tab open when the next preview comes. */
  pinFilePane: (paneId: string) => void
  /** Shows a file pane's diff, or its text again. */
  setPaneDiff: (paneId: string, on: boolean) => void
  /** `New Markdown`: NOTES.md, or a name asked for in the strip when that is already open. */
  newMarkdown: (worktreeId: string) => void
  /** Answers the strip's question with a name, or null to withdraw it. */
  nameMarkdown: (name: string | null) => void
  setFileUnsaved: (paneId: string, dirty: boolean) => void
  /** A code pane's edits are off disk, or back on it with null; keeps `unsavedFiles` in step. */
  setFileEdited: (paneId: string, file: EditedFile | null) => void
  /** Writes these panes' edits; false as soon as one does not save. */
  saveFiles: (paneIds: readonly string[]) => Promise<boolean>
  /** Asks about every edited file before a quit or a window close; resolves whether it may go on. */
  askBeforeLeaving: (reason: 'quit' | 'close') => Promise<boolean>
  /** Answers the Save question on screen. */
  answerUnsaved: (answer: SaveAnswer) => Promise<void>
  setEditingMarkdown: (editing: boolean) => void
  focusNextPane: () => void
  /** The other way round the same cycle. See `paneCycle`. */
  focusPreviousPane: () => void
  /** Focuses a pane of your own, giving the tree back first if a pane is maximized. */
  showPane: (paneId: string) => void
  /** Fills the workspace with the focused pane, or gives the tree back. */
  toggleExpandedPane: () => void
  /** Fills the workspace with this pane, or gives the tree back when it already does. */
  expandPane: (terminalId: string) => void
  /** Opens the worktree one row along the sidebar, wrapping at both ends. */
  stepWorktree: (step: 1 | -1) => void
  applySplitSizes: (worktreeId: string, path: number[], sizes: number[]) => void
  /** Rearranges the open worktree's panes, focusing `focus`; refused, said, when a pane would end under its floor. */
  arrangePanes: (arrange: (root: PaneNode) => PaneNode, focus: string) => void
  /** Opens the find bar over the focused pane, or re-takes it if it is already there. */
  openPaneSearch: () => void
  closePaneSearch: () => void

  /** Opens the right panel on the changes tab, or closes it when that is showing. */
  toggleChanges: () => void
  /** Opens the right panel, or closes it, on whichever tab it last showed. */
  toggleRightPanel: () => void
  /** Opens the right panel on one tab. */
  showRightPanelTab: (tab: RightPanelTab) => void
  /** Hides the panel or the sidebar if it is showing, and keeps hidden what `makeRoom` hid. */
  hideRegion: (region: keyof Sides) => void
  /** Hides the sides `hide` names for the panes' room and shows again those it hid; a hand toggle takes a side back. */
  makeRoom: (hide: Sides) => void
  setRightPanelWidth: (width: number) => void
  /** Selects one changed path and opens its diff in the centre as the preview tab, kept when `pin`; null clears. */
  selectChange: (path: string | null, pin?: boolean) => void
  /** Adds or removes one path from what the next commit will capture. */
  toggleStaged: (path: string) => void
  /** Every changed path, or none. */
  setAllStaged: (staged: boolean) => void
  /** Commits what `commitScope` names; true when it landed. */
  commitStaged: (message: string) => Promise<boolean>
  /** Puts one hunk into the index, or takes it out. The hunk is exactly what was on screen; the runtime refuses it if the file moved on. */
  applyHunk: (worktreeId: string, path: string, hunk: PatchHunk, staged: boolean) => Promise<void>
  /** Takes a whole path out of the index and unticks it. The working tree is never touched. */
  unstagePath: (worktreeId: string, path: string) => Promise<void>
  /** Throws away a path's unstaged change, or one unstaged hunk. The index is never touched. */
  discardChange: (worktreeId: string, path: string, hunk?: PatchHunk) => Promise<void>
  /** Sends the active worktree's branch to its remote. Never forces. */
  pushActiveWorktree: () => Promise<void>
  /** Brings the base ref's new commits into a worktree: rebase if unpublished, merge if published. */
  updateWorktree: (worktreeId: string) => Promise<void>
  /** Undoes an update stopped on conflicts. */
  abortUpdate: (worktreeId: string) => Promise<void>
  /** Types a line into a pane without pressing Return. */
  typeIntoPane: (terminalId: string, text: string) => Promise<void>
  /** `gh pr create` for a published branch, else the host's page for one in the browser; an open one is opened. */
  createPullRequest: (worktreeId: string) => Promise<void>
  /** Merges into the base branch in the project's checkout; answers with why not, or null once merged. */
  mergeIntoBase: (worktreeId: string) => Promise<string | null>
  /** Keeps one run of a task, removes the others and opens the one kept. Their branches stay. */
  confirmKeepRun: (worktreeId: string, force: boolean) => Promise<void>
  /** Hides the sidebar and panel for a compare on screen, and shows again what it hid. */
  foldForCompare: (on: boolean) => void
  /** Opens a pane already running one of the agents found on this machine. */
  startAgent: (command: string) => Promise<void>

  /** Reads where the CLI is and what is at its destination. */
  loadCli: () => Promise<void>
  /** Links the CLI into /usr/local/bin, asking for an administrator password only when needed. */
  installCli: () => Promise<void>
  /** Records that this installation has been asked, so the first-run offer is made once. Declining and accepting both come here. */
  dismissCliPrompt: () => Promise<void>

  /** Re-reads what the runtime knows about newer releases. Asks nobody. */
  loadUpdate: () => Promise<void>
  /** Asks GitHub now, because somebody chose to: raises a notice even when the answer is "you are current", and when it fails. */
  checkForUpdates: () => Promise<void>
  /** Opens the newer release's download in the browser. */
  downloadUpdate: () => Promise<void>
  /** Fetches the verified `.dmg` into ~/Downloads; progress arrives as `update.download`. */
  fetchInstaller: () => Promise<void>
  /** Opens the fetched `.dmg`, which mounts it. */
  openInstaller: () => Promise<void>
  /** Quits as Quit does, then the fetched copy replaces this one and opens. */
  /** True once the app is quitting; false when it stays, the card saying why. */
  restartToUpdate: () => Promise<boolean>
  /** Turns the automatic check on or off. Remembered between runs. */
  setAutomaticUpdates: (automatic: boolean) => Promise<void>
  loadAgentTrust: () => Promise<void>
  setTrustNewWorktrees: (on: boolean) => Promise<void>

  /** Reads one project's roster. */
  loadMembers: (projectId: string) => Promise<void>
  /** Drops the last join refusal, for the keystroke that answers it. */
  clearMembersError: () => void
  /** Reads where one project's relay is recorded, and what each place said. */
  loadRelay: (projectId: string) => Promise<void>
  /** Re-reads whether teamwork is running for one project, on open rather than on the next event. */
  loadTeamwork: (projectId: string) => Promise<void>
  /** Writes the relay into the repository and stops: pushing it is what makes it the team's. */
  setRelay: (projectId: string, url: string) => Promise<void>
  /** Points this checkout's `origin` at a URL and re-reads the status so the blocked step goes green. */
  setOrigin: (projectId: string, url: string) => Promise<void>
  /** Runs one of the shipped relay launcher's verbs in a pane. `argument` is the URL a check dials. Refuses while a pane is open. */
  startRelayPane: (projectId: string, kind: RelayPaneKind, argument?: string) => Promise<void>
  /** Closes that pane, killing the command if it is still running. */
  closeRelayPane: (projectId: string) => Promise<void>
  /** Records what the pane has printed so far, and whether it is still up. */
  noteRelayPane: (projectId: string, output: string, running: boolean) => void
  /** Reads what the commit-and-push button would do. */
  loadPublishPlan: (projectId: string) => Promise<void>
  /** Stages the two files, commits them, and pushes. Never more than those files. */
  publishTeamwork: (projectId: string) => Promise<void>
  /** Reads what the running publish is doing, so the panel can say it. */
  loadPublishProgress: (projectId: string) => Promise<void>
  /** Stops the running publish. Whatever was committed stays committed. */
  cancelPublish: (projectId: string) => Promise<void>
  /** Writes this installation's key into the project. Neither commits nor pushes, and the dialog says so. */
  joinProject: (projectId: string, handle?: string) => Promise<void>
  /** Opens the Join sheet for an invitation link or the older invitation text; answers why not (a notice too when `announce`), or null. */
  openInvitation: (raw: string, announce?: boolean) => string | null
  /** The Join sheet's button: clone or reuse, key, push, then the team page. See `joinTeam.ts`. */
  joinTeam: (invitation: Invitation, target: JoinTarget) => Promise<void>
  /** Writes the project's setup as it applies here to `.teamree/project.json`, uncommitted. */
  saveProjectSettings: (projectId: string) => Promise<void>
  /** Runs or skips a repository's setup command a new worktree is waiting on; Run approves it for the project. */
  answerSetup: (worktreeId: string, run: boolean) => Promise<void>
  /**
   * Stops or restarts teammates' keystrokes reaching a pane. Applied here, not waited for from the
   * stream: a mute that took a round trip to look pressed would be pressed twice.
   */
  mutePane: (terminalId: string, muted: boolean) => Promise<void>
  /**
   * Answers one held burst. `through` is how many keystrokes the window drew: a burst grows while the
   * prompt is up, and what arrived after must be asked about. Applied here, not waited for, as the mute is.
   */
  decideConsent: (requestId: string, decision: ConsentDecision, through: number) => Promise<void>
  /** Takes back a standing permission. Instant and local, exactly like a mute. */
  revokeConsent: (terminalId: string, publicKey: string) => Promise<void>
  /** Opens a teammate's pane here, or closes the one open on it: the second press being a close keeps stopping reachable from the row. */
  toggleWatchedPane: (projectId: string, pane: { terminalId: string; label: string; handle: string }) => void
  /** Closes one, which is what stops the bytes: the pane is the subscription. */
  closeWatchedPane: (id: string) => void
  /** Records what a watched pane has printed, so a sidebar row can quote it. */
  noteWatchedPaneOutput: (id: string, data: string) => void
  /** Keeps the width the gutters beside the watched panes were dragged to. */
  setWatchSizes: (sizes: number[]) => void

  toggleProject: (projectId: string) => void
  toggleDashboard: () => void
  /** Gives the main area to one project's teamwork setup. */
  openTeamwork: (projectId: string) => void
  /** Gives it back, to whatever the window was showing before. */
  closeTeamwork: () => void
  /** Gives the main area to settings, or takes it back. */
  toggleSettings: () => void
  /** Opens the settings page with the named section in view. */
  openSettings: (section: SettingsSection) => void
  /** The same for help. */
  toggleHelp: () => void
  showAppearance: (open: boolean) => void
  /**
   * Asks the OS file manager to show a path. The one thing in the renderer that touches the filesystem,
   * so it goes over the preload bridge (see `src/main/reveal`). `what` names the thing for the refusal notice.
   */
  revealInFinder: (path: string, what: string) => Promise<void>
  /** Opens a file in the app the OS picks for it. */
  openInDefaultApp: (path: string, what: string) => Promise<void>
  /** Sets the size of the text in every pane, and remembers it. */
  setTerminalFontSize: (size: number) => void
  /** Changes some of how every pane draws and reads keys, and remembers all of it. */
  setTerminalOptions: (patch: Partial<TerminalOptions>) => void
  /** Sets what an agent going quiet may do, and remembers it. */
  setAgentNotices: (preference: AgentNoticePreference) => void
  /** Sets whether this Mac may sleep, and remembers it. */
  setKeepAwake: (mode: KeepAwakeMode) => void
  /** Sets whether a patch is read down one column or across two, and remembers it. */
  setDiffLayout: (layout: DiffLayout) => void
  /** Sets one project's preferred start point, or clears it when given null. */
  setStartPointDefault: (projectId: string, ref: string | null) => void
  /** Sets the agent the composer offers first; `NO_DEFAULT_AGENT` clears it. */
  setDefaultAgent: (kind: string) => void
  /** Sets one agent's launch arguments, or clears them when given null. */
  setAgentArgs: (kind: string, args: string | null) => void
  /**
   * Sets what a project's new worktrees carry over and the command they run. A given field replaces the
   * stored one, empty clears it. In the workspace, not local storage: a CLI-created worktree is prepared the same way.
   */
  setProjectPaths: (
    projectId: string,
    settings: { linkedPaths?: string[]; copiedPaths?: string[]; setupCommand?: string; fetchInBackground?: boolean }
  ) => Promise<void>
  /** Sets one project's editor command, or clears it when given null. */
  setEditorCommand: (projectId: string, command: string | null) => void
  /** Asks the main process which editors, terminals and Finder are installed, once per run. */
  loadEditors: () => Promise<void>
  /** Opens a path. `command` is a listed app's or the project's own, absent for the first editor; `what` names it for the refusal. */
  openInEditor: (path: string, command: string | undefined, what: string) => Promise<void>
  /** Puts text on the clipboard, and says so. `what` names it in the notice. */
  copyToClipboard: (text: string, what: string) => Promise<void>
  /** Copies the text a pane shows, or its retained output replayed when it is not on screen. */
  copyPaneOutput: (terminalId: string, name: string) => Promise<void>
  setSidebarWidth: (width: number) => void
  toggleSidebar: () => void
  /**
   * Applies an appearance and remembers it, with no draft: the window behind the dialog is the preview.
   * The runtime coalesces disk writes, so a colour being dragged is cheap enough to save every frame of.
   */
  setAppearance: (appearance: Appearance) => Promise<void>
  setSystemTone: (tone: Tone) => void
  openDialog: (dialog: NonNullable<DialogState>) => void
  closeDialog: () => void
  dismissNotice: (id: number) => void
}

let noticeSeq = 0
let goToSeq = 0

/** The status-bar notice for a pane refused for want of room. */
const NO_ROOM = 'No room for another pane'

/** A title short enough to leave room for its notice's button. */
const shortened = (title: string): string => (title.length > 32 ? `${title.slice(0, 31).trimEnd()}…` : title)

const RECENT_FILES_KEPT = 30
/** Stands in for the pane a split would make, to measure it before asking. */
const SPLIT_PROBE_ID = 'probe:split'

const storage = typeof window === 'undefined' ? undefined : window.localStorage

/** What the last window in this installation was showing, read once at startup. */
const lastSession = readStoredSession(storage)
const lastDrafts = [...keptDrafts()]
const lastPanel = readStoredRightPanel(storage)

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => {
  const notify = (text: string, tone: Notice['tone'] = 'error', action?: Notice['action']): void => {
    const notice: Notice = { id: ++noticeSeq, text, tone, ...(action === undefined ? {} : { action }) }
    set((state) => ({ notices: [...state.notices.slice(-2), notice] }))
    // Plain news retires itself; see `noticeLifetime` for which notices do not.
    const lifetime = noticeLifetime(notice)
    if (lifetime !== null) setTimeout(() => get().dismissNotice(notice.id), lifetime)
  }

  const failed = (what: string) => (error: unknown) => {
    notify(`${what}: ${error instanceof Error ? error.message : String(error)}`)
  }

  // One OS sheet at a time: a second press while it is up would queue another.
  let picking = false

  // The main process waits on this answer, so it is always settled: answered, replaced or dismissed.
  let leaving: ((proceed: boolean) => void) | null = null
  const settleLeaving = (proceed: boolean): void => {
    const settle = leaving
    leaving = null
    settle?.(proceed)
  }

  /** Throws these panes' edits away, drafts included. */
  const forgetEdits = (paneIds: readonly string[]): void => {
    for (const paneId of paneIds) dropDraft(paneId)
    set((state) => {
      if (!paneIds.some((id) => state.editedFiles[id] !== undefined || state.unsavedFiles[id] !== undefined)) return {}
      const unsavedFiles = { ...state.unsavedFiles }
      const editedFiles = { ...state.editedFiles }
      for (const paneId of paneIds) {
        delete unsavedFiles[paneId]
        delete editedFiles[paneId]
      }
      return { unsavedFiles, editedFiles }
    })
  }

  const editedIn = (worktreeId: string): string[] =>
    Object.entries(get().editedFiles)
      .filter(([, file]) => file.worktreeId === worktreeId)
      .map(([paneId]) => paneId)

  /** A teamwork-panel read threw. Kept beside the notice: the panel is where the step that cannot be answered is. */
  const readFailed = (projectId: string, read: keyof TeamworkReadErrors, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error)
    set((state) => ({
      teamworkReadErrors: {
        ...state.teamworkReadErrors,
        [projectId]: { ...state.teamworkReadErrors[projectId], [read]: message }
      }
    }))
  }

  /** The same read has since succeeded, so its refusal is history. */
  const readSucceeded = (projectId: string, read: keyof TeamworkReadErrors): void => {
    set((state) => {
      const current = state.teamworkReadErrors[projectId]
      if (current?.[read] === undefined) return {}
      const rest = { ...current }
      delete rest[read]
      return { teamworkReadErrors: { ...state.teamworkReadErrors, [projectId]: rest } }
    })
  }

  // Layouts are the one thing the user edits directly, so an in-flight layout read must not land on top of an edit.
  const layoutEdits = createLocalEditFence()

  const refreshProjects = async (): Promise<void> => {
    set({ projects: await runtimeClient.call('project.list', {}) })
  }

  /** Returns the worktrees whose git status is worth re-reading. */
  const refreshWorktrees = async (): Promise<string[]> => {
    const worktrees = await runtimeClient.call('worktree.list', {})
    const live = new Set(worktrees.map((worktree) => worktree.id))

    // A removed worktree takes its tab and panes but nobody to another tab: the one in front going
    // away leaves nothing in front, because a tab this window did not choose is a pane the next
    // keystroke lands in unchosen. `closeWorktreeTab` does pick a neighbour, and is a click.
    set((state) => {
      const openWorktreeIds = state.openWorktreeIds.filter((id) => live.has(id))
      return {
        worktrees,
        openWorktreeIds,
        activeWorktreeId: state.activeWorktreeId && live.has(state.activeWorktreeId) ? state.activeWorktreeId : null,
        layouts: keptFor(state.layouts, live),
        statuses: keptFor(state.statuses, live),
        unreadableSince: keptFor(state.unreadableSince, live),
        mergePreviews: keptFor(state.mergePreviews, live),
        landings: keptFor(state.landings, live),
        logs: keptFor(state.logs, live),
        pushes: keptFor(state.pushes, live)
      }
    })

    // A worktree that only just became ready has panes now but no layout here.
    const missing = get().openWorktreeIds.filter((id) => !(id in get().layouts))
    if (missing.length > 0) refresher.request(refreshTargets({ layouts: missing }))

    return worktrees.filter(hasCheckout).map((worktree) => worktree.id)
  }

  const refreshTerminals = async (): Promise<void> => {
    const listed = await runtimeClient.call('terminal.list', {})
    // Replaced wholesale: the runtime's list is the whole truth, and a terminal closed elsewhere has to leave.
    const terminals = Object.fromEntries(listed.map((terminal) => [terminal.id, terminal]))
    // The relay pane slot and the seen record are reconciled against the same list: a closed terminal's id is never issued again.
    set((state) => ({
      terminals,
      relayPanes: reconcileRelayPanes(state.relayPanes, terminals),
      paneSeenAt: forgetClosedPanes(state.paneSeenAt, terminals)
    }))
  }

  /**
   * The size to open a pane at, or nothing. A full-screen agent reads its terminal size once at startup,
   * so a pane spawned at 80x24 and corrected a frame later stays drawn wrong (`paneMetrics.ts`). Nothing
   * lets the runtime's default stand, as it does for a pane the CLI opens.
   */
  const paneRoomFor = (worktreeId: string): NewPane | 'full' | undefined =>
    newPaneRoom(get().terminalFontSize, get().terminalOptions.fontFamily, get().layouts[worktreeId]?.root ?? null)
  const paneSizeFor = (worktreeId: string): Partial<NewPane> => {
    const room = paneRoomFor(worktreeId)
    return room === undefined || room === 'full' ? {} : room
  }
  /** `paneSizeFor` for a pane somebody asked for here, or null, said, when every place is under `MIN_PANE_CELLS`. */
  const roomOrRefuse = (worktreeId: string): Partial<NewPane> | null => {
    const room = paneRoomFor(worktreeId)
    if (room !== 'full') return room ?? {}
    const root = get().layouts[worktreeId]?.root ?? null
    refuseForRoom((grid, area) => roomForNewPane(root, grid.cell, area) !== 'full')
    return null
  }
  /** Says `NO_ROOM`, replacing the last one, with the side to hide when hiding it `fits` the pane. */
  const refuseForRoom = (fits: (grid: { minPane: Box; cell: Box }, area: Box) => boolean): void => {
    set((state) => ({ notices: state.notices.filter((notice) => notice.text !== NO_ROOM) }))
    const grid = paneGrid(get().terminalFontSize, get().terminalOptions.fontFamily)
    const { rightPanelOpen, rightPanelWidth, sidebarVisible, sidebarWidth } = get()
    const widened = (by: number): boolean =>
      grid !== undefined && fits(grid, { width: grid.area.width + by, height: grid.area.height })
    if (rightPanelOpen && widened(panelCost(rightPanelWidth))) {
      notify(NO_ROOM, 'info', { label: 'Hide panel', hide: 'panel' })
    } else if (
      !rightPanelOpen &&
      sidebarVisible &&
      widened(sidebarCost(sidebarWidth, globalThis.window?.innerWidth ?? 0))
    ) {
      notify(NO_ROOM, 'info', { label: 'Hide sidebar', hide: 'sidebar' })
    } else {
      notify(NO_ROOM, 'info')
    }
  }
  /** `after` if it leaves every pane its floor, else `fallback`'s answer; null, said, when neither does. */
  const withRoom = (
    before: PaneNode | null,
    after: PaneNode,
    fallback: (grid: { area: Box; minPane: Box }) => PaneNode | null = () => null
  ): PaneNode | null => {
    const grid = paneGrid(get().terminalFontSize, get().terminalOptions.fontFamily)
    if (!grid || leavesRoom(before, after, grid.area, grid.minPane)) return after
    const placed = fallback(grid)
    if (placed === null) {
      refuseForRoom(
        ({ minPane }, area) => leavesRoom(before, after, area, minPane) || fallback({ area, minPane }) !== null
      )
    }
    return placed
  }

  const refreshLayout = async (worktreeId: string): Promise<void> => {
    // Nothing on screen depends on the layout of a worktree with no tab open.
    if (!get().openWorktreeIds.includes(worktreeId)) return
    const token = layoutEdits.mark(worktreeId)
    const layout = await runtimeClient.call('layout.get', { worktreeId })
    if (layoutEdits.isStale(worktreeId, token)) return
    set((state) => ({ layouts: { ...state.layouts, [worktreeId]: keepingFocus(state, layout) } }))
  }

  /**
   * The runtime's layout with this window's focus kept: the runtime focuses every pane it opens for
   * anyone (CLI, hook, another window), and that is a report, not a request to type there. A pane this
   * window asked for is named in `panesAskedFor` first and is the exception. Only the tab in front.
   */
  const panesAskedFor = new Set<string>()
  const keepingFocus = (
    state: { activeWorktreeId: string | null; layouts: Record<string, Layout> },
    layout: Layout
  ): Layout => {
    if (layout.focusedTerminalId !== null && panesAskedFor.delete(layout.focusedTerminalId)) return layout
    if (layout.worktreeId !== state.activeWorktreeId) return layout
    const focused = state.layouts[layout.worktreeId]?.focusedTerminalId ?? null
    if (focused === null || focused === layout.focusedTerminalId) return layout
    if (!collectTerminalIds(layout.root).includes(focused)) return layout
    return { ...layout, focusedTerminalId: focused }
  }

  const refreshStatuses = async (worktreeIds: string[]): Promise<void> => {
    if (worktreeIds.length === 0) return
    const statuses = await Promise.all(
      // One unreadable worktree must not cost the others their chips.
      worktreeIds.map((worktreeId) => runtimeClient.call('worktree.status', { worktreeId }).catch(() => null))
    )
    const readAt = Date.now()
    set((state) => {
      const next = { ...state.statuses }
      const unreadableSince = { ...state.unreadableSince }
      statuses.forEach((status, index) => {
        const worktreeId = worktreeIds[index] as string
        if (status) {
          next[status.worktreeId] = status
          delete unreadableSince[worktreeId]
          return
        }
        // Kept from the first failure, so the row can say how long it has been unable to confirm itself.
        unreadableSince[worktreeId] ??= readAt
      })
      return { statuses: next, unreadableSince }
    })
  }

  /** The commits this worktree made, on the same trigger as its changes: an agent that finishes commits, and every change disappears. */
  const refreshLog = async (worktreeId: string): Promise<void> => {
    const log = await runtimeClient.call('worktree.log', { worktreeId }).catch(() => null)
    if (!log) return
    set((state) => ({ logs: { ...state.logs, [worktreeId]: log } }))
  }

  const refreshChanges = async (worktreeId: string): Promise<void> => {
    const changes = await runtimeClient.call('worktree.changes', { worktreeId }).catch(() => null)
    if (!changes) return
    const live = new Set(changes.changes.map((change) => change.path))
    set((state) => ({
      changes: { ...state.changes, [worktreeId]: changes },
      // A path that stopped being a change cannot stay ticked for a commit that would then fail.
      stagedPaths: state.stagedPaths.filter((path) => live.has(path))
    }))
  }

  /** The changes list and the commit log, for a panel that has just come on screen. */
  const readChangesNow = (worktreeId: string): void => {
    void refreshChanges(worktreeId).catch(failed('Could not read the changes'))
    void refreshLog(worktreeId).catch(() => undefined)
  }

  /** How many `git merge-tree` processes may be in flight at once; ten worktrees fanning out ten per file change is not worth it. */
  const MERGE_PREVIEW_CONCURRENCY = 4

  /** Reads mergeability for the worktrees named, a few at a time; a failure is dropped so one unreadable worktree costs nobody else. */
  const refreshMergePreviews = async (worktreeIds: string[]): Promise<void> => {
    if (worktreeIds.length === 0) return
    const queue = [...worktreeIds]
    const found: WorktreeMergePreview[] = []

    const worker = async (): Promise<void> => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const preview = await runtimeClient.call('worktree.mergePreview', { worktreeId: next }).catch(() => null)
        if (preview) found.push(preview)
      }
    }
    await Promise.all(Array.from({ length: Math.min(MERGE_PREVIEW_CONCURRENCY, queue.length) }, worker))

    set((state) => ({
      mergePreviews: found.reduce((map, preview) => ({ ...map, [preview.worktreeId]: preview }), {
        ...state.mergePreviews
      })
    }))
  }

  /** Where the worktrees named can land, a few at a time; one unreadable worktree costs nobody else. */
  const refreshLandings = async (worktreeIds: string[]): Promise<void> => {
    const queue = [...worktreeIds]
    const found: WorktreeLanding[] = []
    const worker = async (): Promise<void> => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const landing = await runtimeClient.call('worktree.landing', { worktreeId: next }).catch(() => null)
        if (landing) found.push(landing)
      }
    }
    await Promise.all(Array.from({ length: Math.min(MERGE_PREVIEW_CONCURRENCY, queue.length) }, worker))
    if (found.length === 0) return
    set((state) => ({
      landings: found.reduce((map, landing) => ({ ...map, [landing.worktreeId]: landing }), { ...state.landings })
    }))
  }

  const markExited = (exits: RefreshTargets['exits']): void => {
    set((state) => {
      const terminals = { ...state.terminals }
      for (const exit of exits) {
        const terminal = terminals[exit.terminalId]
        if (terminal) terminals[exit.terminalId] = { ...terminal, running: false, exitCode: exit.exitCode }
      }
      return { terminals }
    })
  }

  /**
   * The worktrees whose git numbers are being shown: open tabs plus rendered sidebar rows. The
   * invalidation names no worktree, so without this one file change costs two git processes per ready
   * worktree, up to once a second. Honest only as long as coming into view is a read: see `readOnScreen`.
   */
  const onScreenWorktreeIds = (): Set<string> => {
    const { openWorktreeIds, sidebarVisible, collapsedProjects, worktrees } = get()
    const shown = new Set(openWorktreeIds)
    if (!sidebarVisible) return shown
    for (const worktree of worktrees) {
      if (!collapsedProjects[worktree.projectId]) shown.add(worktree.id)
    }
    return shown
  }

  const applyRefresh = async (targets: RefreshTargets): Promise<void> => {
    // An exit is fully described by its event, so it costs no call at all.
    if (targets.exits.length > 0) markExited(targets.exits)

    const stale = new Set(targets.statuses)
    // Status has a change stream of its own; a terminal starting or exiting is still a command
    // boundary worth one read for the open tabs.
    if (targets.terminals || targets.exits.length > 0) {
      for (const worktreeId of get().openWorktreeIds) stale.add(worktreeId)
    }

    const reads: Promise<unknown>[] = []
    if (targets.projects) reads.push(refreshProjects())
    if (targets.terminals) reads.push(refreshTerminals())
    if (targets.members) reads.push(refreshMembers(), refreshRelays())
    if (targets.teammates) reads.push(refreshTeammates())
    if (targets.updates) reads.push(get().loadUpdate())
    for (const worktreeId of targets.layouts) reads.push(refreshLayout(worktreeId))
    if (targets.worktrees) {
      set((state) => ({ worktreeFilesEpoch: state.worktreeFilesEpoch + 1 }))
      reads.push(
        refreshWorktrees().then((ready) => {
          for (const worktreeId of ready) stale.add(worktreeId)
        })
      )
    }

    await Promise.all(reads)
    // Last, so a status is never asked for a worktree the list just dropped, nor one nothing is showing.
    const live = new Set(get().worktrees.map((worktree) => worktree.id))
    const onScreen = onScreenWorktreeIds()
    const readable = [...stale].filter((worktreeId) => live.has(worktreeId) && onScreen.has(worktreeId))
    await refreshStatuses(readable)
    // After the statuses: a row without chips has nowhere for a merge badge.
    await Promise.all([refreshMergePreviews(readable), refreshLandings(readable)])

    // The panel rides the same signal as the chips, so an edit in a shell moves both at once.
    const { activeWorktreeId } = get()
    if (!changesOnScreen(get()) || !activeWorktreeId || !readable.includes(activeWorktreeId)) return
    await Promise.all([refreshChanges(activeWorktreeId), refreshLog(activeWorktreeId)])
  }

  /** Re-reads the rosters this window holds: the `members` event names no project, and only opened rosters are in the map. */
  const refreshMembers = async (): Promise<void> => {
    const projectIds = Object.keys(get().members)
    if (projectIds.length === 0) return
    const lists = await Promise.all(
      // One unreadable roster must not cost the others theirs.
      projectIds.map((projectId) => runtimeClient.call('members.list', { projectId }).catch(() => null))
    )
    set((state) => ({
      members: lists.reduce((map, list) => (list ? { ...map, [list.projectId]: list } : map), { ...state.members })
    }))
  }

  /** The other half of `.teamree`, on the same signal: the watch covers the whole directory. Opened projects only, as the rosters are. */
  const refreshRelays = async (): Promise<void> => {
    const projectIds = Object.keys(get().relays)
    if (projectIds.length === 0) return
    const settings = await Promise.all(
      projectIds.map((projectId) => runtimeClient.call('teamwork.relay', { projectId }).catch(() => null))
    )
    set((state) => ({
      relays: settings.reduce((map, setting) => (setting ? { ...map, [setting.projectId]: setting } : map), {
        ...state.relays
      })
    }))
  }

  /**
   * Re-reads teamwork for every project, not only those held: a link coming up is when a project starts
   * having something to say. The reads are cheap, and one project failing must not cost the others theirs.
   */
  const refreshTeammates = async (): Promise<void> => {
    void useSharedNotes.getState().refresh()
    const projectIds = get().projects.map((project) => project.id)
    if (projectIds.length === 0) return
    const answers = await Promise.all(
      projectIds.map((projectId) =>
        Promise.all([
          runtimeClient.call('teamwork.status', { projectId }).catch(() => null),
          runtimeClient.call('teamwork.presence', { projectId }).catch(() => null),
          runtimeClient.call('teamwork.watchers', { projectId }).catch(() => null),
          runtimeClient.call('teamwork.requests', { projectId }).catch(() => null)
        ])
      )
    )
    set((state) => {
      const teamwork = { ...state.teamwork }
      const teammates = { ...state.teammates }
      const watchers = { ...state.watchers }
      const consent = { ...state.consent }
      for (const [status, presence, reading, waiting] of answers) {
        if (status) teamwork[status.projectId] = status
        if (presence) teammates[presence.projectId] = presence
        if (reading) watchers[reading.projectId] = reading
        if (waiting) consent[waiting.projectId] = waiting
      }
      return { teamwork, teammates, watchers, consent }
    })
  }

  const refresher = createWorkspaceRefresher({
    run: applyRefresh,
    onError: failed('Could not refresh the workspace')
  })

  /**
   * Reads the rows on screen when what is on screen changes: a row hidden while its numbers moved must
   * be read as it appears. Every way a row can appear comes through here or through `openWorktree`.
   */
  const readOnScreen = (): void => {
    const shown = onScreenWorktreeIds()
    // Ready ones only, as `refreshWorktrees` picks them: no git in a checkout still being built.
    const worth = get()
      .worktrees.filter((worktree) => hasCheckout(worktree) && shown.has(worktree.id))
      .map((worktree) => worktree.id)
    if (worth.length > 0) refresher.request(refreshTargets({ statuses: worth }))
  }

  /**
   * What this machine's owner always passes the agent behind `command`: the command is all the two launch
   * paths share. Undefined when the command is not a probed agent, which leaves the line exactly as it was.
   */
  const extraArgsFor = (command: string): string | undefined => {
    const kind = get().agents.find((agent) => agent.command === command)?.kind
    return kind === undefined ? undefined : get().agentArgs[kind]
  }

  /** Shows a layout without writing it back: this window's copy is only as new as the last event that reached it. */
  const showLayout = (layout: Layout): void => {
    layoutEdits.bump(layout.worktreeId)
    set((state) => ({ layouts: { ...state.layouts, [layout.worktreeId]: layout } }))
  }

  const persistLayout = (layout: Layout): void => {
    showLayout(layout)
    void runtimeClient
      .call('layout.set', {
        worktreeId: layout.worktreeId,
        root: layout.root,
        focusedTerminalId: layout.focusedTerminalId
      })
      .catch(failed('Could not save the layout'))
  }

  /** The create half of a retry, shared by the plain path and the confirmed one. */
  const recreateWorktree = async (worktree: Worktree): Promise<void> => {
    const created = await runtimeClient.call('worktree.create', {
      projectId: worktree.projectId,
      name: worktree.name,
      startedFrom: worktree.startedFrom,
      // An opened branch is opened again, never cut anew under the same name.
      ...(worktree.checkout === undefined ? {} : { checkout: worktree.checkout }),
      ...(worktree.checkout === undefined || worktree.baseRef === undefined ? {} : { base: worktree.baseRef })
    })
    set((state) => ({ worktrees: [...state.worktrees.filter((entry) => entry.id !== worktree.id), created] }))
  }

  /** Puts a new file leaf in the column as a tab, or beside the focused pane; see `openFilePane`. */
  const placeFileLeaf = (layout: Layout, added: FileLeaf, mode?: FileOpenMode): void => {
    const column = fileColumnIn(layout.root)
    const asPreview = mode === 'preview' || mode === 'diff-preview'
    let root: PaneNode | null
    if (mode !== 'split' && column !== null && layout.root !== null) {
      // A tab takes no room from anyone, so it needs no room check.
      const preview = column.preview
      const replace = asPreview && preview !== undefined && !get().unsavedFiles[preview] ? preview : undefined
      root = addTab(layout.root, added, { preview: asPreview, replace })
      if (replace !== undefined) {
        forgetEdits([replace])
        get().setPaneDiff(replace, false)
      }
    } else {
      const focused = layout.focusedTerminalId
      const inTree = focused !== null && collectTerminalIds(layout.root).includes(focused) ? focused : null
      // A split is a file of its own beside the focused pane; the column is made once, where there is most room.
      const placed = mode === 'split' ? added : fileColumn(added, asPreview)
      const beside =
        inTree !== null ? splitPaneWith(layout.root, inTree, 'row', placed) : appendPane(layout.root, placed)
      const grid = paneGrid(get().terminalFontSize, get().terminalOptions.fontFamily)
      if (isFileColumn(placed) && grid !== undefined) {
        const isAgent = (id: string): boolean => get().terminals[id]?.agent !== undefined
        const place = (area: Box, minPane: Box): PaneNode | null =>
          placeFileColumn(layout.root, placed, area, minPane, isAgent)
        root = place(grid.area, grid.minPane)
        if (root === null) refuseForRoom(({ minPane }, area) => place(area, minPane) !== null)
      } else {
        root = withRoom(layout.root, beside, (room) => placePaneWithin(layout.root, placed, room.area, room.minPane))
      }
    }
    if (root === null) return
    set({ namingMarkdown: null })
    if (mode === 'diff' || mode === 'diff-preview') get().setPaneDiff(added.terminalId, true)
    persistLayout({ worktreeId: layout.worktreeId, root, focusedTerminalId: added.terminalId })
  }

  /** Drops a worktree from this window once the runtime has really removed it. */
  const keepClosedFile = (worktreeId: string, file: ClosedFile): void => {
    const files = withClosedFile(get().closedFiles, worktreeId, file)
    set({ closedFiles: files })
    writeClosedFiles(storage, files)
  }

  const forgetWorktree = (worktreeId: string): void => {
    forgetEdits(editedIn(worktreeId))
    useWorkspaceStore.getState().closeWorktreeTab(worktreeId)
    set((state) => ({ worktrees: state.worktrees.filter((entry) => entry.id !== worktreeId) }))
  }

  const forgetProject = (projectId: string): void => {
    for (const worktree of get().worktrees) if (worktree.projectId === projectId) forgetWorktree(worktree.id)
    set((state) => ({ projects: state.projects.filter((entry) => entry.id !== projectId) }))
  }

  const worktreeIdsOf = (target: RemoveTarget): string[] =>
    'worktreeId' in target
      ? [target.worktreeId]
      : get()
          .worktrees.filter((entry) => entry.projectId === target.projectId)
          .map((entry) => entry.id)

  /** Opens `ask`, after the Save question when any of these worktrees has edited files. */
  const askAfterUnsaved = (worktreeIds: readonly string[], ask: ConfirmAfterUnsaved): void => {
    const edited = worktreeIds.flatMap(editedIn)
    set({ dialog: edited.length > 0 ? { kind: 'confirm-unsaved', paneIds: edited, after: { ask } } : ask })
  }

  const activeLayout = (): Layout | null => {
    const { activeWorktreeId, layouts } = get()
    return activeWorktreeId ? (layouts[activeWorktreeId] ?? null) : null
  }

  /** The question closing this pane needs first, or null: see `closePaneWarning`. */
  const closeQuestion = (paneId: string): 'confirm-close-pane' | 'confirm-close-file' | null => {
    if (isFilePaneId(paneId)) return get().editedFiles[paneId] ? 'confirm-close-file' : null
    return closePaneWarning(get().terminals[paneId]) === null ? null : 'confirm-close-pane'
  }

  /** True when `paneId` is in the open worktree's file column and that column is folded to its tab. */
  const inFoldedColumn = (paneId: string): boolean => {
    const { activeWorktreeId, foldedColumns } = get()
    const root = activeLayout()?.root ?? null
    if (!activeWorktreeId || !foldedColumns[activeWorktreeId] || !hasTerminal(fileColumnIn(root), paneId)) return false
    const grid = paneGrid(get().terminalFontSize, get().terminalOptions.fontFamily)
    return grid !== undefined && foldsColumn(root, grid.area, grid.minPane)
  }
  // The pane a folded tab was zoomed from, for the keyboard to go back to when the zoom ends.
  let zoomedFrom: string | null = null
  /** Ends the zoom; focus leaves a tab that is folded again. */
  const restoreZoom = (): void => {
    set({ expandedTerminalId: null })
    const layout = activeLayout()
    const focused = layout?.focusedTerminalId
    if (!layout || !focused || !inFoldedColumn(focused)) return
    const drawn = collectTerminalIds(withoutColumn(layout.root))
    const back = zoomedFrom !== null && drawn.includes(zoomedFrom) ? zoomedFrom : drawn[0]
    if (back !== undefined) get().focusPane(back)
  }

  /**
   * Moves the focus `step` places around the pane cycle, wrapping. One walk for both directions, so
   * the two chords undo each other; teammates' panes are in the cycle as they are in the tree.
   */
  const stepFocus = (step: 1 | -1): void => {
    const layout = activeLayout()
    const ids = paneCycle(layout?.root ?? null, get().watches)
    const next = tabAfter(ids, get().focusedWatchId ?? layout?.focusedTerminalId ?? null, step)
    if (next !== null) get().focusPane(next)
  }

  return {
    connection: runtimeClient.connection,
    runtimeVersion: null,

    projects: [],
    worktrees: [],
    statuses: {},
    unreadableSince: {},
    terminals: {},
    layouts: {},
    expandedTerminalId: null,
    foldedColumns: {},
    unsavedFiles: Object.fromEntries(lastDrafts.map(([paneId]) => [paneId, true as const])),
    editedFiles: Object.fromEntries(
      lastDrafts.map(([paneId, draft]) => [paneId, { worktreeId: draft.worktreeId, path: draft.path }])
    ),
    diffPanes: {},
    editingMarkdown: false,
    namingMarkdown: null,
    recentFiles: {},
    editingPaneName: null,
    editingWorktreeName: null,
    worktreeFilesEpoch: 0,

    mergePreviews: {},
    landings: {},
    openingPullRequest: false,
    members: {},
    membersPending: false,
    membersError: null,
    teamworkReadErrors: {},
    relays: {},
    relayPending: false,
    relayError: null,
    originPending: false,
    originError: null,
    relayPanes: {},
    publishPlans: {},
    publishPending: false,
    publishError: null,
    publishResults: {},
    publishProgress: {},
    teamwork: {},
    teammates: {},
    watchers: {},
    consent: {},
    watches: [],
    watchSizes: [],
    watchTails: {},
    focusedWatchId: null,
    rightPanelOpen: lastPanel.open,
    rightPanelTab: lastPanel.tab,
    rightPanelWidth: readStoredRightPanelWidth(storage),
    changes: {},
    goToLine: null,
    logs: {},
    selectedChangePath: null,
    stagedPaths: [],
    committing: false,
    pushing: false,
    pushes: {},
    updating: null,
    updateErrors: {},
    cli: null,
    cliPending: false,
    cliInstall: null,
    cliError: null,
    update: null,
    trustNewWorktrees: true,
    agents: [],
    agentsProbed: false,
    hunkPending: false,
    removedWorktrees: [],
    closedPanes: {},
    closedFiles: readClosedFiles(storage),

    // Folded projects are remembered with the sidebar's width. Tabs are restored in `bootstrap`,
    // once the runtime has said which worktrees still exist.
    collapsedProjects: lastSession.collapsedProjects,
    openWorktreeIds: [],
    activeWorktreeId: null,
    restoring: true,
    dashboardOpen: false,
    teamworkProjectId: null,
    joinedFrom: {},
    joining: null,
    // Neither is restored: both are places you go to answer a question.
    settingsOpen: false,
    settingsSection: null,
    helpOpen: false,
    appearanceOpen: false,

    sidebarWidth: readStoredSidebarWidth(storage) || SIDEBAR_DEFAULT_PX,
    sidebarVisible: lastSession.sidebarVisible,
    roomHid: { panel: false, sidebar: false },
    compareHid: null,
    paneSearch: null,
    dialog: null,
    notices: [],
    terminalFontSize: readStoredTerminalFontSize(storage),
    terminalOptions: readStoredTerminalOptions(storage),
    startPointDefaults: readStoredStartPoints(storage),
    agentNotices: readStoredAgentNotices(storage),
    keepAwake: readStoredKeepAwake(storage),
    editorCommands: readStoredEditorCommands(storage),
    editors: null,
    paneSeenAt: readPaneSeen(storage),
    diffLayout: readStoredDiffLayout(storage),
    defaultAgent: readStoredDefaultAgent(storage),
    agentArgs: readStoredAgentArgs(storage),

    // The palette `tokens.css` painted the first frame in, so the window does not change shade on the way to its theme.
    appearance: DEFAULT_APPEARANCE,
    systemTone: readSystemTone(),

    /** The first read of everything, through the same queue as the stream, so the snapshot cannot be overtaken by an event in flight. */
    async bootstrap() {
      runtimeClient.onConnectionChange((connection) => set({ connection }))
      set({ connection: runtimeClient.connection })

      try {
        const status = await runtimeClient.call('status.get', {})
        set({ runtimeVersion: status.version })
        // Asked once, never fatal: the answer only decides which buttons to offer.
        void runtimeClient
          .call('agent.list', {})
          .then((agents) => set({ agents, agentsProbed: true }))
          .catch(() => set({ agents: [], agentsProbed: true }))
        // Same terms: one cheap read, never fatal.
        void runtimeClient
          .call('cli.status', {})
          .then((cli) => set({ cli }))
          .catch(() => {})
        // Not fatal either: a window that cannot read its appearance opens in the default.
        void runtimeClient
          .call('appearance.get', {})
          .then((appearance) => set({ appearance }))
          .catch(() => {})
        // A read out of the runtime's memory; whatever its own check finds arrives on the stream.
        void get().loadUpdate()

        refresher.request(refreshTargets({ projects: true, worktrees: true, terminals: true }))
        await refresher.flush()
        // After the projects exist: teamwork is read per project.
        refresher.request(refreshTargets({ teammates: true }))
        await refresher.flush()

        if (!get().activeWorktreeId) {
          // The last window's tabs, in order, the front one left in front: main restores the panes and
          // resumes the agents in them. A worktree removed since has no tab to reopen; one whose
          // directory has gone is not reopened either, since no shell can start in it.
          const live = new Set(
            get()
              .worktrees.filter(hasCheckout)
              .map((worktree) => worktree.id)
          )
          const reopening = lastSession.openWorktreeIds.filter((worktreeId) => live.has(worktreeId))
          const wasActive = lastSession.activeWorktreeId
          // Nothing remembered: the first ready worktree beats an empty window.
          const front =
            wasActive !== null && live.has(wasActive)
              ? wasActive
              : (reopening[reopening.length - 1] ?? get().worktrees.find(hasCheckout)?.id)
          if (front !== undefined) {
            const tabs = reopening.includes(front) ? reopening : [...reopening, front]
            // Every tab laid out before one is in front: opened one by one, the window flicks through each.
            set({ openWorktreeIds: tabs })
            refresher.request(refreshTargets({ layouts: tabs, statuses: tabs }))
            await refresher.flush()
            set({ activeWorktreeId: front, restoring: false })
            if (changesOnScreen(get())) readChangesNow(front)
          }
        }
      } catch (error) {
        failed('Could not reach the runtime')(error)
      } finally {
        if (get().restoring) set({ restoring: false })
      }
    },

    /** The window's one subscription: everything the runtime changes arrives here as a collection to re-read, so nothing polls. */
    startWatching() {
      const watch = runtimeClient.watchWorkspace((event) => refresher.push(event))
      return () => {
        watch.close()
        refresher.cancelPending()
      }
    },

    async addProject(path, name, init) {
      try {
        const project = await runtimeClient.call('project.add', {
          path,
          ...(name ? { name } : {}),
          ...(init ? { init } : {})
        })
        set((state) => ({ projects: [...state.projects, project], dialog: null }))
        if (!get().sidebarVisible) notify(`Added ${project.name}`, 'info')
      } catch (error) {
        const refusal = (error as { data?: { refusal?: ProjectAddRefusal } } | null)?.data?.refusal
        if (refusal) return refusal
        failed('Could not add the project')(error)
      }
      return null
    },

    async chooseProjectFolder() {
      if (picking) return
      picking = true
      let folder: string | null = null
      try {
        folder = await window.teamree.selectProjectFolder()
      } catch {
        notify('Could not open the folder picker')
      } finally {
        picking = false
      }
      if (!folder) return
      const refusal = await get().addProject(folder)
      if (refusal) set({ dialog: { kind: 'project-refused', folder, refusal } })
    },

    async cloneProject(url, path) {
      try {
        const project = await runtimeClient.call('project.clone', { url, ...(path.trim() ? { path } : {}) })
        set((state) => ({ projects: [...state.projects, project], dialog: null }))
        if (!get().sidebarVisible) notify(`Cloned ${project.name}`, 'info')
        return null
      } catch (error) {
        const refusal = (error as { data?: { refusal?: ProjectAddRefusal } } | null)?.data?.refusal
        if (refusal === 'no-commits') return 'No commits yet'
        return error instanceof Error ? error.message : String(error)
      }
    },

    /**
     * One action, three steps, none waited on: the composer closes at once and the rows appear creating.
     * Creates are requested in order, because names were handed out in order and the runtime allocates
     * branches on arrival; what follows each create is not. Only the first is opened.
     */
    startTask({ projectId, startedFrom, checkout, base, creates }) {
      set({ dialog: null })

      void (async () => {
        const started: Array<{ worktreeId: string; agentCommand?: string; label: string; task: string }> = []
        for (const create of creates) {
          const name = create.name.trim()
          const task = create.task.trim()
          const created = await runtimeClient.call('worktree.create', {
            projectId,
            name,
            ...(startedFrom ? { startedFrom } : {}),
            ...(create.branch && !checkout ? { branch: create.branch } : {}),
            ...(task ? { task } : {}),
            ...(checkout ? { checkout } : {}),
            ...(checkout && base ? { base } : {})
          })
          set((state) => ({
            worktrees: [...state.worktrees.filter((entry) => entry.id !== created.id), created],
            collapsedProjects: { ...state.collapsedProjects, [projectId]: false }
          }))
          // The first goes in front now, and this is the last time anything here changes tabs: opening
          // it when the checkout was ready meant changing tabs under whoever had gone on typing elsewhere.
          if (started.length === 0) await get().openWorktree(created.id)
          started.push({
            worktreeId: created.id,
            label: name,
            task,
            ...(create.agentCommand === undefined ? {} : { agentCommand: create.agentCommand })
          })
        }
        // The project may have been collapsed until now.
        readOnScreen()

        await Promise.all(
          started.map(async ({ worktreeId, agentCommand, label, task }) => {
            // The agent needs a checkout; a failure here is already on the row.
            const worktree = await awaitWorktreeReady({
              worktreeId,
              read: (id) => runtimeClient.call('worktree.get', { worktreeId: id }),
              watch: (onChange) => runtimeClient.watchWorkspace(onChange)
            })
            if (agentCommand) {
              // Named after the task, since every other pane is called after its binary; the description is its first prompt.
              const agentArgs = extraArgsFor(agentCommand)
              await runtimeClient.call('terminal.create', {
                worktreeId: worktree.id,
                command: agentCommand,
                label,
                ...paneSizeFor(worktree.id),
                ...(agentArgs === undefined ? {} : { agentArgs }),
                ...(task ? { prompt: task } : {})
              })
            }
            return worktree
          })
        )
      })().catch(failed('Could not start the task'))
    },

    /**
     * Builds the checkout again after removing the failed one. Not forced: a failed row can have a whole
     * checkout behind it, so the runtime may refuse, and the refusal becomes the question the cross asks.
     */
    retryWorktree(worktreeId) {
      const worktree = get().worktrees.find((entry) => entry.id === worktreeId)
      if (!worktree) return
      void (async () => {
        try {
          await runtimeClient.call('worktree.remove', { worktreeId, deleteBranch: false })
        } catch (error) {
          if (!isRefusal(error)) throw error
          set({ dialog: { kind: 'confirm-remove', worktreeId, intent: 'retry', refused: true } })
          return
        }
        await recreateWorktree(worktree)
      })().catch(failed('Retry failed'))
    },

    async removeWorktree(worktreeId) {
      const edited = editedIn(worktreeId)
      if (edited.length > 0) {
        set({ dialog: { kind: 'confirm-unsaved', paneIds: edited, after: { remove: worktreeId } } })
        return
      }
      set({ dialog: { kind: 'confirm-remove', worktreeId, intent: 'remove' } })
    },

    async removeFromTeamree(target) {
      askAfterUnsaved(worktreeIdsOf(target), { kind: 'confirm-forget', target })
    },

    async confirmForget(target) {
      set({ dialog: null })
      try {
        if ('worktreeId' in target) await runtimeClient.call('worktree.forget', { worktreeId: target.worktreeId })
        else await runtimeClient.call('project.remove', { projectId: target.projectId })
      } catch (error) {
        failed('Could not remove from teamree')(error)
        return
      }
      if ('projectId' in target) forgetProject(target.projectId)
      else forgetWorktree(target.worktreeId)
    },

    async trashProject(projectId) {
      askAfterUnsaved(worktreeIdsOf({ projectId }), { kind: 'confirm-trash-project', projectId })
    },

    async confirmTrashProject(projectId) {
      const project = get().projects.find((entry) => entry.id === projectId)
      set({ dialog: null })
      try {
        await runtimeClient.call('project.trash', { projectId })
      } catch (error) {
        failed('Could not move to Trash')(error)
        return
      }
      forgetProject(projectId)
      if (project) notify(`Moved "${shortened(project.name)}" to Trash`, 'info')
    },

    async renameWorktree(worktreeId, name) {
      const named = name.trim()
      const previous = get().worktrees.find((entry) => entry.id === worktreeId)
      if (!previous || named.length === 0 || named === previous.name) return
      const withName = (to: string) => (state: WorkspaceState) => ({
        worktrees: state.worktrees.map((entry) => (entry.id === worktreeId ? { ...entry, name: to } : entry))
      })
      set(withName(named))
      try {
        const renamed = await runtimeClient.call('worktree.rename', { worktreeId, name: named })
        set((state) => ({ worktrees: state.worktrees.map((entry) => (entry.id === renamed.id ? renamed : entry)) }))
      } catch (error) {
        set(withName(previous.name))
        failed('Could not rename the worktree')(error)
      }
    },

    async confirmRemoveWorktree(worktreeId, force) {
      const dialog = get().dialog
      const retrying =
        dialog?.kind === 'confirm-remove' && dialog.worktreeId === worktreeId && dialog.intent === 'retry'
      // Read before the removal: forgetting the row takes the only copy of what the replacement is built from.
      const worktree = get().worktrees.find((entry) => entry.id === worktreeId)
      // The dialog listed them; the runtime refuses a parent without this.
      const children = descendantsOf(get().worktrees, worktreeId)
      set({ dialog: null })
      try {
        const removed = await runtimeClient.call('worktree.remove', {
          worktreeId,
          ...(force ? { force: true } : {}),
          ...(children.length > 0 ? { children: true } : {})
        })
        for (const child of children) forgetWorktree(child.id)
        forgetWorktree(worktreeId)
        if (retrying && worktree) await recreateWorktree(worktree)
        else if (worktree && removed.trashId !== undefined) {
          const undo: UndoTarget = { kind: 'remove', projectId: worktree.projectId, removedId: removed.trashId }
          notify(`Deleted "${shortened(worktreeLabel(worktreeDisplay(worktree)))}"`, 'info', {
            label: 'Undo',
            undo
          })
        }
      } catch (error) {
        // Something appeared since the dialog read the checkout: ask again, and it reads again.
        if (!force && isRefusal(error)) {
          set({ dialog: { kind: 'confirm-remove', worktreeId, intent: retrying ? 'retry' : 'remove', refused: true } })
          return
        }
        failed(retrying ? 'Retry failed' : 'Could not remove the worktree')(error)
      }
    },

    async loadRemovedWorktrees() {
      // Silent: the lists that read it are menus, and an empty one says as much.
      const removed = await runtimeClient.call('worktree.removed', {}).catch(() => null)
      if (removed !== null) set({ removedWorktrees: removed })
    },

    async restoreWorktree(projectId, removedId) {
      try {
        const worktree = await runtimeClient.call('worktree.restore', { projectId, removedId })
        set((state) => ({
          worktrees: [...state.worktrees.filter((entry) => entry.id !== worktree.id), worktree],
          removedWorktrees: state.removedWorktrees.filter((entry) => entry.id !== removedId)
        }))
        await get().openWorktree(worktree.id)
      } catch (error) {
        failed('Could not restore the worktree')(error)
      }
    },

    async undo(target) {
      if (target.kind === 'remove') {
        await get().restoreWorktree(target.projectId, target.removedId)
        return
      }
      try {
        await runtimeClient.call('worktree.undoDiscard', { worktreeId: target.worktreeId, trashId: target.trashId })
      } catch (error) {
        failed('Could not undo the discard')(error)
      }
    },

    async openWorktree(worktreeId) {
      const switching = get().activeWorktreeId !== worktreeId
      set((state) => ({
        activeWorktreeId: worktreeId,
        // Picking a worktree says the dashboard, teamwork, settings or help is done with.
        dashboardOpen: false,
        teamworkProjectId: null,
        settingsOpen: false,
        helpOpen: false,
        openWorktreeIds: state.openWorktreeIds.includes(worktreeId)
          ? state.openWorktreeIds
          : [...state.openWorktreeIds, worktreeId],
        // A patch, its ticks and a maximised pane all belong to the worktree they were made in; none
        // travels across a tab switch.
        ...(switching
          ? {
              selectedChangePath: null,
              stagedPaths: [],
              expandedTerminalId: null
            }
          : {})
      }))
      if (changesOnScreen(get())) readChangesNow(worktreeId)
      void get().loadClosedPanes(worktreeId)
      // Through the queue, so opening a tab cannot interleave with an in-flight refetch.
      refresher.request(refreshTargets({ terminals: true, layouts: [worktreeId], statuses: [worktreeId] }))
      await refresher.flush()
    },

    closeWorktreeTab(worktreeId) {
      set((state) => {
        const openWorktreeIds = state.openWorktreeIds.filter((id) => id !== worktreeId)
        const activeWorktreeId =
          state.activeWorktreeId === worktreeId
            ? (openWorktreeIds[openWorktreeIds.length - 1] ?? null)
            : state.activeWorktreeId
        return { openWorktreeIds, activeWorktreeId }
      })
    },

    async revealPane(worktreeId, terminalId) {
      // Focus is a property of a layout, which arrives with `openWorktree`.
      await get().openWorktree(worktreeId)
      get().focusPane(terminalId)
    },

    async answerPane(terminalId, choice) {
      const terminal = get().terminals[terminalId]
      if (terminal === undefined) return
      const goThere = async (): Promise<void> => {
        await get().revealPane(terminal.worktreeId, terminalId)
        requestRegionFocus('panes')
      }
      const prompt = terminal.screenMenu?.prompt
      if (choice.keys === null || prompt === undefined) return goThere()
      try {
        // The runtime reads the screen again and refuses unless it still shows this prompt.
        await runtimeClient.call('terminal.write', { terminalId, data: choice.keys.join(''), answering: prompt })
      } catch {
        notify('No longer asking that', 'info')
        await goThere()
      }
    },

    recordTerminal(terminal) {
      set((state) =>
        state.terminals[terminal.id] ? { terminals: { ...state.terminals, [terminal.id]: terminal } } : {}
      )
    },

    focusPane(paneId) {
      // A teammate's pane is focused here, not in a layout: layouts belong to the runtime. One id space, one chord, one border.
      if (isWatchedPaneId(paneId)) {
        if (get().watches.some((watch) => watch.id === paneId)) set({ focusedWatchId: paneId })
        return
      }
      // Focusing one of your own takes the focus off a teammate's: two panes wearing the border would be two answers.
      if (get().focusedWatchId !== null) set({ focusedWatchId: null })
      const layout = activeLayout()
      // Both ends of the move, before the early return: the pane being left is read up to now, and the
      // one taken is being looked at — even when it already had the focus.
      get().markPanesSeen([paneId, ...(layout?.focusedTerminalId ? [layout.focusedTerminalId] : [])])
      if (!layout) return
      // Going to a pane the zoom hides ends it; a folded tab is shown by zooming it.
      const expanded = get().expandedTerminalId
      if (expanded !== null && !hasTerminal(shownRoot(layout.root, expanded), paneId)) set({ expandedTerminalId: null })
      if (get().expandedTerminalId === null && inFoldedColumn(paneId)) {
        zoomedFrom = layout.focusedTerminalId
        set({ expandedTerminalId: paneId })
      }
      const root = layout.root && showTab(layout.root, paneId)
      if (layout.focusedTerminalId === paneId && root === layout.root) return
      persistLayout({ ...layout, root, focusedTerminalId: paneId })
    },

    markPanesSeen(terminalIds) {
      if (terminalIds.length === 0) return
      const now = Date.now()
      set((state) => {
        const paneSeenAt = markSeen(state.paneSeenAt, terminalIds, now)
        return paneSeenAt === state.paneSeenAt ? {} : { paneSeenAt }
      })
    },

    async splitFocusedPane(direction) {
      // Splitting somebody else's pane cannot be asked for: the tree is on their machine. Refused in
      // silence, because the button splits whatever pane has the focus.
      if (get().focusedWatchId !== null) return
      if (get().expandedTerminalId !== null) restoreZoom()
      const layout = activeLayout()
      const terminalId = layout?.focusedTerminalId
      if (!layout || !terminalId) return
      const grid = paneGrid(get().terminalFontSize, get().terminalOptions.fontFamily)
      const plan = (area: Box, min: Box) => planSplit(layout.root, terminalId, direction, SPLIT_PROBE_ID, area, min)
      // Where the person put it, beside a narrower or folded file column, or nowhere.
      const planned = grid
        ? plan(grid.area, grid.minPane)
        : { before: layout.root, after: splitPane(layout.root, terminalId, direction, SPLIT_PROBE_ID), folded: false }
      if (planned === null) {
        refuseForRoom(({ minPane }, area) => plan(area, minPane) !== null)
        return
      }
      if (planned.before !== layout.root) {
        // The runtime splits the tree it holds, so the narrowed column reaches it first.
        showLayout({ ...layout, root: planned.before })
        try {
          await runtimeClient.call('layout.set', {
            worktreeId: layout.worktreeId,
            root: planned.before,
            focusedTerminalId: terminalId
          })
        } catch (error) {
          failed('Could not save the layout')(error)
          return
        }
      }
      // Born at the size it is drawn at: a shell that first draws wider than its pane leaves a `%` line.
      const drawn = planned.folded ? withoutColumn(planned.after) : planned.after
      const size = grid && paneCellsIn(drawn, SPLIT_PROBE_ID, grid.area, grid.cell)
      const measured = grid && size ? { ...size, area: grid.area, cell: grid.cell } : {}
      try {
        const { terminal, layout: next } = await runtimeClient.call('terminal.split', {
          terminalId,
          direction,
          ...measured
        })
        set((state) => ({
          terminals: { ...state.terminals, [terminal.id]: terminal },
          layouts: { ...state.layouts, [next.worktreeId]: next },
          ...(planned.folded ? { foldedColumns: { ...state.foldedColumns, [next.worktreeId]: true as const } } : {})
        }))
      } catch (error) {
        failed('Could not split the pane')(error)
      }
    },

    /**
     * Closes a pane once anybody who needs asking has been asked. `closePaneWarning` decides: a shell at a
     * prompt closes without a word, because a question on every close is one people learn to press through.
     * The question lives here and not on the buttons, so a fourth button is not written without it.
     */
    async closeTerminal(terminalId) {
      await get().closePanes([terminalId])
    },

    async closePanes(terminalIds) {
      for (const [index, terminalId] of terminalIds.entries()) {
        const kind = closeQuestion(terminalId)
        if (kind !== null) {
          const rest = terminalIds.slice(index + 1)
          set({ dialog: { kind, terminalId, ...(rest.length > 0 ? { rest } : {}) } })
          return
        }
        await get().forceCloseTerminal(terminalId)
      }
    },

    async closeOtherPanes(terminalId) {
      const others = collectTerminalIds(activeLayout()?.root ?? null).filter((id) => id !== terminalId)
      get().focusPane(terminalId)
      await get().closePanes(others)
    },

    /**
     * Closes a pane only once the process behind it is really gone: the pane is the only way back to a
     * PTY, and taking it off the screen first would strand an agent mid-task.
     */
    async forceCloseTerminal(terminalId) {
      const { activeWorktreeId } = get()
      if (!activeWorktreeId || !get().layouts[activeWorktreeId]) return

      if (isFilePaneId(terminalId)) {
        // No session to end: closing is taking the leaf out of the tree.
        const layout = get().layouts[activeWorktreeId]
        if (!layout) return
        const root = closePane(layout.root, terminalId)
        // Within the column, focus goes to the tab it shows next.
        const column = fileLeavesIn(fileColumnIn(layout.root)).some((leaf) => leaf.terminalId === terminalId)
          ? fileColumnIn(root)
          : null
        const nextFocus = (column && shownTabId(column)) ?? neighbourTerminalId(layout.root, terminalId)
        persistLayout({
          worktreeId: activeWorktreeId,
          root,
          focusedTerminalId: layout.focusedTerminalId === terminalId ? nextFocus : layout.focusedTerminalId
        })
        forgetEdits([terminalId])
        get().setPaneDiff(terminalId, false)
        if (get().expandedTerminalId === terminalId) set({ expandedTerminalId: null })
        const leaf = fileLeavesIn(layout.root).find((entry) => entry.terminalId === terminalId)
        if (leaf !== undefined) keepClosedFile(activeWorktreeId, { leaf, closedAt: Date.now() })
        return
      }

      try {
        await runtimeClient.call('terminal.close', { terminalId })
      } catch (error) {
        failed('Could not close the terminal')(error)
        return
      }

      // Re-read: the close was awaited, and the layout can have moved under it.
      const layout = get().layouts[activeWorktreeId]
      if (!layout) return
      // Shown, not saved: the runtime already took the leaf out and wrote the layout. Writing this window's
      // version back would replace the tree with one missing any pane opened elsewhere in the meantime,
      // leaving that pane running with no leaf and no way back to it.
      const nextFocus = neighbourTerminalId(layout.root, terminalId)
      const root = closePane(layout.root, terminalId)
      showLayout({
        worktreeId: activeWorktreeId,
        root,
        focusedTerminalId: layout.focusedTerminalId === terminalId ? nextFocus : layout.focusedTerminalId
      })
      set((state) => {
        const terminals = { ...state.terminals }
        delete terminals[terminalId]
        // Closing the pane that filled the workspace is asking for the tree back.
        return { terminals, ...(state.expandedTerminalId === terminalId ? { expandedTerminalId: null } : {}) }
      })
      await get().loadClosedPanes(activeWorktreeId)
    },

    async loadClosedPanes(worktreeId) {
      const closed = await runtimeClient.call('terminal.closed', { worktreeId }).catch(() => null)
      if (closed !== null) set((state) => ({ closedPanes: { ...state.closedPanes, [worktreeId]: closed } }))
    },

    async reopenClosedPane() {
      const worktreeId = get().activeWorktreeId
      if (worktreeId === null) return
      const next = nextToReopen(get().closedPanes[worktreeId] ?? [], get().closedFiles[worktreeId] ?? [])
      if (next === null) return
      if (next.kind === 'terminal') {
        await get().reopenTerminal(worktreeId, next.terminalId)
        return
      }
      const files = withoutClosedFile(get().closedFiles, worktreeId, next.file)
      set({ closedFiles: files })
      writeClosedFiles(storage, files)
      const { leaf } = next.file
      if (isWorktreeFileLeaf(leaf)) {
        get().openFilePane(worktreeId, leaf.path)
        return
      }
      const layout = get().layouts[worktreeId] ?? { worktreeId, root: null, focusedTerminalId: null }
      placeFileLeaf(layout, { ...leaf, terminalId: newFilePaneId() })
    },

    async reopenTerminal(worktreeId, terminalId) {
      if (get().expandedTerminalId !== null) restoreZoom()
      const room = roomOrRefuse(worktreeId)
      if (!room) return
      try {
        const terminal = await runtimeClient.call('terminal.reopen', {
          worktreeId,
          ...(terminalId === undefined ? {} : { terminalId }),
          ...(room.area === undefined ? {} : { area: room.area }),
          ...(room.cell === undefined ? {} : { cell: room.cell }),
          ...(room.minPane === undefined ? {} : { minPane: room.minPane })
        })
        set((state) => ({ terminals: { ...state.terminals, [terminal.id]: terminal } }))
        panesAskedFor.add(terminal.id)
        refresher.request(refreshTargets({ layouts: [worktreeId] }))
        await refresher.flush()
        requestRegionFocus('panes')
      } catch (error) {
        failed('Could not reopen the pane')(error)
      }
      await get().loadClosedPanes(worktreeId)
    },

    /** Runs an exited pane again, in place. Nothing is asked first: the pane is dead, and its output stays above the new run. */
    async relaunchTerminal(terminalId) {
      try {
        const terminal = await runtimeClient.call('terminal.relaunch', { terminalId })
        set((state) => ({ terminals: { ...state.terminals, [terminal.id]: terminal } }))
        // The press was on a button; the next keystroke is for what was run again.
        get().focusPane(terminal.id)
        requestRegionFocus('panes')
      } catch (error) {
        failed('Could not run this pane again')(error)
      }
    },

    /**
     * Names a pane. Optimistic: the tab must say the new name on Enter, not a round trip later; the
     * runtime's answer replaces the guess, and a refusal puts the old name back.
     */
    async renamePane(terminalId, label) {
      const named = label.trim()
      const previous = get().terminals[terminalId]
      if (!previous) return
      const shown: Terminal = { ...previous }
      if (named.length === 0) delete shown.label
      else shown.label = named
      set((state) => ({ terminals: { ...state.terminals, [terminalId]: shown } }))
      try {
        const terminal = await runtimeClient.call('terminal.rename', {
          terminalId,
          label: named.length === 0 ? null : named
        })
        set((state) => ({ terminals: { ...state.terminals, [terminal.id]: terminal } }))
      } catch (error) {
        set((state) => ({ terminals: { ...state.terminals, [terminalId]: previous } }))
        failed('Could not rename the pane')(error)
      }
    },

    editPaneName(terminalId) {
      set({ editingPaneName: terminalId })
    },

    editWorktreeName(worktreeId) {
      const worktree = get().worktrees.find((entry) => entry.id === worktreeId)
      if (worktree !== undefined) {
        if (!get().sidebarVisible) get().toggleSidebar()
        if (get().collapsedProjects[worktree.projectId]) get().toggleProject(worktree.projectId)
      }
      set({ editingWorktreeName: worktree === undefined ? null : worktree.id })
    },

    openFilePane(worktreeId, path, mode) {
      set((state) => {
        const recent = [path, ...(state.recentFiles[worktreeId] ?? []).filter((entry) => entry !== path)]
        return { recentFiles: { ...state.recentFiles, [worktreeId]: recent.slice(0, RECENT_FILES_KEPT) } }
      })
      const layout = get().layouts[worktreeId] ?? { worktreeId, root: null, focusedTerminalId: null }
      const open = fileLeavesIn(layout.root).find((leaf) => leaf.path === path && isWorktreeFileLeaf(leaf))
      if (open) {
        if (mode === 'diff' || mode === 'diff-preview') get().setPaneDiff(open.terminalId, true)
        if (mode !== 'preview' && mode !== 'diff-preview') get().pinFilePane(open.terminalId)
        get().focusPane(open.terminalId)
        return
      }
      placeFileLeaf(layout, fileLeaf(newFilePaneId(), path), mode)
    },

    async openFileAt(worktreeId, path, line, column) {
      // Asked now: the Changes list is only read while it is on screen.
      const asked = await runtimeClient.call('worktree.changes', { worktreeId, path }).catch(() => null)
      const changed = (asked ?? get().changes[worktreeId])?.changes.some((change) => change.path === path) === true
      if (line !== undefined && !changed) {
        set({ goToLine: { worktreeId, path, line, column: column ?? 1, token: ++goToSeq } })
      }
      get().openFilePane(worktreeId, path, changed ? 'diff' : undefined)
    },

    wentToLine(token) {
      if (get().goToLine?.token === token) set({ goToLine: null })
    },

    openCommit(worktreeId, commit) {
      set({ selectedChangePath: null })
      const layout = get().layouts[worktreeId] ?? { worktreeId, root: null, focusedTerminalId: null }
      const open = fileLeavesIn(layout.root).find((leaf) => isCommitLeaf(leaf) && leaf.commit === commit.sha)
      if (open) {
        get().pinFilePane(open.terminalId)
        get().focusPane(open.terminalId)
        return
      }
      placeFileLeaf(layout, commitLeaf(newFilePaneId(), commit.sha, `${commit.shortSha} ${commit.subject}`))
    },

    async openCompare(worktreeId, otherId, title) {
      if (get().activeWorktreeId !== worktreeId) await get().openWorktree(worktreeId)
      const layout = get().layouts[worktreeId] ?? { worktreeId, root: null, focusedTerminalId: null }
      const open = fileLeavesIn(layout.root).find((leaf) => isCompareLeaf(leaf) && leaf.compare === otherId)
      if (open) {
        get().pinFilePane(open.terminalId)
        get().focusPane(open.terminalId)
        return
      }
      placeFileLeaf(layout, compareLeaf(newFilePaneId(), otherId, title))
    },

    async openSharedNote(projectId, shareId, title) {
      const { activeWorktreeId, worktrees } = get()
      const active = worktrees.find((worktree) => worktree.id === activeWorktreeId)
      const target =
        active?.projectId === projectId
          ? active
          : worktrees.find((worktree) => worktree.projectId === projectId && worktree.state === 'ready')
      if (!target) {
        notify('No worktree to open it in', 'info')
        return
      }
      if (activeWorktreeId !== target.id) await get().openWorktree(target.id)
      const layout = get().layouts[target.id] ?? { worktreeId: target.id, root: null, focusedTerminalId: null }
      const open = fileLeavesIn(layout.root).find((leaf) => isSharedNoteLeaf(leaf) && leaf.sharedNote === shareId)
      if (open) {
        get().pinFilePane(open.terminalId)
        get().focusPane(open.terminalId)
        return
      }
      placeFileLeaf(layout, sharedNoteLeaf(newFilePaneId(), shareId, title))
    },

    showNotice(text, tone = 'info') {
      notify(text, tone)
    },

    openReview(worktreeId) {
      const layout = get().layouts[worktreeId] ?? { worktreeId, root: null, focusedTerminalId: null }
      const open = fileLeavesIn(layout.root).find(isReviewLeaf)
      if (open) {
        get().pinFilePane(open.terminalId)
        get().focusPane(open.terminalId)
      } else placeFileLeaf(layout, reviewLeaf(newFilePaneId(), 'Review'))
      const shown = fileLeavesIn(get().layouts[worktreeId]?.root ?? null).find(isReviewLeaf)
      if (shown) set({ expandedTerminalId: shown.terminalId })
    },

    pinFilePane(paneId) {
      for (const layout of Object.values(get().layouts)) {
        if (layout.root === null || fileColumnIn(layout.root)?.preview !== paneId) continue
        persistLayout({ ...layout, root: pinTab(layout.root, paneId) })
      }
    },

    setPaneDiff(paneId, on) {
      set((state) => {
        if ((state.diffPanes[paneId] === true) === on) return {}
        const diffPanes = { ...state.diffPanes }
        if (on) diffPanes[paneId] = true
        else delete diffPanes[paneId]
        return on || state.paneSearch?.terminalId !== paneId ? { diffPanes } : { diffPanes, paneSearch: null }
      })
    },

    newMarkdown(worktreeId) {
      const layout = get().layouts[worktreeId]
      const open = fileLeavesIn(layout?.root ?? null).some((leaf) => leaf.path === DEFAULT_MARKDOWN_PATH)
      if (!open) {
        get().openFilePane(worktreeId, DEFAULT_MARKDOWN_PATH)
        return
      }
      // The default is taken: the strip asks what to call the next one.
      set({ namingMarkdown: worktreeId })
    },

    nameMarkdown(name) {
      const worktreeId = get().namingMarkdown
      set({ namingMarkdown: null })
      const typed = (name ?? '').trim().replace(/^\/+/, '')
      if (worktreeId === null || typed.length === 0) return
      get().openFilePane(worktreeId, isMarkdownPath(typed) ? typed : `${typed}.md`)
    },

    setFileUnsaved(paneId, dirty) {
      // An edited preview is kept.
      if (dirty) get().pinFilePane(paneId)
      set((state) => {
        if (Boolean(state.unsavedFiles[paneId]) === dirty) return {}
        const unsavedFiles = { ...state.unsavedFiles }
        if (dirty) unsavedFiles[paneId] = true
        else delete unsavedFiles[paneId]
        return { unsavedFiles }
      })
    },

    setFileEdited(paneId, file) {
      if (file !== null) get().pinFilePane(paneId)
      set((state) => {
        if (file === null ? state.editedFiles[paneId] === undefined : state.editedFiles[paneId] !== undefined) return {}
        const unsavedFiles = { ...state.unsavedFiles }
        const editedFiles = { ...state.editedFiles }
        if (file === null) {
          delete unsavedFiles[paneId]
          delete editedFiles[paneId]
        } else {
          unsavedFiles[paneId] = true
          editedFiles[paneId] = file
        }
        return { unsavedFiles, editedFiles }
      })
    },

    async saveFiles(paneIds) {
      for (const paneId of paneIds) {
        // A pane with no edit is what is on disk; writing it could still change its line endings.
        if (get().editedFiles[paneId] === undefined) continue
        // A mounted editor saves its own text and says so on its bar when it cannot.
        const save = saverFor(paneId)
        if (save !== undefined) {
          if (!(await save())) return false
          continue
        }
        const file = get().editedFiles[paneId]
        const draft = file === undefined ? undefined : draftFor(paneId, file.worktreeId, file.path)
        if (draft === undefined) continue
        try {
          await runtimeClient.call('file.write', {
            worktreeId: draft.worktreeId,
            path: draft.path,
            content: draft.text,
            encoding: draft.encoding ?? 'utf-8',
            expectedModifiedAt: draft.modifiedAt
          })
        } catch (error) {
          failed(`Could not save ${draft.path}`)(error)
          return false
        }
        forgetEdits([paneId])
      }
      return true
    },

    askBeforeLeaving(reason) {
      const paneIds = Object.keys(get().editedFiles)
      if (paneIds.length === 0) return Promise.resolve(true)
      settleLeaving(false)
      return new Promise((resolve) => {
        leaving = resolve
        set({ dialog: { kind: 'confirm-unsaved', paneIds, after: reason } })
      })
    },

    async answerUnsaved(answer) {
      const dialog = get().dialog
      if (dialog?.kind === 'confirm-close-file') {
        // Cancel stops a Close Others too.
        set({ dialog: null })
        if (answer === 'cancel') return
        if (answer === 'save' && !(await get().saveFiles([dialog.terminalId]))) return
        await get().forceCloseTerminal(dialog.terminalId)
        if (dialog.rest) await get().closePanes(dialog.rest)
        return
      }
      if (dialog?.kind !== 'confirm-unsaved') return
      set({ dialog: null })
      let proceed = answer !== 'cancel'
      if (answer === 'save') proceed = await get().saveFiles(dialog.paneIds)
      else if (answer === 'discard') forgetEdits(dialog.paneIds)
      if (typeof dialog.after === 'object') {
        if (!proceed) return
        if ('ask' in dialog.after) set({ dialog: dialog.after.ask })
        else await get().removeWorktree(dialog.after.remove)
      } else {
        settleLeaving(proceed)
      }
    },

    setEditingMarkdown(editing) {
      if (get().editingMarkdown !== editing) set({ editingMarkdown: editing })
    },

    async createTerminal(worktreeId) {
      if (get().expandedTerminalId !== null) restoreZoom()
      const room = roomOrRefuse(worktreeId)
      if (!room) return
      try {
        const terminal = await runtimeClient.call('terminal.create', { worktreeId, ...room })
        set((state) => ({ terminals: { ...state.terminals, [terminal.id]: terminal } }))
        // The one focus a layout may bring with it: it was asked for here.
        panesAskedFor.add(terminal.id)
        refresher.request(refreshTargets({ layouts: [worktreeId] }))
        await refresher.flush()
      } catch (error) {
        failed('Could not start a terminal')(error)
      }
    },

    focusNextPane() {
      stepFocus(1)
    },

    focusPreviousPane() {
      stepFocus(-1)
    },

    unfoldColumn(worktreeId) {
      if (!get().foldedColumns[worktreeId]) return
      set((state) => {
        const foldedColumns = { ...state.foldedColumns }
        delete foldedColumns[worktreeId]
        return { foldedColumns }
      })
      // Its old share would starve the panes that fit beside it now.
      const layout = get().layouts[worktreeId]
      const grid = paneGrid(get().terminalFontSize, get().terminalOptions.fontFamily)
      const root = layout && grid ? unfoldedRoot(layout.root, grid.area, grid.minPane) : undefined
      if (layout && root !== undefined && root !== layout.root) persistLayout({ ...layout, root })
    },

    showPane(paneId) {
      if (get().expandedTerminalId !== null) set({ expandedTerminalId: null })
      get().focusPane(paneId)
    },

    /**
     * Maximises the focused pane, or restores the tree: the key that put the window in this state takes
     * it out again, or the state is a trap. Nothing is saved, see `expandedTerminalId`. Not for a
     * teammate's pane, which is not in this tree.
     */
    toggleExpandedPane() {
      if (get().expandedTerminalId !== null) {
        restoreZoom()
        return
      }
      if (get().focusedWatchId !== null) return
      const focused = activeLayout()?.focusedTerminalId
      if (focused) set({ expandedTerminalId: focused })
    },

    expandPane(terminalId) {
      if (get().expandedTerminalId === terminalId) {
        restoreZoom()
        return
      }
      get().focusPane(terminalId)
      set({ expandedTerminalId: terminalId })
    },

    stepWorktree(step) {
      const { projects, worktrees, activeWorktreeId } = get()
      // The sidebar's order, not the store's: these chords move the highlight the sidebar draws.
      const next = worktreeAfter(worktreeOrder(projects, worktrees), activeWorktreeId, step)
      if (next && next.id !== activeWorktreeId) void get().openWorktree(next.id)
    },

    openPaneSearch() {
      // A watched pane's scrollback is a scaled picture with no search addon; the field opens only over your own.
      // A file pane has one over its diff only; a commit is nothing but a diff.
      if (get().focusedWatchId !== null) return
      const layout = activeLayout()
      const focused = layout?.focusedTerminalId
      if (!focused) return
      const commit = fileLeavesIn(layout?.root ?? null).some(
        (leaf) => leaf.terminalId === focused && isCommitLeaf(leaf)
      )
      if (isFilePaneId(focused) && get().diffPanes[focused] !== true && !commit) return
      set((state) => ({ paneSearch: { terminalId: focused, token: (state.paneSearch?.token ?? 0) + 1 } }))
    },

    closePaneSearch() {
      set({ paneSearch: null })
    },

    applySplitSizes(worktreeId, path, sizes) {
      const layout = get().layouts[worktreeId]
      if (!layout?.root) return
      persistLayout({ ...layout, root: setSizesAt(layout.root, path, sizes) as PaneNode })
    },

    arrangePanes(arrange, focus) {
      const layout = activeLayout()
      if (!layout?.root) return
      const arranged = arrange(layout.root)
      const root = arranged === layout.root ? null : withRoom(layout.root, arranged)
      if (root === null) return
      persistLayout({ ...layout, root, focusedTerminalId: hasTerminal(root, focus) ? focus : layout.focusedTerminalId })
    },

    toggleChanges() {
      const { rightPanelOpen, rightPanelTab } = get()
      if (rightPanelOpen && rightPanelTab === 'changes') get().toggleRightPanel()
      else get().showRightPanelTab('changes')
    },

    toggleRightPanel() {
      const opening = !get().rightPanelOpen
      set((state) => ({ rightPanelOpen: opening, roomHid: { ...state.roomHid, panel: false } }))
      writeStoredRightPanel(storage, { open: opening, tab: get().rightPanelTab })
      if (!opening) return
      // Read on the way open: until the panel is shown, nothing depends on it.
      const worktreeId = get().activeWorktreeId
      if (worktreeId && changesOnScreen(get())) readChangesNow(worktreeId)
    },

    showRightPanelTab(tab) {
      const wasShowing = changesOnScreen(get())
      set((state) => ({ rightPanelOpen: true, rightPanelTab: tab, roomHid: { ...state.roomHid, panel: false } }))
      writeStoredRightPanel(storage, { open: true, tab })
      const worktreeId = get().activeWorktreeId
      // A tab that draws changes reads them on arrival, unless the replaced tab was already drawing them.
      if (worktreeId && changesOnScreen(get()) && !wasShowing) readChangesNow(worktreeId)
    },

    hideRegion(region) {
      if (region === 'panel' && get().rightPanelOpen) get().toggleRightPanel()
      if (region === 'sidebar' && get().sidebarVisible) get().toggleSidebar()
      // Room asked for by hand is kept: a side folded for room stays folded when this frees some.
      set({ roomHid: { panel: false, sidebar: false } })
    },

    makeRoom(hide) {
      const before = get()
      const wantsPanel = before.rightPanelOpen || before.roomHid.panel
      const wantsSidebar = before.sidebarVisible || before.roomHid.sidebar
      set({
        rightPanelOpen: wantsPanel && !hide.panel,
        sidebarVisible: wantsSidebar && !hide.sidebar,
        roomHid: { panel: wantsPanel && hide.panel, sidebar: wantsSidebar && hide.sidebar }
      })
      const worktreeId = get().activeWorktreeId
      if (!before.rightPanelOpen && get().rightPanelOpen && worktreeId && changesOnScreen(get())) {
        readChangesNow(worktreeId)
      }
      if (!before.sidebarVisible && get().sidebarVisible) readOnScreen()
    },

    setRightPanelWidth(width) {
      const clamped = clampRightPanelWidth(width)
      set({ rightPanelWidth: clamped })
      writeStoredRightPanelWidth(storage, clamped)
    },

    toggleStaged(path) {
      set((state) => ({
        stagedPaths: state.stagedPaths.includes(path)
          ? state.stagedPaths.filter((entry) => entry !== path)
          : [...state.stagedPaths, path]
      }))
    },

    setAllStaged(staged) {
      const worktreeId = get().activeWorktreeId
      const rows = worktreeId ? (get().changes[worktreeId]?.changes ?? []) : []
      set({ stagedPaths: staged ? rows.map((change) => change.path) : [] })
    },

    async commitStaged(message) {
      const worktreeId = get().activeWorktreeId
      if (!worktreeId) return false
      const ticked = get().stagedPaths
      const rows = get().changes[worktreeId]?.changes ?? []
      const scope = commitScope(ticked, rows)
      // 'staged' names no paths: a path would be added whole, and a hunk left out of the index with it.
      // The list is `git status` without ignored files, so 'all' is `git add -A` for what is on screen.
      const paths = scope === 'ticked' ? ticked : scope === 'all' ? rows.map((change) => change.path) : undefined
      if (paths?.length === 0) return false

      set({ committing: true })
      try {
        const result = await runtimeClient.call('worktree.commit', { worktreeId, message, ...(paths && { paths }) })
        // The commit can capture more than was ticked (anything staged earlier in a terminal); saying
        // so is the difference between a notice and a surprise. Otherwise the Changes tab shows it.
        const extra = paths ? alsoCommitted(result.paths, paths) : 0
        if (extra > 0) notify(`Also committed ${extra} staged file${extra === 1 ? '' : 's'}`, 'info')
        else if (!changesOnScreen(get())) notify(`Committed ${result.shortSha}: ${result.message}`, 'info')
        // Nothing is left ticked; the list refetches on the invalidation the runtime publishes, and
        // doing it here too would be a second way for this window to disagree with the others.
        set({ stagedPaths: [], selectedChangePath: null })
        return true
      } catch (error) {
        failed('Could not commit')(error)
        return false
      } finally {
        set({ committing: false })
      }
    },

    async applyHunk(worktreeId, path, hunk, staged) {
      if (get().hunkPending) return

      set({ hunkPending: true })
      try {
        // The parsed hunk goes over the wire as it stands: the contract's shape is a subset of it.
        await runtimeClient.call(staged ? 'worktree.stageHunk' : 'worktree.unstageHunk', {
          worktreeId,
          path,
          hunk
        })
        // Nothing is set here: both halves come back through the same invalidation the other windows
        // ride, so this one must not get ahead of them.
      } catch (error) {
        failed(staged ? 'Could not stage that hunk' : 'Could not unstage that hunk')(error)
      } finally {
        set({ hunkPending: false })
      }
    },

    async unstagePath(worktreeId, path) {
      if (get().hunkPending) return
      set((state) => ({ hunkPending: true, stagedPaths: state.stagedPaths.filter((entry) => entry !== path) }))
      try {
        await runtimeClient.call('worktree.unstagePath', { worktreeId, path })
      } catch (error) {
        failed(`Could not unstage ${path}`)(error)
      } finally {
        set({ hunkPending: false })
      }
    },

    async discardChange(worktreeId, path, hunk) {
      if (get().hunkPending) return
      set({ hunkPending: true })
      try {
        const discarded =
          hunk === undefined
            ? await runtimeClient.call('worktree.discardPath', { worktreeId, path })
            : await runtimeClient.call('worktree.discardHunk', { worktreeId, path, hunk })
        if (discarded.trashId !== undefined) {
          const undo: UndoTarget = { kind: 'discard', worktreeId, trashId: discarded.trashId }
          notify(hunk === undefined ? `Discarded ${path}` : 'Discarded hunk', 'info', { label: 'Undo', undo })
        }
      } catch (error) {
        failed(hunk === undefined ? `Could not discard ${path}` : 'Could not discard that hunk')(error)
      } finally {
        set({ hunkPending: false })
      }
    },

    async startAgent(command) {
      const worktreeId = get().activeWorktreeId
      const room = worktreeId ? roomOrRefuse(worktreeId) : null
      if (!worktreeId || !room) return
      try {
        // Straight through terminal.create: the runtime pins the session id, so a pane started here resumes like any other.
        const agentArgs = extraArgsFor(command)
        const terminal = await runtimeClient.call('terminal.create', {
          worktreeId,
          command,
          ...room,
          ...(agentArgs === undefined ? {} : { agentArgs })
        })
        set((state) => ({ terminals: { ...state.terminals, [terminal.id]: terminal } }))
        // A click, like the new-terminal button: named before the refresh that reads it, as `createTerminal` does.
        panesAskedFor.add(terminal.id)
        refresher.request(refreshTargets({ layouts: [worktreeId] }))
        await refresher.flush()
      } catch (error) {
        failed('Could not start the agent')(error)
      }
    },

    async loadCli() {
      // A refusal belongs to the attempt that earned it: a cancelled password prompt must not wait for
      // whoever opens the panel next. Cleared on the read because the read is what opening does, and
      // because `installCli` re-reads before it records its own refusal.
      set({ cliPending: true, cliError: null, cliInstall: null })
      try {
        set({ cli: await runtimeClient.call('cli.status', {}) })
      } catch (error) {
        failed('Could not work out where the teamree CLI is')(error)
      } finally {
        set({ cliPending: false })
      }
    },

    async installCli() {
      set({ cliPending: true, cliError: null })
      try {
        const install = await runtimeClient.call('cli.install', {})
        // The runtime resolved the link before answering, so its status is the read-back, not a guess.
        set({ cliInstall: install, cli: install.status })
      } catch (error) {
        // Re-read first, then say what refused: what is at the destination may be why, and the read
        // clears the last refusal, so the new one goes on afterwards.
        await get().loadCli()
        set({ cliError: error instanceof Error ? error.message : String(error) })
      } finally {
        set({ cliPending: false })
      }
    },

    async dismissCliPrompt() {
      // Optimistic: a question that lingers for a round trip is answered twice. The runtime's reply replaces the guess.
      const current = get().cli
      if (current && current.askedAt === null) set({ cli: { ...current, askedAt: Date.now() } })
      try {
        set({ cli: await runtimeClient.call('cli.dismissPrompt', {}) })
      } catch (error) {
        // A notice: an answer not written down is asked for again on the next launch.
        failed('Could not record that teamree asked about putting its CLI on your PATH')(error)
      }
    },

    async loadUpdate() {
      try {
        set({ update: await runtimeClient.call('update.state', {}) })
      } catch {
        // A read of what the runtime already knows; a window that cannot perform it says nothing about updates.
      }
    },

    async checkForUpdates() {
      // Optimistic, so the row pressed says "Checking…" at once.
      const before = get().update
      if (before) set({ update: { ...before, checking: true } })
      try {
        const update = await runtimeClient.call('update.check', {})
        set({ update })
        // The card says the rest when there is something to say; the other two answers have nowhere
        // else to appear, and were asked for.
        if (update.available !== null) return
        if (update.problem !== null) {
          notify(`Could not check for updates: ${update.problem}`, 'info')
          return
        }
        notify(`teamree ${update.current} is the latest release`, 'info')
      } catch (error) {
        set({ update: before })
        failed('Could not check for updates')(error)
      }
    },

    async downloadUpdate() {
      try {
        await runtimeClient.call('update.download', {})
      } catch (error) {
        // Said out loud, unlike a failed check: a pressed button that does nothing is the worst outcome here.
        failed('Could not open the download')(error)
      }
    },

    async fetchInstaller() {
      try {
        set({ update: await runtimeClient.call('update.fetchInstaller', {}) })
      } catch (error) {
        failed('Could not download the update')(error)
      }
    },

    async openInstaller() {
      try {
        await runtimeClient.call('update.openInstaller', {})
      } catch (error) {
        void get().loadUpdate()
        failed('Could not open the installer')(error)
      }
    },

    async restartToUpdate() {
      try {
        const answer = await runtimeClient.call('update.restart', {})
        if ('restarting' in answer) return true
        void get().loadUpdate()
      } catch (error) {
        void get().loadUpdate()
        failed('Could not restart to update')(error)
      }
      return false
    },

    async setAutomaticUpdates(automatic) {
      const before = get().update
      if (before) set({ update: { ...before, automatic } })
      try {
        set({ update: await runtimeClient.call('update.setAutomatic', { automatic }) })
      } catch (error) {
        set({ update: before })
        failed('Could not change whether teamree checks for updates')(error)
      }
    },

    async loadAgentTrust() {
      try {
        set({ trustNewWorktrees: (await runtimeClient.call('agents.trust', {})).trustNewWorktrees })
      } catch {
        // The checkbox keeps showing the default; the runtime acts on its own record either way.
      }
    },

    async setTrustNewWorktrees(on) {
      const before = get().trustNewWorktrees
      set({ trustNewWorktrees: on })
      try {
        set({
          trustNewWorktrees: (await runtimeClient.call('agents.setTrust', { trustNewWorktrees: on })).trustNewWorktrees
        })
      } catch (error) {
        set({ trustNewWorktrees: before })
        failed('Could not change Trust New Worktrees')(error)
      }
    },

    async loadMembers(projectId) {
      // A refusal is about one attempt at one project; re-opening must not show somebody else's.
      set({ membersPending: true, membersError: null })
      try {
        const list = await runtimeClient.call('members.list', { projectId })
        set((state) => ({ members: { ...state.members, [projectId]: list } }))
        readSucceeded(projectId, 'list')
      } catch (error) {
        failed('Could not read the members of this project')(error)
        readFailed(projectId, 'list', error)
      } finally {
        set({ membersPending: false })
      }
    },

    async loadRelay(projectId) {
      // As in `loadMembers`: a refusal is about one attempt at one project.
      set({ relayPending: true, relayError: null })
      try {
        const setting = await runtimeClient.call('teamwork.relay', { projectId })
        set((state) => ({ relays: { ...state.relays, [projectId]: setting } }))
        readSucceeded(projectId, 'relay')
      } catch (error) {
        failed('Could not read where this project’s relay is')(error)
        readFailed(projectId, 'relay', error)
      } finally {
        set({ relayPending: false })
      }
    },

    async loadTeamwork(projectId) {
      try {
        const status = await runtimeClient.call('teamwork.status', { projectId })
        set((state) => ({ teamwork: { ...state.teamwork, [status.projectId]: status } }))
        readSucceeded(projectId, 'status')
      } catch (error) {
        failed('Could not read whether teamwork is running here')(error)
        readFailed(projectId, 'status', error)
      }
    },

    async setRelay(projectId, url) {
      set({ relayPending: true, relayError: null })
      try {
        const setting = await runtimeClient.call('teamwork.setRelay', { projectId, url })
        set((state) => ({ relays: { ...state.relays, [projectId]: setting } }))
        // The same half-done state a join leaves: the file means nothing to anybody else until pushed.
        notify(`Wrote ${setting.file} · commit and push it`, 'info')
      } catch (error) {
        // Kept in the dialog: a refusal names the URL to type instead, useful only beside the field.
        set({ relayError: error instanceof Error ? error.message : String(error) })
      } finally {
        set({ relayPending: false })
      }
    },

    openInvitation(raw, announce = false) {
      const parsed = parsePastedInvitation(raw)
      if (!parsed.ok) {
        const refused = `Not an invitation: ${parsed.reason}`
        if (announce) notify(refused)
        return refused
      }
      set({ dialog: { kind: 'join-team', invitation: parsed.invitation }, joining: null })
      return null
    },

    async joinTeam(invitation, target) {
      if (get().joining?.error === null) return
      set({ joining: { stage: 'clone', error: null } })
      const outcome = await joinTeam(
        (method, params) => runtimeClient.call(method, params),
        invitation,
        target,
        (stage) => set({ joining: { stage, error: null } })
      )
      const project = outcome.project
      if (project !== undefined) {
        set((state) => ({
          projects: state.projects.some((entry) => entry.id === project.id)
            ? state.projects
            : [...state.projects, project],
          joinedFrom: { ...state.joinedFrom, [project.id]: invitation.from },
          ...(outcome.publish === undefined
            ? {}
            : { publishResults: { ...state.publishResults, [project.id]: outcome.publish } })
        }))
      }
      // Anything short of a project stays in the sheet; after that the team page is where the rest is fixed.
      if (!outcome.ok && project === undefined) {
        set({ joining: { stage: outcome.stage, error: outcome.error } })
        return
      }
      set({ dialog: null, joining: null })
      if (project === undefined) return
      get().openTeamwork(project.id)
      if (!outcome.ok) notify(outcome.error)
    },

    async answerSetup(worktreeId, run) {
      try {
        const answered = await runtimeClient.call('worktree.setup', { worktreeId, run })
        set((state) => ({ worktrees: state.worktrees.map((entry) => (entry.id === answered.id ? answered : entry)) }))
      } catch (error) {
        failed(run ? 'Could not run the setup command' : 'Could not skip the setup command')(error)
      }
    },

    async saveProjectSettings(projectId) {
      try {
        const stored = get().startPointDefaults[projectId]
        const { file, project } = await runtimeClient.call('project.saveSettings', {
          projectId,
          ...(stored ? { startFrom: stored } : {})
        })
        set((state) => ({ projects: state.projects.map((entry) => (entry.id === project.id ? project : entry)) }))
        notify(`Wrote ${file} · commit it`, 'info')
      } catch (error) {
        failed('Could not write the project’s setup')(error)
      }
    },

    async joinProject(projectId, handle) {
      set({ membersPending: true, membersError: null })
      try {
        const list = await runtimeClient.call('members.join', handle ? { projectId, handle } : { projectId })
        set((state) => ({ members: { ...state.members, [projectId]: list } }))
        // As a notice too: the file is the smaller half, and nobody else sees it until it is pushed.
        if (list.selfFile) notify(`Wrote ${list.selfFile} · commit and push it`, 'info')
      } catch (error) {
        // Kept in the panel, as a refused relay URL is: every refusal here ends in "choose another
        // handle", an instruction about the box the cursor is in.
        set({ membersError: error instanceof Error ? error.message : String(error) })
      } finally {
        set({ membersPending: false })
      }
    },

    async setOrigin(projectId, url) {
      set({ originPending: true, originError: null })
      try {
        const result = await runtimeClient.call('teamwork.setOrigin', { projectId, url })
        // The status caches the project key against a stamp of git's config, which has just moved;
        // this read turns the blocker green without a restart.
        await get().loadTeamwork(projectId)
        await get().loadPublishPlan(projectId)
        notify(result.replaced ? `origin now points at ${result.url}` : `Added origin ${result.url}`, 'info')
      } catch (error) {
        // Beside the field, like every other refusal here.
        set({ originError: error instanceof Error ? error.message : String(error) })
      } finally {
        set({ originPending: false })
      }
    },

    async startRelayPane(projectId, kind, argument) {
      const project = get().projects.find((entry) => entry.id === projectId)
      const deployCommand = get().relays[projectId]?.deploy.command
      // Each of these already disables the button; checked again because a store action is reachable from more than one.
      if (!project || !deployCommand || get().relayPanes[projectId]) return
      // The check button is disabled with `RELAY_CHECK.nothing` when there is no URL; without this a
      // caller could run `<launcher> check` with no argument, in a pane titled as though it were a check.
      if (kind === 'check' && (argument === undefined || argument.trim() === '')) return
      // The runtime reports one command; the other verbs are the same launcher with the verb swapped,
      // and null when what was reported is not that shape.
      const command = kind === 'deploy' ? deployCommand : relayLauncherCommand(deployCommand, kind, argument)
      if (command === null) return
      try {
        const terminal = await runtimeClient.call('terminal.create', {
          worktreeId: teamworkPaneWorktreeId(projectId, kind),
          cwd: project.path,
          command,
          ...paneSizeFor(teamworkPaneWorktreeId(projectId, kind))
        })
        set((state) => ({
          terminals: { ...state.terminals, [terminal.id]: terminal },
          relayPanes: {
            ...state.relayPanes,
            [projectId]: { kind, terminalId: terminal.id, url: null, urls: [], running: true }
          }
        }))
      } catch (error) {
        failed(kind === 'check' ? 'Could not check that relay' : 'Could not start the relay')(error)
      }
    },

    async closeRelayPane(projectId) {
      const pane = get().relayPanes[projectId]
      if (!pane) return
      // Terminal first, slot second: the slot is rebuilt from the runtime's list, and dropping it first
      // leaves a window in which a refresh adopts the pane just closed straight back onto the screen.
      await runtimeClient.call('terminal.close', { terminalId: pane.terminalId }).catch(() => undefined)
      set((state) => {
        const { [projectId]: _closed, ...rest } = state.relayPanes
        return { relayPanes: rest }
      })
    },

    noteRelayPane(projectId, output, running) {
      const pane = get().relayPanes[projectId]
      if (!pane) return
      // Which schemes count is the pane's: a deploy prints wss://, a relay run here ws://, a check is a report.
      const schemes = RELAY_PANE_URL_SCHEMES[pane.kind]
      // Only the tail is read, and a working relay logs until the announcement scrolls out of it, so a
      // URL once found is kept until the pane closes. A later scrape still wins: a second deploy in one
      // pane means the second one.
      const found = relayUrlFromOutput(output, schemes)
      const url = found ?? pane.url
      const urls = found === null ? pane.urls : relayUrlsFromOutput(output, schemes)
      if (pane.url === url && pane.running === running && sameUrls(pane.urls, urls)) return
      set((state) => ({
        relayPanes: { ...state.relayPanes, [projectId]: { ...pane, url, urls, running } }
      }))
    },

    async loadPublishPlan(projectId) {
      try {
        const plan = await runtimeClient.call('teamwork.publishPlan', { projectId })
        set((state) => ({ publishPlans: { ...state.publishPlans, [projectId]: plan } }))
      } catch (error) {
        // Not a notice: the panel shows the button disabled, and the read is retried every open.
        set({ publishError: error instanceof Error ? error.message : String(error) })
      }
    },

    async loadPublishProgress(projectId) {
      try {
        const progress = await runtimeClient.call('teamwork.publishProgress', { projectId })
        if (progress === null) return
        set((state) => ({ publishProgress: { ...state.publishProgress, [projectId]: progress } }))
      } catch {
        // Silent: a poll beside a call that will report its own failure, and thirty notices would
        // bury the one that matters.
      }
    },

    async cancelPublish(projectId) {
      await runtimeClient.call('teamwork.cancelPublish', { projectId }).catch(() => undefined)
      // Read straight back: a Stop must change something on screen at once, or it reads as doing nothing.
      await get().loadPublishProgress(projectId)
    },

    async publishTeamwork(projectId) {
      if (get().publishPending) return
      // Otherwise the previous run's record reads as this one's until the first poll: a stopwatch
      // starting at the last push's duration.
      set((state) => {
        const { [projectId]: _previous, ...rest } = state.publishProgress
        return { publishPending: true, publishError: null, publishProgress: rest }
      })
      try {
        const result = await runtimeClient.call('teamwork.publish', { projectId })
        set((state) => ({ publishResults: { ...state.publishResults, [projectId]: result } }))
        // A notice too: the one act here that leaves the machine, and a reader may be elsewhere.
        notify(
          result.push.ok
            ? result.push.alreadyUpToDate
              ? `${result.remote} already had ${result.branch}`
              : `Pushed ${result.branch} to ${result.remote}`
            : // "Refused" is the remote's verdict, wrong for a push somebody stopped or one that never finished.
              `${result.commit === null ? 'Nothing to commit, and the' : 'Committed, but the'} push ${
                result.push.kind === 'cancelled'
                  ? 'was stopped'
                  : result.push.kind === 'timeout'
                    ? 'never finished'
                    : 'was refused'
              }: ${result.push.advice}`,
          result.push.ok ? 'info' : 'error'
        )
      } catch (error) {
        set({ publishError: error instanceof Error ? error.message : String(error) })
      } finally {
        set({ publishPending: false })
        // One last read, so the panel can report how long it took.
        await get().loadPublishProgress(projectId)
        await get().loadPublishPlan(projectId)
        await get().loadMembers(projectId)
      }
    },

    clearMembersError() {
      if (get().membersError !== null) set({ membersError: null })
    },

    async pushActiveWorktree() {
      const worktreeId = get().activeWorktreeId
      if (!worktreeId || get().pushing) return

      const setPush = (push: PushState): void => set((state) => ({ pushes: { ...state.pushes, [worktreeId]: push } }))
      set({ pushing: true })
      setPush({ phase: 'pushing' })
      try {
        const result = await runtimeClient.call('worktree.push', { worktreeId })
        // The Changes header says it where it was asked: Push gives way to Open review.
        const { rightPanelOpen, rightPanelTab } = get()
        if (!rightPanelOpen || rightPanelTab !== 'changes') {
          notify(
            result.alreadyUpToDate ? 'Up to date' : 'Pushed',
            'info',
            result.reviewUrl === undefined ? undefined : { label: 'Open review', url: result.reviewUrl }
          )
        }
        setPush({ phase: 'pushed', ...(result.reviewUrl === undefined ? {} : { reviewUrl: result.reviewUrl }) })
        // The remote has every commit now; the next status read confirms it, and the tab should not offer Push until then.
        set((state) => {
          const status = state.statuses[worktreeId]
          if (!status) return {}
          return { statuses: { ...state.statuses, [worktreeId]: { ...status, ahead: 0, upstream: result.upstream } } }
        })
      } catch (error) {
        setPush(pushFailure(error))
        // Said once, beside the button: brought into view rather than repeated as a notice.
        if (!changesOnScreen(get()) && get().activeWorktreeId === worktreeId) get().showRightPanelTab('changes')
      } finally {
        set({ pushing: false })
      }
    },

    async updateWorktree(worktreeId) {
      if (get().updating !== null) return
      set((state) => {
        const { [worktreeId]: _cleared, ...updateErrors } = state.updateErrors
        return { updating: worktreeId, updateErrors }
      })
      try {
        await runtimeClient.call('worktree.update', { worktreeId })
      } catch (error) {
        const line = error instanceof Error ? error.message : String(error)
        set((state) => ({ updateErrors: { ...state.updateErrors, [worktreeId]: line } }))
      } finally {
        set({ updating: null })
        await refreshStatuses([worktreeId])
        if (changesOnScreen(get()) && get().activeWorktreeId === worktreeId) readChangesNow(worktreeId)
      }
    },

    async abortUpdate(worktreeId) {
      try {
        await runtimeClient.call('worktree.abortUpdate', { worktreeId })
      } catch (error) {
        failed('Could not abort')(error)
      }
      await refreshStatuses([worktreeId])
      if (changesOnScreen(get()) && get().activeWorktreeId === worktreeId) readChangesNow(worktreeId)
    },

    async typeIntoPane(terminalId, text) {
      await runtimeClient
        .call('terminal.write', { terminalId, data: text })
        .catch(failed('Could not type into the pane'))
    },

    async createPullRequest(worktreeId) {
      const open = get().landings[worktreeId]?.pullRequest
      if (open?.state === 'open') {
        openInBrowser(open.url)
        return
      }
      if (get().openingPullRequest) return
      set({ openingPullRequest: true })
      try {
        const made = await runtimeClient.call('worktree.createPullRequest', { worktreeId })
        if (!made.created || made.number === undefined) {
          openInBrowser(made.url)
          return
        }
        const number = made.number
        // Said by the button at once; the next read confirms it.
        set((state) => {
          const landing = state.landings[worktreeId]
          if (!landing) return {}
          const pullRequest = { number, url: made.url, state: 'open' as const }
          return { landings: { ...state.landings, [worktreeId]: { ...landing, pullRequest } } }
        })
      } catch (error) {
        failed('Could not create the pull request')(error)
      } finally {
        set({ openingPullRequest: false })
      }
    },

    async mergeIntoBase(worktreeId) {
      try {
        await runtimeClient.call('worktree.mergeIntoBase', { worktreeId })
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
      if (get().dialog?.kind === 'confirm-merge') set({ dialog: null })
      refresher.request(refreshTargets({ statuses: [worktreeId] }))
      return null
    },

    async confirmKeepRun(worktreeId, force) {
      set({ dialog: null })
      let kept: WorktreeKeep
      try {
        kept = await runtimeClient.call('worktree.keep', force ? { worktreeId, force: true } : { worktreeId })
      } catch (error) {
        // Something appeared since the dialog read the other runs: ask again, and it reads again.
        if (!force && isRefusal(error)) {
          set({ dialog: { kind: 'confirm-keep', worktreeId, refused: true } })
          return
        }
        failed('Could not keep this run')(error)
        return
      }
      const removed = new Set(kept.removed)
      const before = get().worktrees.find((entry) => entry.id === worktreeId)?.name
      for (const id of removed) forgetWorktree(id)
      // A pane named after the run goes by the task's name with it.
      if (before !== undefined && before !== kept.worktree.name) {
        const named = Object.values(get().terminals).filter(
          (terminal) => terminal.worktreeId === worktreeId && terminal.label?.trim() === before
        )
        void Promise.all(
          named.map((terminal) =>
            runtimeClient
              .call('terminal.rename', { terminalId: terminal.id, label: kept.worktree.name })
              .catch(() => null)
          )
        )
      }
      set((state) => ({
        worktrees: state.worktrees.map((entry) => (entry.id === kept.worktree.id ? kept.worktree : entry))
      }))
      await get().openWorktree(worktreeId)
      const stale = fileLeavesIn(get().layouts[worktreeId]?.root ?? null)
        .filter((leaf) => isCompareLeaf(leaf) && removed.has(leaf.compare))
        .map((leaf) => leaf.terminalId)
      if (stale.length > 0) await get().closePanes(stale)
    },

    foldForCompare(on) {
      const before = get()
      if (on) {
        if (before.compareHid !== null) return
        set({
          compareHid: { panel: before.rightPanelOpen, sidebar: before.sidebarVisible },
          rightPanelOpen: false,
          sidebarVisible: false
        })
        return
      }
      const hid = before.compareHid
      if (hid === null) return
      set({
        compareHid: null,
        rightPanelOpen: before.rightPanelOpen || hid.panel,
        sidebarVisible: before.sidebarVisible || hid.sidebar
      })
      const worktreeId = get().activeWorktreeId
      if (hid.panel && !before.rightPanelOpen && worktreeId && changesOnScreen(get())) readChangesNow(worktreeId)
      if (hid.sidebar && !before.sidebarVisible) readOnScreen()
    },

    selectChange(path, pin = false) {
      const worktreeId = get().activeWorktreeId
      set({ selectedChangePath: path })
      if (path === null || !worktreeId) return
      get().openFilePane(worktreeId, path, pin ? 'diff' : 'diff-preview')
      // Zoomed: the diff is what was asked for. A view only, so restoring gives the layout back as it was.
      const opened = fileLeavesIn(get().layouts[worktreeId]?.root ?? null).find(
        (leaf) => leaf.path === path && !isCommitLeaf(leaf)
      )
      if (opened) set({ expandedTerminalId: opened.terminalId })
    },

    async decideConsent(requestId, decision, through) {
      try {
        const answer = await runtimeClient.call('teamwork.decide', { requestId, decision, through })
        set((state) => ({ consent: { ...state.consent, [answer.projectId]: answer } }))
      } catch (error) {
        // Named: a prompt that failed to be answered and said nothing would leave the owner believing they had decided.
        failed('Could not answer that request')(error)
      }
    },

    async revokeConsent(terminalId, publicKey) {
      try {
        const answer = await runtimeClient.call('teamwork.revoke', { terminalId, publicKey })
        set((state) => ({ consent: { ...state.consent, [answer.projectId]: answer } }))
      } catch (error) {
        failed('Could not lift that permission')(error)
      }
    },

    async mutePane(terminalId, muted) {
      try {
        const answer = await runtimeClient.call('teamwork.mute', { terminalId, muted })
        set((state) => ({ watchers: { ...state.watchers, [answer.projectId]: answer } }))
      } catch (error) {
        failed('Could not change this pane’s mute')(error)
      }
    },

    toggleWatchedPane(projectId, pane) {
      const id = watchedPaneId(projectId, pane.terminalId)
      if (get().watches.some((watch) => watch.id === id)) {
        get().closeWatchedPane(id)
        return
      }
      set((state) => ({
        watches: [...state.watches, { id, projectId, paneId: pane.terminalId, label: pane.label, handle: pane.handle }],
        watchTails: { ...state.watchTails, [id]: '' },
        // Focused on arrival, like a pane you just opened.
        focusedWatchId: id
      }))
    },

    closeWatchedPane(id) {
      set((state) => {
        if (!state.watches.some((watch) => watch.id === id)) return {}
        const watchTails = { ...state.watchTails }
        delete watchTails[id]
        return {
          watches: state.watches.filter((watch) => watch.id !== id),
          watchTails,
          focusedWatchId: state.focusedWatchId === id ? neighbourWatchId(state.watches, id) : state.focusedWatchId
        }
      })
    },

    noteWatchedPaneOutput(id, data) {
      set((state) => {
        const tail = state.watchTails[id]
        // Absent means the pane has closed and the chunk was in flight; keeping it would quote a dead row.
        if (tail === undefined) return {}
        return { watchTails: { ...state.watchTails, [id]: (tail + data).slice(-WATCH_TAIL_CHARS) } }
      })
    },

    setWatchSizes(sizes) {
      set({ watchSizes: sizes })
    },

    toggleProject(projectId) {
      set((state) => ({
        collapsedProjects: { ...state.collapsedProjects, [projectId]: !state.collapsedProjects[projectId] }
      }))
      // Expanding puts back rows not read while hidden; collapsing needs nothing.
      if (!get().collapsedProjects[projectId]) readOnScreen()
    },

    setSidebarWidth(width) {
      const clamped = clampSidebarWidth(width)
      set({ sidebarWidth: clamped })
      writeStoredSidebarWidth(storage, clamped)
    },

    toggleDashboard() {
      // Two views, one main area: whichever is asked for takes it.
      set((state) => ({
        dashboardOpen: !state.dashboardOpen,
        teamworkProjectId: null,
        settingsOpen: false,
        helpOpen: false
      }))
    },

    toggleSettings() {
      // The same one main area. A toggle, so the chord that opened it is how you leave.
      set((state) => ({
        settingsOpen: !state.settingsOpen,
        settingsSection: null,
        appearanceOpen: false,
        helpOpen: false,
        dashboardOpen: false,
        teamworkProjectId: null
      }))
    },

    openSettings(section) {
      set({
        settingsOpen: true,
        settingsSection: section,
        appearanceOpen: false,
        helpOpen: false,
        dashboardOpen: false,
        teamworkProjectId: null
      })
    },

    showAppearance(open) {
      // The pages that replace the panes step aside, so the change is seen on them.
      set(
        open
          ? { appearanceOpen: true, settingsOpen: false, helpOpen: false, teamworkProjectId: null }
          : { appearanceOpen: false }
      )
    },

    toggleHelp() {
      set((state) => ({
        helpOpen: !state.helpOpen,
        appearanceOpen: false,
        settingsOpen: false,
        dashboardOpen: false,
        teamworkProjectId: null
      }))
    },

    async revealInFinder(path, what) {
      // The main process decides whether the path is there; a "no" is a notice, not a fault, because
      // revealing a deleted checkout is ordinary. Guarded like `storage`: tests import this store under
      // node, where `window` is a ReferenceError rather than an undefined.
      const reveal = typeof window === 'undefined' ? undefined : window.teamree?.revealPath
      if (reveal === undefined) {
        notify(`Cannot open ${what} in a file manager from this window`, 'info')
        return
      }
      try {
        const result = await reveal(path)
        if (!result.revealed) notify(`Could not show ${what}: ${result.reason}`, 'info')
      } catch (error) {
        failed(`Could not show ${what}`)(error)
      }
    },

    async openInDefaultApp(path, what) {
      const open = typeof window === 'undefined' ? undefined : window.teamree?.openPath
      if (open === undefined) {
        notify(`Cannot open ${what} from this window`, 'info')
        return
      }
      try {
        const result = await open(path)
        if (!result.revealed) notify(`Could not open ${what}: ${result.reason}`, 'info')
      } catch (error) {
        failed(`Could not open ${what}`)(error)
      }
    },

    setTerminalFontSize(size) {
      const clamped = clampTerminalFontSize(size)
      set({ terminalFontSize: clamped })
      writeStoredTerminalFontSize(storage, clamped)
    },

    setTerminalOptions(patch) {
      const next = sanitizeTerminalOptions({ ...get().terminalOptions, ...patch })
      set({ terminalOptions: next })
      writeStoredTerminalOptions(storage, next)
    },

    setAgentNotices(preference) {
      set({ agentNotices: preference })
      writeStoredAgentNotices(storage, preference)
    },

    setKeepAwake(mode) {
      set({ keepAwake: mode })
      writeStoredKeepAwake(storage, mode)
    },

    setDiffLayout(layout) {
      set({ diffLayout: layout })
      writeStoredDiffLayout(storage, layout)
    },

    setStartPointDefault(projectId, ref) {
      const startPointDefaults = withStartPoint(get().startPointDefaults, projectId, ref)
      set({ startPointDefaults })
      writeStoredStartPoints(storage, startPointDefaults)
    },

    setDefaultAgent(kind) {
      const defaultAgent = kind.trim()
      set({ defaultAgent })
      writeStoredDefaultAgent(storage, defaultAgent)
    },

    setAgentArgs(kind, args) {
      const agentArgs = withAgentArgs(get().agentArgs, kind, args)
      set({ agentArgs })
      writeStoredAgentArgs(storage, agentArgs)
    },

    async setProjectPaths(projectId, settings) {
      try {
        const project = await runtimeClient.call('project.setPaths', { projectId, ...settings })
        // Taken from the answer: the runtime trims, de-duplicates and drops an empty list.
        set((state) => ({ projects: state.projects.map((row) => (row.id === project.id ? project : row)) }))
      } catch (error) {
        failed('Could not save the project setting')(error)
      }
    },

    setEditorCommand(projectId, command) {
      const editorCommands = withEditorCommand(get().editorCommands, projectId, command)
      set({ editorCommands })
      writeStoredEditorCommands(storage, editorCommands)
    },

    async loadEditors() {
      // Once per run: a probe on every right-click would be a Spotlight query per menu.
      if (get().editors !== null) return
      try {
        set({ editors: (await runtimeClient.call('editor.list', {})).editors })
      } catch {
        // Silent, and the empty list: a notice about a probe nobody asked for is noise, and choosing
        // the item still asks the main process, which answers with a reason.
        set({ editors: [] })
      }
    },

    async openInEditor(path, command, what) {
      // The main process decides whether an editor exists; a "no" is a notice, not a fault, as `revealInFinder` settles.
      try {
        const result = await runtimeClient.call('editor.open', {
          path,
          // Spread rather than passed as `undefined`: the same thing to zod, not to a reader.
          ...(command === undefined || command.trim().length === 0 ? {} : { command: command.trim() })
        })
        if (!result.opened) notify(`Could not open ${what}: ${result.reason}`, 'info')
      } catch (error) {
        failed(`Could not open ${what}`)(error)
      }
    },

    async copyToClipboard(text, what) {
      // The async clipboard API needs a secure context, and a renderer loaded from a file URL in a
      // packaged build is not reliably one, so a failure is reported: what this copies is not on screen.
      const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
      if (clipboard === undefined) {
        notify(`Clipboard unavailable · ${what} not copied`, 'info')
        return
      }
      try {
        await clipboard.writeText(text)
        notify(`Copied ${what}`, 'info')
      } catch (error) {
        failed(`Could not copy ${what}`)(error)
      }
    },

    async copyPaneOutput(terminalId, name) {
      let text = shownText(terminalId)
      if (text === null) {
        try {
          const { data } = await runtimeClient.call('terminal.read', { terminalId })
          text = replayLines(data)
            .map((line) => line.trimEnd())
            .join('\n')
            .trimEnd()
        } catch (error) {
          failed(`Could not read ${name}`)(error)
          return
        }
      }
      await get().copyToClipboard(text, `the output of ${name}`)
    },

    toggleSidebar() {
      set((state) => ({ sidebarVisible: !state.sidebarVisible, roomHid: { ...state.roomHid, sidebar: false } }))
      // Bringing the sidebar back brings every expanded row with it.
      if (get().sidebarVisible) readOnScreen()
    },

    async setAppearance(appearance) {
      // Held locally first so the window repaints on the keystroke; the runtime's answer replaces it
      // with anything it refused taken out.
      set({ appearance })
      try {
        set({ appearance: await runtimeClient.call('appearance.set', appearance) })
      } catch (error) {
        failed('Could not save the appearance')(error)
      }
    },

    setSystemTone(systemTone) {
      if (get().systemTone !== systemTone) set({ systemTone })
    },

    openTeamwork(projectId) {
      set({
        teamworkProjectId: projectId,
        dashboardOpen: false,
        settingsOpen: false,
        helpOpen: false,
        appearanceOpen: false
      })
    },

    closeTeamwork() {
      set({ teamworkProjectId: null })
    },

    openDialog(dialog) {
      if (get().dialog?.kind === 'confirm-unsaved') settleLeaving(false)
      set({ dialog })
    },

    closeDialog() {
      const { dialog } = get()
      set({ dialog: null })
      if (dialog?.kind === 'confirm-unsaved') settleLeaving(false)
      // Close Others asks about one pane at a time; answering, either way, asks about the next.
      if (dialog?.kind === 'confirm-close-pane' && dialog.rest) {
        void get().closePanes(dialog.rest)
      }
    },

    dismissNotice(id) {
      set((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) }))
    }
  }
})

/**
 * One writer for everything the next launch restores: a dozen places open, close or move a tab, and
 * watching the state is the only version of this that cannot be forgotten in a new one.
 */
useWorkspaceStore.subscribe((state, previous) => {
  if (!sessionChanged(state, previous)) return
  writeStoredSession(storage, {
    ...state,
    sidebarVisible: state.sidebarVisible || state.roomHid.sidebar || state.compareHid?.sidebar === true
  })
})

/** And one writer for what has been read, on the same terms. */
useWorkspaceStore.subscribe((state, previous) => {
  if (state.paneSeenAt === previous.paneSeenAt) return
  writePaneSeen(storage, state.paneSeenAt)
})

/**
 * Whether the runtime refused rather than failed: a refusal is the only answer this window may turn
 * into a question for the user, and a fault must never be read as consent.
 */
function isRefusal(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'conflict'
}

/** How many committed paths no ticked path covers: a ticked folder (`docs/`) covers the files under it. */
export function alsoCommitted(committed: readonly string[], ticked: readonly string[]): number {
  const covered = (path: string): boolean =>
    ticked.some((entry) => entry === path || (entry.endsWith('/') && path.startsWith(entry)))
  return committed.filter((path) => !covered(path)).length
}

/** A refused push carries its clause and git's words; anything else is a clause of our own over its message. */
function pushFailure(error: unknown): PushState {
  const message = error instanceof Error ? error.message : String(error)
  const detail = (error as { data?: Partial<PushFailureData> } | null)?.data?.detail
  return typeof detail === 'string'
    ? { phase: 'failed', error: message, detail }
    : { phase: 'failed', error: 'Push failed', detail: message }
}

/**
 * Whether two scrapes found the same addresses in the same order; comparing before setting keeps a
 * running relay from re-rendering the panel forty times a minute over a list that has not moved.
 */
function sameUrls(before: string[], after: string[]): boolean {
  return before.length === after.length && before.every((url, index) => url === after[index])
}

/** Drops entries whose worktree the runtime no longer lists. */
function keptFor<T>(byWorktree: Record<string, T>, live: Set<string>): Record<string, T> {
  const entries = Object.entries(byWorktree).filter(([worktreeId]) => live.has(worktreeId))
  return entries.length === Object.keys(byWorktree).length ? byWorktree : Object.fromEntries(entries)
}

export type { Worktree, WorktreeStatus, Project, Terminal, Layout }
