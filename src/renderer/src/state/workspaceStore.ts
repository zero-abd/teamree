// One store for everything the window shows. The runtime is the source of
// truth; this keeps a read model of it plus the purely local bits (which tabs
// are open, which pane has focus, how wide the sidebar is).

import { create } from 'zustand'
import { hasCheckout } from '@shared/entities'
import type {
  CliInstall,
  CliStatus,
  ConsentDecision,
  InstalledAgent,
  Layout,
  MemberList,
  PaneConsent,
  PaneNode,
  PaneWatchers,
  Project,
  RelaySetting,
  TeammatePresence,
  TeamworkPublish,
  TeamworkPublishPlan,
  TeamworkPublishProgress,
  TeamworkStatus,
  Terminal,
  UpdateState,
  Worktree,
  WorktreeChanges,
  WorktreeDiff,
  WorktreeLog,
  WorktreeMergePreview,
  WorktreeStatus
} from '@shared/entities'
import { DEFAULT_APPEARANCE, type Appearance } from '@shared/theme'
import {
  DEFAULT_MARKDOWN_PATH,
  fileLeaf,
  fileLeavesIn,
  isFilePaneId,
  isMarkdownPath,
  newFilePaneId
} from '@shared/filePane'
import { closePaneWarning } from '../dialogs/closePaneModel'
import { noticeLifetime } from '../notices/noticeLifetime'
import type { TaskCreate } from '../dialogs/taskPlan'
import {
  appendPane,
  closePane,
  collectTerminalIds,
  neighbourTerminalId,
  setSizesAt,
  splitPaneWith
} from '../panes/paneLayout'
import { worktreeAfter, worktreeOrder } from '../sidebar/worktreeOrder'
import {
  isWatchedPaneId,
  neighbourWatchId,
  paneCycle,
  watchedPaneId,
  WATCH_TAIL_CHARS,
  type WatchedPane
} from '../panes/watchedPanes'
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
import { newPaneSize } from '../terminal/paneMetrics'
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
  type AgentNoticePreference,
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
  writeStoredTerminalFontSize
} from './preferences'
import { forgetClosedPanes, markSeen, readPaneSeen, writePaneSeen, type PaneSeen } from './paneSeen'
import type { PatchHunk } from '@shared/patch'
import type { ProjectAddRefusal } from '@shared/methods'
import type { DiffLayout } from './preferences'
import { createLocalEditFence, createWorkspaceRefresher, refreshTargets, type RefreshTargets } from './workspaceRefresh'
import { readStoredSession, sessionChanged, writeStoredSession } from './storedSession'
import {
  changesOnScreen,
  readStoredRightPanel,
  readStoredRightPanelWidth,
  clampRightPanelWidth,
  writeStoredRightPanel,
  writeStoredRightPanelWidth,
  type RightPanelTab
} from '../workspace/rightPanel/rightPanelState'

export type DialogState =
  | { kind: 'add-project' }
  | { kind: 'appearance' }
  | { kind: 'install-cli' }
  | { kind: 'new-task'; projectId: string }
  | { kind: 'palette' }
  /** Raised only when the runtime has already refused: there is something here to lose. */
  | { kind: 'confirm-remove'; worktreeId: string; reason: string; intent: RemoveIntent }
  /** Raised only when the pane is doing work a close would kill. See `closePaneModel`. */
  | { kind: 'confirm-close-pane'; terminalId: string }
  | null

/** Why the removal was asked for: a retry removes the old checkout to build a new one, and the confirmation says so. */
export type RemoveIntent = 'remove' | 'retry'

/** What the task composer submits: what to make, who runs it, and from where. */
export type TaskDraft = {
  projectId: string
  startedFrom?: string
  /** One worktree per entry, in creation order, each already named by `taskCreates`. */
  creates: readonly TaskCreate[]
}

export type Notice = {
  id: number
  text: string
  tone: 'error' | 'info'
  /** One thing to do about the notice, e.g. a review page a push made. A URL, not a callback: see `shell/openInBrowser.ts`. */
  action?: { label: string; url: string }
}

/** The last push of one worktree, as the Changes tab shows it. */
export type PushState =
  | { phase: 'pushing' }
  | { phase: 'pushed'; reviewUrl?: string }
  | { phase: 'failed'; error: string }

/** The find bar belongs to the focused pane. `token` changes on every press, which is how a repeat press re-takes an open field. */
export type PaneSearch = { terminalId: string; token: number }

/** Which of the teamwork panel's three reads last failed, and what each said. */
export type TeamworkReadErrors = { list?: string; relay?: string; status?: string }

/** A relay command running in a pane in this window, one pane per project. Rebuilt from the runtime's list, see `reconcileRelayPanes`. */
export type { RelayPaneKind, RelayPaneState } from '../teamwork/startTeamwork'

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

  /** File panes with edits not yet on disk, by pane id; each tab draws a dot. */
  unsavedFiles: Record<string, true>
  /** A markdown editor holds the keyboard, so ⌘B and ⌘E are bold and code, not the window's. */
  editingMarkdown: boolean
  /** The worktree whose strip asks for a file name, because NOTES.md is already open. */
  namingMarkdown: string | null
  /** Bumped when the runtime says a worktree's files moved; a file pane re-reads on it. */
  worktreeFilesEpoch: number

  /** When each pane was last in front of this person, by terminal id. Local, from `localStorage`; see `paneSeen.ts`. */
  paneSeenAt: PaneSeen

  /** Whether each ready worktree would merge into its base, as last read. */
  mergePreviews: Record<string, WorktreeMergePreview>

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
  /** Coding agents this machine can run, probed once at startup. */
  agents: InstalledAgent[]
  /** True once the probe has answered; until then an empty `agents` means "not asked yet". */
  agentsProbed: boolean
  diff: WorktreeDiff | null
  /** The same path's staged patch, read beside the working-tree one so a hunk knows which half it came from. */
  stagedDiff: WorktreeDiff | null
  diffPending: boolean
  /** True while a hunk is being staged or unstaged, so the controls settle. */
  hunkPending: boolean

  collapsedProjects: Record<string, boolean>
  openWorktreeIds: string[]
  activeWorktreeId: string | null
  /** Whether the pane dashboard has the main area, replacing the panes rather than sharing with them. */
  dashboardOpen: boolean
  /** Which project's teamwork setup has the main area, or null. About a project, so not bound to a tab. */
  teamworkProjectId: string | null
  /** Whether settings has the main area, and whether help does; neither belongs in a tab. */
  settingsOpen: boolean
  /** The section the settings page opens scrolled to, until it has. */
  settingsSection: SettingsSection | null
  helpOpen: boolean

  sidebarWidth: number
  sidebarVisible: boolean
  paneSearch: PaneSearch | null
  dialog: DialogState
  notices: Notice[]
  /** Pane text size in CSS pixels, and each project's preferred start point. Held in the store so panes re-render. */
  terminalFontSize: number
  startPointDefaults: Record<string, string>
  /** Whether an agent stopping while you are elsewhere may say so. The reader is the main process, via `useAgentNotices`. */
  agentNotices: AgentNoticePreference
  /** Whether this Mac may sleep. Held here for the reason `agentNotices` is; `useKeepAwake` publishes it. */
  keepAwake: KeepAwakeMode
  /** Each project's editor command, by project id. Empty means "whatever is on PATH". */
  editorCommands: Record<string, string>
  /** Editors found on PATH, or null until asked: null is "not looked yet", empty is "found none". */
  editors: { command: string; label: string }[] | null
  /** Whether the patch in the changes panel is laid out inline or side by side. */
  diffLayout: DiffLayout
  /** The agent kind the composer offers first, and what each kind is launched with. See `preferences.ts`. */
  defaultAgent: string
  agentArgs: Record<string, string>

  /** How this window is painted. Held here so a colour edited in the dialog is live in the panes behind it. */
  appearance: Appearance

  bootstrap: () => Promise<void>
  /** Opens the change stream. Returns the stop function an effect cleans up with. */
  startWatching: () => () => void

  /** Answers the refusal when the folder cannot be a project, for the dialog to show; null otherwise. */
  addProject: (path: string, name?: string, init?: boolean) => Promise<ProjectAddRefusal | null>
  /** Creates the worktree, waits for it, then starts the agent in it. */
  startTask: (draft: TaskDraft) => void
  retryWorktree: (worktreeId: string) => void
  removeWorktree: (worktreeId: string) => Promise<void>
  /** Goes through with a removal git refused, discarding the work in it. */
  forceRemoveWorktree: (worktreeId: string) => Promise<void>

  openWorktree: (worktreeId: string) => Promise<void>
  closeWorktreeTab: (worktreeId: string) => void
  /** Opens the worktree a pane lives in and puts the focus on that pane. */
  revealPane: (worktreeId: string, terminalId: string) => Promise<void>

  /** Puts the focus on one pane, whether it is yours or a teammate's. */
  focusPane: (paneId: string) => void
  /** Writes down that these panes are in front of this person now. */
  markPanesSeen: (terminalIds: readonly string[]) => void
  /** Adopts a fresh terminal record, e.g. the one a resize answers with. */
  recordTerminal: (terminal: Terminal) => void
  splitFocusedPane: (direction: 'row' | 'column') => Promise<void>
  /** Closes a pane, asking first when the close would kill work. Every close path comes through here, so the question is asked once. */
  closeTerminal: (terminalId: string) => Promise<void>
  /** Names a pane, or clears the name when given nothing. */
  renamePane: (terminalId: string, label: string) => Promise<void>
  /** Goes through with it, once the question this app asked has been answered. */
  forceCloseTerminal: (terminalId: string) => Promise<void>
  /** Runs an exited pane's program again, in the same pane. */
  relaunchTerminal: (terminalId: string) => Promise<void>
  createTerminal: (worktreeId: string) => Promise<void>
  /** Opens a file pane on `path` beside the focused pane, or focuses the one already on it. */
  openFilePane: (worktreeId: string, path: string) => void
  /** `New markdown`: NOTES.md, or a name asked for in the strip when that is already open. */
  newMarkdown: (worktreeId: string) => void
  /** Answers the strip's question with a name, or null to withdraw it. */
  nameMarkdown: (name: string | null) => void
  setFileUnsaved: (paneId: string, dirty: boolean) => void
  setEditingMarkdown: (editing: boolean) => void
  focusNextPane: () => void
  /** The other way round the same cycle. See `paneCycle`. */
  focusPreviousPane: () => void
  /** Fills the workspace with the focused pane, or gives the tree back. */
  toggleExpandedPane: () => void
  /** Opens the worktree one row along the sidebar, wrapping at both ends. */
  stepWorktree: (step: 1 | -1) => void
  applySplitSizes: (worktreeId: string, path: number[], sizes: number[]) => void
  /** Opens the find bar over the focused pane, or re-takes it if it is already there. */
  openPaneSearch: () => void
  closePaneSearch: () => void

  /** Opens the right panel on the changes tab, or closes it when that is showing. */
  toggleChanges: () => void
  /** Opens the right panel, or closes it, on whichever tab it last showed. */
  toggleRightPanel: () => void
  /** Opens the right panel on one tab. */
  showRightPanelTab: (tab: RightPanelTab) => void
  setRightPanelWidth: (width: number) => void
  /** Shows the patch for one path, or clears the selection when given null. */
  selectChange: (path: string | null) => void
  /** Adds or removes one path from what the next commit will capture. */
  toggleStaged: (path: string) => void
  /** Every changed path, or none. */
  setAllStaged: (staged: boolean) => void
  commitStaged: (message: string) => Promise<void>
  /** Puts one hunk into the index, or takes it out. The hunk is exactly what was on screen; the runtime refuses it if the file moved on. */
  applyHunk: (path: string, hunk: PatchHunk, staged: boolean) => Promise<void>
  /** Sends the active worktree's branch to its remote. Never forces. */
  pushActiveWorktree: () => Promise<void>
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
  /** Turns the automatic check on or off. Remembered between runs. */
  setAutomaticUpdates: (automatic: boolean) => Promise<void>

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
  /**
   * Asks the OS file manager to show a path. The one thing in the renderer that touches the filesystem,
   * so it goes over the preload bridge (see `src/main/reveal`). `what` names the thing for the refusal notice.
   */
  revealInFinder: (path: string, what: string) => Promise<void>
  /** Sets the size of the text in every pane, and remembers it. */
  setTerminalFontSize: (size: number) => void
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
    settings: { linkedPaths?: string[]; copiedPaths?: string[]; setupCommand?: string }
  ) => Promise<void>
  /** Sets one project's editor command, or clears it when given null. */
  setEditorCommand: (projectId: string, command: string | null) => void
  /** Asks the main process which editors are on PATH, once per run. */
  loadEditors: () => Promise<void>
  /** Opens a path in an editor. `command` is the project's own, absent when none; `what` names the thing opened for the refusal. */
  openInEditor: (path: string, command: string | undefined, what: string) => Promise<void>
  /** Puts text on the clipboard, and says so. `what` names it in the notice. */
  copyToClipboard: (text: string, what: string) => Promise<void>
  setSidebarWidth: (width: number) => void
  toggleSidebar: () => void
  /**
   * Applies an appearance and remembers it, with no draft: the window behind the dialog is the preview.
   * The runtime coalesces disk writes, so a colour being dragged is cheap enough to save every frame of.
   */
  setAppearance: (appearance: Appearance) => Promise<void>
  openDialog: (dialog: NonNullable<DialogState>) => void
  closeDialog: () => void
  dismissNotice: (id: number) => void
}

let noticeSeq = 0

const storage = typeof window === 'undefined' ? undefined : window.localStorage

/** What the last window in this installation was showing, read once at startup. */
const lastSession = readStoredSession(storage)
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
  const paneSizeFor = (worktreeId: string): { cols?: number; rows?: number } =>
    newPaneSize(get().terminalFontSize, get().layouts[worktreeId]?.root ?? null) ?? {}

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

  /** The patch for the selected path, re-read whenever the tree moves. */
  const refreshDiff = async (worktreeId: string, path: string): Promise<void> => {
    set({ diffPending: true })
    // Both halves at once: which half a hunk came from decides Stage or Unstage.
    const [diff, staged] = await Promise.all([
      runtimeClient.call('worktree.diff', { worktreeId, path }).catch(() => null),
      runtimeClient.call('worktree.diff', { worktreeId, path, staged: true }).catch(() => null)
    ])
    // A late answer for a path nobody is looking at any more must not replace the current one.
    const current = get()
    if (current.selectedChangePath !== path || current.activeWorktreeId !== worktreeId) return
    set({ diff, stagedDiff: staged && staged.patch !== '' ? staged : null, diffPending: false })
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
    await refreshMergePreviews(readable)

    // The panel rides the same signal as the chips, so an edit in a shell moves both at once.
    const { activeWorktreeId, selectedChangePath } = get()
    if (!changesOnScreen(get()) || !activeWorktreeId || !readable.includes(activeWorktreeId)) return
    await Promise.all([refreshChanges(activeWorktreeId), refreshLog(activeWorktreeId)])
    if (selectedChangePath !== null) await refreshDiff(activeWorktreeId, selectedChangePath)
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
      startedFrom: worktree.startedFrom
    })
    set((state) => ({ worktrees: [...state.worktrees.filter((entry) => entry.id !== worktree.id), created] }))
  }

  /** Drops a worktree from this window once the runtime has really removed it. */
  const forgetWorktree = (worktreeId: string): void => {
    useWorkspaceStore.getState().closeWorktreeTab(worktreeId)
    set((state) => ({ worktrees: state.worktrees.filter((entry) => entry.id !== worktreeId) }))
  }

  const activeLayout = (): Layout | null => {
    const { activeWorktreeId, layouts } = get()
    return activeWorktreeId ? (layouts[activeWorktreeId] ?? null) : null
  }

  /**
   * Moves the focus `step` places around the pane cycle, wrapping. One walk for both directions, so
   * the two chords undo each other; teammates' panes are in the cycle as they are in the tree.
   */
  const stepFocus = (step: 1 | -1): void => {
    const layout = activeLayout()
    const ids = paneCycle(layout?.root ?? null, get().watches)
    if (ids.length === 0) return
    const current = get().focusedWatchId ?? layout?.focusedTerminalId ?? null
    const index = current === null ? -1 : ids.indexOf(current)
    // From nowhere, forwards is the first pane and backwards is the last.
    const from = index === -1 ? (step === 1 ? -1 : 0) : index
    const next = ids[(from + step + ids.length) % ids.length]
    if (next !== undefined) get().focusPane(next)
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
    unsavedFiles: {},
    editingMarkdown: false,
    namingMarkdown: null,
    worktreeFilesEpoch: 0,

    mergePreviews: {},
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
    logs: {},
    selectedChangePath: null,
    stagedPaths: [],
    committing: false,
    pushing: false,
    pushes: {},
    cli: null,
    cliPending: false,
    cliInstall: null,
    cliError: null,
    update: null,
    agents: [],
    agentsProbed: false,
    diff: null,
    stagedDiff: null,
    diffPending: false,
    hunkPending: false,

    // Folded projects are remembered with the sidebar's width. Tabs are restored in `bootstrap`,
    // once the runtime has said which worktrees still exist.
    collapsedProjects: lastSession.collapsedProjects,
    openWorktreeIds: [],
    activeWorktreeId: null,
    dashboardOpen: false,
    teamworkProjectId: null,
    // Neither is restored: both are places you go to answer a question.
    settingsOpen: false,
    settingsSection: null,
    helpOpen: false,

    sidebarWidth: readStoredSidebarWidth(storage) || SIDEBAR_DEFAULT_PX,
    sidebarVisible: lastSession.sidebarVisible,
    paneSearch: null,
    dialog: null,
    notices: [],
    terminalFontSize: readStoredTerminalFontSize(storage),
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
          for (const worktreeId of reopening) await get().openWorktree(worktreeId)
          const wasActive = lastSession.activeWorktreeId
          if (wasActive !== null && live.has(wasActive)) await get().openWorktree(wasActive)

          // Nothing remembered: the first ready worktree beats an empty window.
          if (reopening.length === 0) {
            const first = get().worktrees.find(hasCheckout)
            if (first) await get().openWorktree(first.id)
          }
        }
      } catch (error) {
        failed('Could not reach the runtime')(error)
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
        notify(`Added ${project.name}`, 'info')
      } catch (error) {
        const refusal = (error as { data?: { refusal?: ProjectAddRefusal } } | null)?.data?.refusal
        if (refusal) return refusal
        failed('Could not add the project')(error)
      }
      return null
    },

    /**
     * One action, three steps, none waited on: the composer closes at once and the rows appear creating.
     * Creates are requested in order, because names were handed out in order and the runtime allocates
     * branches on arrival; what follows each create is not. Only the first is opened.
     */
    startTask({ projectId, startedFrom, creates }) {
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
            ...(task ? { task } : {})
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
          set({ dialog: { kind: 'confirm-remove', worktreeId, reason: refusalReason(error), intent: 'retry' } })
          return
        }
        await recreateWorktree(worktree)
      })().catch(failed('Retry failed'))
    },

    /**
     * Removes a worktree, asking first when there is something to lose. Not forced: the runtime's
     * refusal is the only thing between a small cross in a sidebar and somebody's afternoon.
     */
    async removeWorktree(worktreeId) {
      try {
        await runtimeClient.call('worktree.remove', { worktreeId })
        forgetWorktree(worktreeId)
      } catch (error) {
        // A conflict means the runtime found something worth asking about; anything else is a real failure.
        if (isRefusal(error)) {
          set({ dialog: { kind: 'confirm-remove', worktreeId, reason: refusalReason(error), intent: 'remove' } })
          return
        }
        failed('Could not remove the worktree')(error)
      }
    },

    async forceRemoveWorktree(worktreeId) {
      const dialog = get().dialog
      const retrying =
        dialog?.kind === 'confirm-remove' && dialog.worktreeId === worktreeId && dialog.intent === 'retry'
      // Read before the removal: forgetting the row takes the only copy of what the replacement is built from.
      const worktree = get().worktrees.find((entry) => entry.id === worktreeId)
      set({ dialog: null })
      try {
        await runtimeClient.call('worktree.remove', { worktreeId, force: true })
        forgetWorktree(worktreeId)
        if (retrying && worktree) await recreateWorktree(worktree)
      } catch (error) {
        failed(retrying ? 'Retry failed' : 'Could not remove the worktree')(error)
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
              diff: null,
              stagedDiff: null,
              diffPending: false,
              stagedPaths: [],
              expandedTerminalId: null
            }
          : {})
      }))
      if (changesOnScreen(get())) readChangesNow(worktreeId)
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
      if (!layout || layout.focusedTerminalId === paneId) return
      persistLayout({ ...layout, focusedTerminalId: paneId })
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
      const layout = activeLayout()
      const terminalId = layout?.focusedTerminalId
      if (!layout || !terminalId) return
      try {
        const { terminal, layout: next } = await runtimeClient.call('terminal.split', { terminalId, direction })
        set((state) => ({
          terminals: { ...state.terminals, [terminal.id]: terminal },
          layouts: { ...state.layouts, [next.worktreeId]: next }
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
      // Nothing runs behind a file pane, and it flushes its last edit on unmount.
      if (isFilePaneId(terminalId)) {
        await get().forceCloseTerminal(terminalId)
        return
      }
      const warning = closePaneWarning(get().terminals[terminalId])
      if (warning !== null) {
        set({ dialog: { kind: 'confirm-close-pane', terminalId } })
        return
      }
      await get().forceCloseTerminal(terminalId)
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
        const nextFocus = neighbourTerminalId(layout.root, terminalId)
        persistLayout({
          worktreeId: activeWorktreeId,
          root: closePane(layout.root, terminalId),
          focusedTerminalId: layout.focusedTerminalId === terminalId ? nextFocus : layout.focusedTerminalId
        })
        set((state) => {
          const unsavedFiles = { ...state.unsavedFiles }
          delete unsavedFiles[terminalId]
          return { unsavedFiles, ...(state.expandedTerminalId === terminalId ? { expandedTerminalId: null } : {}) }
        })
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
    },

    /** Runs an exited pane again, in place. Nothing is asked first: the pane is dead, and its output stays above the new run. */
    async relaunchTerminal(terminalId) {
      try {
        const terminal = await runtimeClient.call('terminal.relaunch', { terminalId })
        set((state) => ({ terminals: { ...state.terminals, [terminal.id]: terminal } }))
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

    openFilePane(worktreeId, path) {
      const layout = get().layouts[worktreeId] ?? { worktreeId, root: null, focusedTerminalId: null }
      const open = fileLeavesIn(layout.root).find((leaf) => leaf.path === path)
      if (open) {
        get().focusPane(open.terminalId)
        return
      }
      const added = fileLeaf(newFilePaneId(), path)
      const focused = layout.focusedTerminalId
      const root =
        focused !== null && collectTerminalIds(layout.root).includes(focused)
          ? splitPaneWith(layout.root, focused, 'row', added)
          : appendPane(layout.root, added)
      set({ namingMarkdown: null })
      persistLayout({ worktreeId, root, focusedTerminalId: added.terminalId })
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
      set((state) => {
        if (Boolean(state.unsavedFiles[paneId]) === dirty) return {}
        const unsavedFiles = { ...state.unsavedFiles }
        if (dirty) unsavedFiles[paneId] = true
        else delete unsavedFiles[paneId]
        return { unsavedFiles }
      })
    },

    setEditingMarkdown(editing) {
      if (get().editingMarkdown !== editing) set({ editingMarkdown: editing })
    },

    async createTerminal(worktreeId) {
      try {
        const terminal = await runtimeClient.call('terminal.create', { worktreeId, ...paneSizeFor(worktreeId) })
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

    /**
     * Maximises the focused pane, or restores the tree: the key that put the window in this state takes
     * it out again, or the state is a trap. Nothing is saved, see `expandedTerminalId`. Not for a
     * teammate's pane, which is not in this tree.
     */
    toggleExpandedPane() {
      if (get().expandedTerminalId !== null) {
        set({ expandedTerminalId: null })
        return
      }
      if (get().focusedWatchId !== null) return
      const focused = activeLayout()?.focusedTerminalId
      if (focused) set({ expandedTerminalId: focused })
    },

    stepWorktree(step) {
      const { projects, worktrees, activeWorktreeId } = get()
      // The sidebar's order, not the store's: these chords move the highlight the sidebar draws.
      const next = worktreeAfter(worktreeOrder(projects, worktrees), activeWorktreeId, step)
      if (next && next.id !== activeWorktreeId) void get().openWorktree(next.id)
    },

    openPaneSearch() {
      // A watched pane's scrollback is a scaled picture with no search addon; the field opens only over your own.
      // A file pane has no scrollback.
      if (get().focusedWatchId !== null) return
      const focused = activeLayout()?.focusedTerminalId
      if (!focused || isFilePaneId(focused)) return
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

    toggleChanges() {
      const { rightPanelOpen, rightPanelTab } = get()
      if (rightPanelOpen && rightPanelTab === 'changes') get().toggleRightPanel()
      else get().showRightPanelTab('changes')
    },

    toggleRightPanel() {
      const opening = !get().rightPanelOpen
      set({ rightPanelOpen: opening })
      writeStoredRightPanel(storage, { open: opening, tab: get().rightPanelTab })
      if (!opening) return
      // Read on the way open: until the panel is shown, nothing depends on it.
      const worktreeId = get().activeWorktreeId
      if (worktreeId && changesOnScreen(get())) readChangesNow(worktreeId)
    },

    showRightPanelTab(tab) {
      const wasShowing = changesOnScreen(get())
      set({ rightPanelOpen: true, rightPanelTab: tab })
      writeStoredRightPanel(storage, { open: true, tab })
      const worktreeId = get().activeWorktreeId
      // A tab that draws changes reads them on arrival, unless the replaced tab was already drawing them.
      if (worktreeId && changesOnScreen(get()) && !wasShowing) readChangesNow(worktreeId)
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
      const paths = get().stagedPaths
      if (!worktreeId || paths.length === 0) return

      set({ committing: true })
      try {
        const result = await runtimeClient.call('worktree.commit', { worktreeId, message, paths })
        // The commit can capture more than was ticked (anything staged earlier in a terminal); saying
        // so is the difference between a notice and a surprise.
        const extra = result.paths.filter((path) => !paths.includes(path))
        notify(
          extra.length === 0
            ? `Committed ${result.shortSha}: ${result.message}`
            : `Committed ${result.shortSha}: ${result.message} — including ${extra.length} path${
                extra.length === 1 ? '' : 's'
              } already staged`,
          'info'
        )
        // Nothing is left ticked; the list refetches on the invalidation the runtime publishes, and
        // doing it here too would be a second way for this window to disagree with the others.
        set({ stagedPaths: [], selectedChangePath: null, diff: null, stagedDiff: null })
      } catch (error) {
        failed('Could not commit')(error)
      } finally {
        set({ committing: false })
      }
    },

    async applyHunk(path, hunk, staged) {
      const worktreeId = get().activeWorktreeId
      if (!worktreeId || get().hunkPending) return

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

    async startAgent(command) {
      const worktreeId = get().activeWorktreeId
      if (!worktreeId) return
      try {
        // Straight through terminal.create: the runtime pins the session id, so a pane started here resumes like any other.
        const agentArgs = extraArgsFor(command)
        const terminal = await runtimeClient.call('terminal.create', {
          worktreeId,
          command,
          ...paneSizeFor(worktreeId),
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
        notify(`teamree ${update.current} is the latest release.`, 'info')
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
        notify(`Wrote ${setting.file}. Commit and push it so your team meets there.`, 'info')
      } catch (error) {
        // Kept in the dialog: a refusal names the URL to type instead, useful only beside the field.
        set({ relayError: error instanceof Error ? error.message : String(error) })
      } finally {
        set({ relayPending: false })
      }
    },

    async joinProject(projectId, handle) {
      set({ membersPending: true, membersError: null })
      try {
        const list = await runtimeClient.call('members.join', handle ? { projectId, handle } : { projectId })
        set((state) => ({ members: { ...state.members, [projectId]: list } }))
        // As a notice too: the file is the smaller half, and nobody else sees it until it is pushed.
        if (list.selfFile) notify(`Wrote ${list.selfFile}. Commit and push it to join.`, 'info')
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
        notify(
          result.replaced
            ? `origin now points at ${result.url}.`
            : `Added origin ${result.url}. Your teammates’ checkouts have to name the same repository.`,
          'info'
        )
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
              ? `${result.remote} already had ${result.branch}.`
              : `Pushed ${result.branch} to ${result.remote}. Your team can reach this machine now.`
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
        // Three things worth saying, none of them "done": what was sent, whether this set the upstream, what stayed behind.
        const parts = [
          result.alreadyUpToDate
            ? `${result.remote} already had ${result.branch}`
            : `Pushed ${result.branch} to ${result.remote}`
        ]
        if (result.setUpstream) parts.push(`now tracking ${result.upstream}`)
        if (result.uncommitted > 0) {
          parts.push(`${result.uncommitted} uncommitted change${result.uncommitted === 1 ? '' : 's'} stayed behind`)
        }
        // The push result carries the review page, derived from the remote's URL and absent for a host teamree cannot name.
        notify(
          `${parts.join(' · ')}.`,
          'info',
          result.reviewUrl === undefined ? undefined : { label: 'Open review', url: result.reviewUrl }
        )
        setPush({ phase: 'pushed', ...(result.reviewUrl === undefined ? {} : { reviewUrl: result.reviewUrl }) })
        // The remote has every commit now; the next status read confirms it, and the tab should not offer Push until then.
        set((state) => {
          const status = state.statuses[worktreeId]
          if (!status) return {}
          return { statuses: { ...state.statuses, [worktreeId]: { ...status, ahead: 0, upstream: result.upstream } } }
        })
      } catch (error) {
        setPush({ phase: 'failed', error: error instanceof Error ? error.message : String(error) })
        failed('Could not push')(error)
      } finally {
        set({ pushing: false })
      }
    },

    selectChange(path) {
      const worktreeId = get().activeWorktreeId
      set({ selectedChangePath: path, diff: null, stagedDiff: null, diffPending: path !== null })
      if (path === null || !worktreeId) return
      void refreshDiff(worktreeId, path).catch((error: unknown) => {
        set({ diffPending: false })
        failed('Could not read the patch')(error)
      })
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
        helpOpen: false,
        dashboardOpen: false,
        teamworkProjectId: null
      }))
    },

    openSettings(section) {
      set({
        settingsOpen: true,
        settingsSection: section,
        helpOpen: false,
        dashboardOpen: false,
        teamworkProjectId: null
      })
    },

    toggleHelp() {
      set((state) => ({
        helpOpen: !state.helpOpen,
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
        notify(`teamree cannot open ${what} in a file manager from this window.`, 'info')
        return
      }
      try {
        const result = await reveal(path)
        if (!result.revealed) notify(`Could not show ${what}: ${result.reason}`, 'info')
      } catch (error) {
        failed(`Could not show ${what}`)(error)
      }
    },

    setTerminalFontSize(size) {
      const clamped = clampTerminalFontSize(size)
      set({ terminalFontSize: clamped })
      writeStoredTerminalFontSize(storage, clamped)
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
        failed('Could not save what new worktrees carry over')(error)
      }
    },

    setEditorCommand(projectId, command) {
      const editorCommands = withEditorCommand(get().editorCommands, projectId, command)
      set({ editorCommands })
      writeStoredEditorCommands(storage, editorCommands)
    },

    async loadEditors() {
      // Once per run: a probe on every right-click would be a PATH walk per menu.
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
        notify(`teamree cannot reach the clipboard from this window, so ${what} was not copied.`, 'info')
        return
      }
      try {
        await clipboard.writeText(text)
        notify(`Copied ${what}.`, 'info')
      } catch (error) {
        failed(`Could not copy ${what}`)(error)
      }
    },

    toggleSidebar() {
      set((state) => ({ sidebarVisible: !state.sidebarVisible }))
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

    openTeamwork(projectId) {
      set({ teamworkProjectId: projectId, dashboardOpen: false, settingsOpen: false, helpOpen: false })
    },

    closeTeamwork() {
      set({ teamworkProjectId: null })
    },

    openDialog(dialog) {
      set({ dialog })
    },

    closeDialog() {
      set({ dialog: null })
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
  writeStoredSession(storage, state)
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

function refusalReason(error: unknown): string {
  return error instanceof Error ? error.message : 'this worktree has work in it that is not committed anywhere'
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
