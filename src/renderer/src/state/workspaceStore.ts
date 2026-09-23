// One store for everything the window shows. The runtime is the source of
// truth; this keeps a read model of it plus the purely local bits (which tabs
// are open, which pane has focus, how wide the sidebar is).

import { create } from 'zustand'
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
import { closePaneWarning } from '../dialogs/closePaneModel'
import { closePane, collectTerminalIds, neighbourTerminalId, setSizesAt } from '../panes/paneLayout'
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
import {
  clampSidebarWidth,
  readStoredSidebarWidth,
  writeStoredSidebarWidth,
  SIDEBAR_DEFAULT_PX
} from '../shell/sidebarWidth'
import {
  clampTerminalFontSize,
  readStoredAgentNotices,
  readStoredStartPoints,
  readStoredTerminalFontSize,
  withStartPoint,
  writeStoredAgentNotices,
  writeStoredStartPoints,
  writeStoredTerminalFontSize,
  type AgentNoticePreference
} from './preferences'
import { createLocalEditFence, createWorkspaceRefresher, refreshTargets, type RefreshTargets } from './workspaceRefresh'
import { readStoredSession, sessionChanged, writeStoredSession } from './storedSession'

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

/**
 * Why the removal was asked for. A retry removes the old checkout only to
 * build a new one in its place, and the confirmation has to say so — otherwise
 * "Discard the work" is followed by a worktree reappearing.
 */
export type RemoveIntent = 'remove' | 'retry'

/** What the task composer submits: a description, who runs it, and from where. */
export type TaskDraft = {
  projectId: string
  /** The task as written. Names the worktree and seeds its branch. */
  task: string
  startedFrom?: string
  /** Command for the agent's pane. Absent means the worktree alone. */
  agentCommand?: string
}

export type Notice = { id: number; text: string; tone: 'error' | 'info' }

/**
 * The find bar belongs to one pane at a time — the focused one — so a second
 * pane claiming it puts the first one's bar away. `token` changes on every
 * press of the chord, which is how a repeat press re-takes a field that is
 * already open.
 */
export type PaneSearch = { terminalId: string; token: number }

/**
 * Which of the teamwork panel's three reads last failed, and what each said.
 * Keyed the way the panel's own input is, so it can be handed over as it is.
 */
export type TeamworkReadErrors = { list?: string; relay?: string; status?: string }

/**
 * A relay command running in a pane in this window.
 *
 * Deploying a relay, running one here, and checking one are three verbs on the
 * one launcher, and they share the one pane — so what is kept is which verb it
 * is as well as which terminal. It was called a deploy while there was only a
 * deploy; naming it that once it holds three things would be a lie told to
 * every reader of this file.
 *
 * The pane is an ordinary terminal owned by the runtime, created under an id of
 * its own so it belongs to the project rather than to whichever worktree
 * happened to be open — `.teamree` is in the primary checkout, and a worktree's
 * pane is in the wrong directory for this. Nothing is stored across a launch,
 * which used to be justified as "a finished deploy is not a pane anybody wants
 * back" — true of a deploy, and false of the relay this window grew the ability
 * to run. A relay is a process that is meant to still be there tomorrow, so
 * within a run the slot is rebuilt from the runtime's own list rather than
 * trusted to survive: see `reconcileRelayPanes`.
 *
 * The shape itself is the panel's, imported rather than restated: it is what
 * the panel renders, and two copies of it would be two things to keep in step.
 */
export type { RelayPaneKind, RelayPaneState } from '../teamwork/startTeamwork'

/**
 * The worktree id a project's teamwork pane is created under.
 *
 * Namespaced so it can never collide with a real worktree's, and deliberately
 * not a real one: this pane is about the project's primary checkout, which no
 * worktree row owns. The runtime drops a stored pane whose worktree it cannot
 * resolve, so nothing is left behind by it on the next launch.
 *
 * The verb is in the id because it is the only place it can be. A `Terminal`
 * carries its id, its worktree, its directory and a title scraped from the
 * program name — not the command, and `src/shared` is a frozen contract, so
 * nothing in a terminal record says whether the pane is deploying, serving or
 * checking. A window that has been reloaded has to be able to find a relay it
 * left running and say truthfully what it is, and this is what lets it.
 */
export function teamworkPaneWorktreeId(projectId: string, kind: RelayPaneKind): string {
  return `teamwork:${kind}:${projectId}`
}

/** The project and verb an id made by `teamworkPaneWorktreeId` was made from, or null. */
export function teamworkPaneFromWorktreeId(worktreeId: string): { projectId: string; kind: RelayPaneKind } | null {
  const [namespace, kind, ...rest] = worktreeId.split(':')
  // A project id can hold a colon, so the rest is rejoined rather than taken as
  // one segment. The verb cannot: it is one of three literals this file writes.
  const projectId = rest.join(':')
  if (namespace !== 'teamwork' || projectId === '') return null
  if (kind !== 'deploy' && kind !== 'serve' && kind !== 'check') return null
  return { projectId, kind }
}

/**
 * The relay panes this window should be showing, given what the runtime says is
 * actually running.
 *
 * Two failures, one reconciliation. A renderer reload empties this map while
 * the relay it was showing goes on running in the main process: the slot is
 * gone, the buttons come back enabled, the pane is in no pane tree so there is
 * no way left to stop it, and the next `serve` dies on `EADDRINUSE` against a
 * process nothing on screen admits to. And the other way round, a terminal that
 * leaves the runtime's list — closed from somewhere else, gone with its
 * process — leaves a slot on screen whose only control reads "Close this pane"
 * for a pane that is not there.
 *
 * So the runtime's list is the truth here as it is everywhere else: a slot
 * whose terminal is gone is dropped, a teamwork terminal with no slot is
 * adopted into one, and a slot whose terminal is still listed keeps everything
 * it has learned — the URL it scraped above all, which is not in the list and
 * would be thrown away by rebuilding it. An adopted pane starts with no URL and
 * gets one from the next poll, a second and a half later.
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
        ? // `running` comes off the record rather than being kept: it is the one
          // fact in the slot the runtime is the authority on.
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

type WorkspaceState = {
  connection: ConnectionState
  runtimeVersion: string | null

  projects: Project[]
  worktrees: Worktree[]
  statuses: Record<string, WorktreeStatus>
  /**
   * When git reads for a worktree started failing, by worktree id, for the ones
   * where they still are. A failed read leaves the last good numbers on screen
   * — they are the best anyone has — and this is what stops the row presenting
   * them as current, including the merge badge beside them: the status read is
   * the cheap one every refresh attempts, so it is the honest proxy for whether
   * this checkout can be read at all.
   */
  unreadableSince: Record<string, number>
  terminals: Record<string, Terminal>
  layouts: Record<string, Layout>
  /**
   * The pane that is filling the workspace on its own, or null.
   *
   * Beside the layouts rather than inside one, and that is the whole decision.
   * A `Layout` is the runtime's record of how a worktree's panes are arranged,
   * saved and restored across launches; maximising is not an arrangement, it is
   * a way of looking at one for as long as you are looking. Putting it in the
   * record would send it over `layout.set`, write it to the workspace file, and
   * bring somebody back tomorrow to a window with one pane in it and no memory
   * of having asked for that. So it lives here, in this window, and dies with
   * it.
   *
   * `shownRoot` is what reads it, and it takes the whole tree back the moment
   * the id is not in it — a maximised pane that has since been closed leaves a
   * stale id rather than an empty workspace.
   */
  expandedTerminalId: string | null

  /** Open state of the changes panel, and what it is showing. */
  /** Whether each ready worktree would merge into its base, as last read. */
  mergePreviews: Record<string, WorktreeMergePreview>

  changesOpen: boolean
  changes: Record<string, WorktreeChanges>
  /** What each worktree has committed that its base has not. */
  logs: Record<string, WorktreeLog>
  selectedChangePath: string | null
  /**
   * Paths ticked in the panel for the next commit. Held here rather than in
   * git's index: ticking a box is the user browsing, and browsing should not
   * stage anything until they say so.
   */
  stagedPaths: string[]
  committing: boolean
  pushing: boolean
  /**
   * Each project's roster, by project id, for the ones somebody has looked at.
   * Read on demand rather than at bootstrap: a roster is a directory read per
   * project, and most windows never open one.
   */
  members: Record<string, MemberList>
  /** True while a roster is being read or written, so the dialog can say so. */
  membersPending: boolean
  /**
   * Why the last attempt to add this machine's key was refused, or null.
   *
   * Kept here rather than raised as a notice, for the reason `relayError` is:
   * every one of these refusals is an instruction about the handle box — "that
   * name is already somebody else's key; choose another" — and an instruction
   * about a field is only useful beside the field. It was worse than that
   * before the notice layer was raised above the modal scrim, because the
   * sentence was painted underneath the dialog and the user saw nothing at all.
   */
  membersError: string | null
  /**
   * Each project's relay, for the ones somebody has looked at. Read beside the
   * roster because the two are the same fact about a team: who is on it, and
   * where they meet.
   */
  relays: Record<string, RelaySetting>
  relayPending: boolean
  /**
   * Why the last relay this window tried to write was refused, or null.
   *
   * Kept here rather than raised as a notice because the refusal carries the
   * remedy — the corrected URL to type — and that belongs beside the field it
   * is about, not in a corner of the window.
   */
  relayError: string | null
  /** True while `origin` is being written, so the button can say so. */
  originPending: boolean
  /**
   * Why the last attempt to set `origin` was refused, or null.
   *
   * git's own words when git refused, and kept beside the field for the reason
   * every other refusal here is: it is an instruction about what is in the box.
   */
  originError: string | null
  /**
   * The relay command running in a pane in this window, by project id.
   *
   * One per project, still: a second deploy of the same relay is never what
   * somebody meant, and the panel disables the other buttons while one is open
   * rather than replacing it out from under whoever is reading it. The pane is
   * a real terminal owned by the runtime; what is kept here is which one it is,
   * which verb it is running, whether it is still running, and the URL it
   * printed once it has printed one.
   */
  relayPanes: Record<string, RelayPaneState>
  /**
   * What committing and pushing the two files would do, by project id.
   *
   * Read before the button is pressed rather than after, because the button is
   * outward-facing and has to say what it will do — and read from the runtime
   * rather than assembled here, because the branch and the upstream are git's
   * answers.
   */
  publishPlans: Record<string, TeamworkPublishPlan>
  publishPending: boolean
  /** Why the last attempt could not be made at all, or null. */
  publishError: string | null
  /** What the last attempt did, by project id — including a push that failed. */
  publishResults: Record<string, TeamworkPublish>
  /**
   * What the publish that is running is doing, by project id.
   *
   * The reason this exists at all: `teamwork.publish` does not answer until the
   * push is over, so between the button and the result there was nothing in the
   * store for the panel to show, and it showed "Pushing…" for as long as it
   * took. This is read on a timer while one is running — the same shape as the
   * relay deploy's pane, which is polled for the same reason.
   */
  publishProgress: Record<string, TeamworkPublishProgress>
  /**
   * Whether teamwork is running for each project, by project id.
   *
   * Absent means "not asked yet", which is deliberately not the same as "off":
   * an empty entry would have the header claim a project has no relay before
   * anything had looked.
   */
  teamwork: Record<string, TeamworkStatus>
  /**
   * Why the last read behind the teamwork panel failed, by project id, for the
   * ones that did.
   *
   * A read that threw and a read still in flight both leave the answer out of
   * the maps above, and the panel has to tell them apart: without this it said
   * "Reading…" for the life of the window, with the whole of the explanation in
   * a notice that had already gone.
   */
  teamworkReadErrors: Record<string, TeamworkReadErrors>
  /** What each project's teammates are showing, by project id. */
  teammates: Record<string, TeammatePresence>
  /**
   * Who is reading this machine's panes, by project id.
   *
   * Read on the same invalidation the rest of teamwork is, because it changes
   * for the same reason: somebody's link moved, or somebody opened a pane.
   */
  watchers: Record<string, PaneWatchers>
  /**
   * Whose keystrokes are waiting on this machine's owner, by project id, and
   * which teammates they have already settled.
   *
   * Read on the same invalidation the rest of teamwork is, because a question
   * appearing is exactly the kind of change that event is for — and because a
   * prompt the window learned about by polling would be a prompt that appeared
   * a second after the keystroke that raised it.
   */
  consent: Record<string, PaneConsent>
  /**
   * Teammates' panes open here, in the order they were opened — which is the
   * order they are drawn in, left to right, beside your own.
   *
   * Several at once, which the floating viewer could not do and this can. The
   * reason it used to be one was the relay's budget: `docs/teamwork.md` is
   * explicit that output flows only for a pane somebody has open, and a viewer
   * that was opened once and never shut is how that becomes the N² traffic the
   * rule exists to prevent. That argument was about a pane nobody could see
   * they still had open. A pane in the workspace is one you are looking at, it
   * carries the same close button as every other pane, and closing it is what
   * closes the subscription — so the cost is visible and the remedy is where a
   * remedy belongs.
   */
  watches: WatchedPane[]
  /**
   * The fractions of the width given to the workspace and to each watched pane
   * beside it, as the gutters between them were last dragged.
   *
   * Not persisted: it is an arrangement of panes that only exist while they are
   * being watched, and a window that came back with a column reserved for a
   * teammate's pane it had not reopened would be remembering the wrong half.
   */
  watchSizes: number[]
  /**
   * Whatever each watched pane has printed since it was opened, by pane id.
   *
   * Only an open pane has a line to quote in the sidebar, because only an open
   * pane is streaming; the tail is trimmed to the last few thousand characters
   * because a quote needs the end of it and nothing else.
   */
  watchTails: Record<string, string>
  /**
   * The watched pane with the focus, or null when one of your own has it.
   *
   * Held here rather than in a `Layout` because the layouts are the runtime's,
   * and the runtime has never heard of this pane: it is a window onto a pty on
   * another machine, and writing it into a tree the runtime reconciles against
   * its own sessions would have it pruned at the next launch.
   */
  focusedWatchId: string | null
  /**
   * Where this app's CLI is and what is at the path it would be linked to.
   *
   * Probed once at startup beside the agents, and for the same reason: it is
   * cheap, it decides which buttons are worth offering, and null means "not
   * asked yet" rather than "nothing there".
   */
  cli: CliStatus | null
  cliPending: boolean
  /** What the last install did, kept so the panel can say it afterwards. */
  cliInstall: CliInstall | null
  /**
   * Why the last attempt was refused, or null.
   *
   * Kept in the dialog rather than raised as a notice, like the relay's: the
   * refusals here are "there is a file in the way" and "no password was given",
   * and both belong next to the button that will be pressed again.
   */
  cliError: string | null
  /**
   * Whether a newer teamree exists, and whether this one is looking.
   *
   * Read at startup like the CLI's status, and re-read whenever the runtime
   * says the check has something new to say — which it does for checks this
   * window did not start: the one half a minute after launch, and the one
   * behind the macOS app menu. Null means nobody has asked yet.
   */
  update: UpdateState | null
  /** Coding agents this machine can run, probed once at startup. */
  agents: InstalledAgent[]
  /** True once the probe has answered, however it answered. Until then an
   * empty `agents` means "not asked yet", not "none installed". */
  agentsProbed: boolean
  diff: WorktreeDiff | null
  diffPending: boolean

  collapsedProjects: Record<string, boolean>
  openWorktreeIds: string[]
  activeWorktreeId: string | null
  /**
   * Whether the pane dashboard has the main area. It replaces the panes rather
   * than sharing the window with them: it is read to decide where to go next,
   * and every way out of it is a way of going somewhere.
   */
  dashboardOpen: boolean
  /**
   * Which project's teamwork setup has the main area, or null.
   *
   * Setting teamwork up used to be a modal, and a modal is the wrong shape for
   * it: it is a multi-step task with commands to copy and files to commit, read
   * against a repository rather than answered in a sentence. It takes the whole
   * main area now, the way the pane board does, and for the same reason — it is
   * about a project rather than about the worktree that happens to be open, so
   * binding it to that tab would be the wrong frame.
   */
  teamworkProjectId: string | null
  /**
   * Whether settings has the main area, and whether help does.
   *
   * Two booleans beside the two surfaces above, on the same terms and for the
   * same reason: both are about the app rather than about the worktree that
   * happens to be open, so neither belongs in a tab, and both are read rather
   * than worked in — every way out of them is a way of going back to the panes.
   *
   * A dialog was the obvious alternative and is the wrong shape for either.
   * Settings holds a panel that asks macOS for an administrator password, a
   * per-project field, and a list of what this window is connected to; help is
   * something people read with one hand while doing the thing it describes.
   * Neither survives being squeezed into a box that has to be dismissed before
   * the app can be touched again. Appearance stays a dialog because it is one
   * choice made and seen instantly against the window behind it, and settings
   * carries a row that opens it rather than a second copy of it.
   */
  settingsOpen: boolean
  helpOpen: boolean

  sidebarWidth: number
  sidebarVisible: boolean
  paneSearch: PaneSearch | null
  dialog: DialogState
  notices: Notice[]
  /**
   * How big the text in a pane is, in CSS pixels, and each project's preferred
   * start point by project id.
   *
   * Local to this machine and read from `localStorage` at startup rather than
   * from the runtime — see `preferences.ts` for why neither is in the workspace
   * file. Held in the store anyway because a preference nothing re-renders on
   * is a preference that only applies to panes opened after it was changed.
   */
  terminalFontSize: number
  startPointDefaults: Record<string, string>
  /**
   * Whether an agent stopping while you are elsewhere may say so, and whether
   * it may make a sound.
   *
   * Held here rather than read straight out of storage where it is used,
   * because the reader is the main process: `useAgentNotices` publishes it over
   * the preload bridge whenever it changes, and a preference nothing
   * re-renders on would only reach the other process on the next launch.
   */
  agentNotices: AgentNoticePreference

  /**
   * How this window is painted, as the runtime last told it.
   *
   * Held here rather than in the appearance dialog's own state because the
   * dialog is not the only reader: `App` writes the resolved palette onto the
   * root element from it, and every open terminal re-reads its emulator theme
   * when it changes. A colour edited in the dialog is therefore live in the
   * panes behind the dialog, which is the whole point of editing one.
   */
  appearance: Appearance

  bootstrap: () => Promise<void>
  /** Opens the change stream. Returns the stop function an effect cleans up with. */
  startWatching: () => () => void

  addProject: (path: string, name?: string) => Promise<void>
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
  /** Adopts a fresh terminal record, e.g. the one a resize answers with. */
  recordTerminal: (terminal: Terminal) => void
  splitFocusedPane: (direction: 'row' | 'column') => Promise<void>
  /**
   * Closes a pane, asking first when the close would kill work.
   *
   * Every way of closing a pane comes through here — the pane bar's ×, the
   * close-pane chord, and the × on each tab of the strip above the panes — so
   * the question is asked here rather than by each button. A guard on the
   * buttons is a guard somebody adds a fourth button beside.
   */
  closeTerminal: (terminalId: string) => Promise<void>
  /** Goes through with it, once the question this app asked has been answered. */
  forceCloseTerminal: (terminalId: string) => Promise<void>
  /** Runs an exited pane's program again, in the same pane. */
  relaunchTerminal: (terminalId: string) => Promise<void>
  createTerminal: (worktreeId: string) => Promise<void>
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

  toggleChanges: () => void
  /** Shows the patch for one path, or clears the selection when given null. */
  selectChange: (path: string | null) => void
  /** Adds or removes one path from what the next commit will capture. */
  toggleStaged: (path: string) => void
  /** Every changed path, or none. */
  setAllStaged: (staged: boolean) => void
  commitStaged: (message: string) => Promise<void>
  /** Sends the active worktree's branch to its remote. Never forces. */
  pushActiveWorktree: () => Promise<void>
  /** Opens a pane already running one of the agents found on this machine. */
  startAgent: (command: string) => Promise<void>

  /** Reads where the CLI is and what is at its destination. */
  loadCli: () => Promise<void>
  /**
   * Links the CLI into /usr/local/bin, asking for an administrator password
   * only if that directory cannot be written without one.
   */
  installCli: () => Promise<void>
  /**
   * Records that this installation has been asked, so the offer teamree makes
   * by itself on first run is made once. Both buttons on that card come here:
   * declining is an answer, and accepting is an answer that also opens the
   * panel.
   */
  dismissCliPrompt: () => Promise<void>

  /** Re-reads what the runtime knows about newer releases. Asks nobody. */
  loadUpdate: () => Promise<void>
  /**
   * Asks GitHub now, because somebody chose to.
   *
   * Raises a notice when there is nothing to report, and only then: a check
   * somebody asked for has to answer even when the answer is "you are current",
   * while the one the app makes by itself has to be silent unless it found
   * something. A failed check says so too, because this one was asked for.
   */
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
  /**
   * Re-reads whether teamwork is running for one project.
   *
   * The setup panel shows the links themselves, so it asks on open rather than
   * waiting for the next change event: a panel whose last step is "connected"
   * and whose answer is a minute old is a panel people press Close and reopen.
   */
  loadTeamwork: (projectId: string) => Promise<void>
  /**
   * Writes the relay into the repository. Like joining, it writes the file and
   * stops: pushing it is what makes it the team's.
   */
  setRelay: (projectId: string, url: string) => Promise<void>
  /**
   * Points this checkout's `origin` at a URL, and re-reads the status so the
   * step that was blocked goes green without a restart.
   */
  setOrigin: (projectId: string, url: string) => Promise<void>
  /**
   * Runs one of the shipped relay launcher's verbs in a pane in this window.
   *
   * `argument` is the URL a check dials and is meaningless to the other two.
   * Nothing is started while a pane is already open: the panel disables the
   * buttons for that, and this refuses for the same reason a second time.
   */
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
  /**
   * Writes this installation's key into the project. It does not commit and
   * does not push, and the dialog says so: doing either for somebody would hide
   * the only step that makes the key mean anything.
   */
  joinProject: (projectId: string, handle?: string) => Promise<void>
  /**
   * Stops, or restarts, teammates' keystrokes reaching one of this machine's
   * panes.
   *
   * The answer is applied here rather than waited for from the change stream,
   * because a mute is the one control in this app whose whole value is that it
   * is instant: a button that took a round trip and a refetch to look pressed
   * would be pressed twice.
   */
  mutePane: (terminalId: string, muted: boolean) => Promise<void>
  /**
   * Answers one held burst: run it once, let this teammate type here for the
   * session or for good, or refuse it.
   *
   * `through` is how many keystrokes the window actually drew, and it is passed
   * rather than left out because a burst grows while the prompt is up: the
   * owner is answering the screen in front of them, and whatever arrived after
   * it has to be asked about rather than carried in on the same click.
   *
   * The answer is applied here rather than waited for from the change stream,
   * for the reason the mute is: a prompt that stayed on screen for a round trip
   * after it was answered would be answered twice.
   */
  decideConsent: (requestId: string, decision: ConsentDecision, through: number) => Promise<void>
  /** Takes back a standing permission. Instant and local, exactly like a mute. */
  revokeConsent: (terminalId: string, publicKey: string) => Promise<void>
  /**
   * Opens a teammate's pane as a pane in this window, or closes the one that is
   * already open on it.
   *
   * The second press being a close is what keeps stopping reachable from the
   * row that started it, for somebody whose eye is on the sidebar rather than
   * on the pane.
   */
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
  /** The same for help. */
  toggleHelp: () => void
  /**
   * Asks the OS file manager to show a path, and says so when it cannot.
   *
   * Not `revealPane`, which is next door and is about this window: that one
   * opens a worktree's tab and puts the focus on a pane inside the app. This
   * one leaves the app entirely and is the only thing in the renderer that
   * touches the filesystem, which is why it goes over the preload bridge to the
   * main process rather than through the runtime — see `src/main/reveal`.
   *
   * `what` names the thing being shown, so the notice raised by a refusal can
   * say which button was pressed rather than only which path was missing.
   */
  revealInFinder: (path: string, what: string) => Promise<void>
  /** Sets the size of the text in every pane, and remembers it. */
  setTerminalFontSize: (size: number) => void
  /** Sets what an agent going quiet may do, and remembers it. */
  setAgentNotices: (preference: AgentNoticePreference) => void
  /** Sets one project's preferred start point, or clears it when given null. */
  setStartPointDefault: (projectId: string, ref: string | null) => void
  /**
   * Sets what one project's new worktrees carry over from its primary
   * checkout. Each list given replaces the stored one; an omitted list is left
   * alone.
   *
   * Unlike the start point above, this is not a preference of this window: a
   * worktree created from the CLI has to be prepared the same way, so it lives
   * in the workspace beside the project's base ref rather than in local
   * storage.
   */
  setProjectPaths: (projectId: string, paths: { linkedPaths?: string[]; copiedPaths?: string[] }) => Promise<void>
  setSidebarWidth: (width: number) => void
  toggleSidebar: () => void
  /**
   * Applies an appearance and remembers it.
   *
   * Applied and stored in one step, with no draft and no confirm button:
   * colours are judged by looking at them, so the window behind the dialog is
   * the preview, and a change somebody liked enough to leave on screen is a
   * change they have already decided. The write costs one in-process call and
   * the runtime coalesces its disk writes, so a colour being dragged is cheap
   * enough to save every frame of.
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

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => {
  const notify = (text: string, tone: Notice['tone'] = 'error'): void => {
    const notice: Notice = { id: ++noticeSeq, text, tone }
    set((state) => ({ notices: [...state.notices.slice(-2), notice] }))
  }

  const failed = (what: string) => (error: unknown) => {
    notify(`${what}: ${error instanceof Error ? error.message : String(error)}`)
  }

  /**
   * A read the teamwork panel depends on threw. Kept beside the notice rather
   * than instead of it: the notice is for whoever is not looking at the panel,
   * and the panel is where the step that cannot be answered is.
   */
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

  // Layouts are the one thing the user edits directly (dragging a gutter, moving
  // focus), so a layout read that was already in flight must not land on top of
  // an edit made while it travelled.
  const layoutEdits = createLocalEditFence()

  const refreshProjects = async (): Promise<void> => {
    set({ projects: await runtimeClient.call('project.list', {}) })
  }

  /** Returns the worktrees whose git status is worth re-reading. */
  const refreshWorktrees = async (): Promise<string[]> => {
    const worktrees = await runtimeClient.call('worktree.list', {})
    const live = new Set(worktrees.map((worktree) => worktree.id))

    // A worktree removed from anywhere — this window, another window, the CLI —
    // takes its tab, its panes and its status chips with it.
    set((state) => {
      const openWorktreeIds = state.openWorktreeIds.filter((id) => live.has(id))
      return {
        worktrees,
        openWorktreeIds,
        activeWorktreeId:
          state.activeWorktreeId && live.has(state.activeWorktreeId)
            ? state.activeWorktreeId
            : (openWorktreeIds[openWorktreeIds.length - 1] ?? null),
        layouts: keptFor(state.layouts, live),
        statuses: keptFor(state.statuses, live),
        unreadableSince: keptFor(state.unreadableSince, live),
        mergePreviews: keptFor(state.mergePreviews, live),
        logs: keptFor(state.logs, live)
      }
    })

    // A worktree that only just became ready has panes now but no layout here.
    const missing = get().openWorktreeIds.filter((id) => !(id in get().layouts))
    if (missing.length > 0) refresher.request(refreshTargets({ layouts: missing }))

    return worktrees.filter((worktree) => worktree.state === 'ready').map((worktree) => worktree.id)
  }

  const refreshTerminals = async (): Promise<void> => {
    const listed = await runtimeClient.call('terminal.list', {})
    // Replaced wholesale rather than merged: the runtime's list is the whole
    // truth, and a terminal closed elsewhere has to leave this map.
    const terminals = Object.fromEntries(listed.map((terminal) => [terminal.id, terminal]))
    // And the relay pane is reconciled against the same truth in the same
    // breath, because it is the one slot in this store that points at a
    // terminal and was never checked against the list it came from.
    set((state) => ({ terminals, relayPanes: reconcileRelayPanes(state.relayPanes, terminals) }))
  }

  const refreshLayout = async (worktreeId: string): Promise<void> => {
    // Nothing on screen depends on the layout of a worktree with no tab open.
    if (!get().openWorktreeIds.includes(worktreeId)) return
    const token = layoutEdits.mark(worktreeId)
    const layout = await runtimeClient.call('layout.get', { worktreeId })
    if (layoutEdits.isStale(worktreeId, token)) return
    set((state) => ({ layouts: { ...state.layouts, [worktreeId]: layout } }))
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
        // Kept from the first failure rather than refreshed on every one, so
        // the row can say how long it has been unable to confirm itself.
        unreadableSince[worktreeId] ??= readAt
      })
      return { statuses: next, unreadableSince }
    })
  }

  /**
   * The changed-paths list, read only while the panel is open and only for the
   * worktree on screen. It is a `git status` per read, and a panel nobody has
   * opened is not worth one.
   */
  /**
   * The commits this worktree made, read on the same trigger as its changes.
   *
   * Without it the panel goes quiet at exactly the wrong moment: an agent that
   * finishes its work commits it, and every uncommitted change disappears.
   */
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
      // A path that stopped being a change — reverted, or committed from a
      // terminal — cannot stay ticked for a commit that would then fail.
      stagedPaths: state.stagedPaths.filter((path) => live.has(path))
    }))
  }

  /**
   * The patch for the selected path. Re-read whenever the tree moves, so the
   * pane on the right is never describing an older version of the file than the
   * list on the left.
   */
  const refreshDiff = async (worktreeId: string, path: string): Promise<void> => {
    set({ diffPending: true })
    const diff = await runtimeClient.call('worktree.diff', { worktreeId, path }).catch(() => null)
    // The selection can move while a patch is in flight; a late answer for a
    // path nobody is looking at any more must not replace the current one.
    const current = get()
    if (current.selectedChangePath !== path || current.activeWorktreeId !== worktreeId) return
    set({ diff, diffPending: false })
  }

  /**
   * How many merge previews may be in flight at once.
   *
   * Each one is a `git merge-tree`, which is fast but is still a process. Ten
   * worktrees refreshing together would otherwise fan out ten of them on every
   * file change, and the sidebar is not worth that.
   */
  const MERGE_PREVIEW_CONCURRENCY = 4

  /**
   * Reads mergeability for the worktrees named, a few at a time.
   *
   * One unreadable worktree must not cost the others their badge, so each
   * failure is dropped rather than thrown — the row simply shows nothing, which
   * is what it showed before the read.
   */
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
   * The worktrees whose git numbers are being shown right now: the open tabs,
   * and the sidebar rows actually rendered.
   *
   * `worktree.status` is a `git status` in the checkout and
   * `worktree.mergePreview` a `git merge-tree` in the primary one, and the
   * invalidation that asks for them names no worktree — so without this, one
   * file changing anywhere costs two git processes for every ready worktree in
   * every project, up to once a second, most of them for numbers nothing is
   * painting. It is the same rationing the sidebar already does for its pane
   * reads, and it is only honest as long as coming into view is itself a read:
   * see `readOnScreen`.
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
    // The runtime watches each checkout and publishes `worktrees` when its files
    // move, so status has a change stream of its own now. A terminal starting or
    // exiting is still worth a read: it is a command boundary, and it costs one
    // call for the worktrees already on screen.
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
      reads.push(
        refreshWorktrees().then((ready) => {
          for (const worktreeId of ready) stale.add(worktreeId)
        })
      )
    }

    await Promise.all(reads)
    // Last, so a status is never asked for a worktree the list just dropped —
    // and never for one nothing is showing.
    const live = new Set(get().worktrees.map((worktree) => worktree.id))
    const onScreen = onScreenWorktreeIds()
    const readable = [...stale].filter((worktreeId) => live.has(worktreeId) && onScreen.has(worktreeId))
    await refreshStatuses(readable)
    // After the statuses, because a row without chips has nothing to put a
    // merge badge beside yet.
    await refreshMergePreviews(readable)

    // The panel rides the same signal as the chips above it, so an edit made in
    // a shell — or by an agent through the CLI — moves both at once.
    const { changesOpen, activeWorktreeId, selectedChangePath } = get()
    if (!changesOpen || !activeWorktreeId || !readable.includes(activeWorktreeId)) return
    await Promise.all([refreshChanges(activeWorktreeId), refreshLog(activeWorktreeId)])
    if (selectedChangePath !== null) await refreshDiff(activeWorktreeId, selectedChangePath)
  }

  /**
   * Re-reads the rosters this window is already holding.
   *
   * The `members` event names no project, so this is the widest a roster
   * refetch ever gets — and it is still only the ones somebody has opened,
   * because nothing puts a roster in the map until they do.
   */
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

  /**
   * The other half of `.teamree`, on the same signal.
   *
   * The runtime's watch covers the whole directory, so the event that says a
   * key arrived is the same one that says the relay did. Re-read only for the
   * projects somebody has opened, exactly as the rosters are.
   */
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
   * Re-reads teamwork for every project this window is showing.
   *
   * Every project, not only the ones already held: a link coming up is exactly
   * the moment a project that had nothing to say starts having something, and
   * waiting for somebody to open it first would mean the sidebar never showed
   * a teammate arriving. Both calls are cheap — they read memory the runtime
   * already holds — and one project failing must not cost the others theirs.
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
   * Reads the rows on screen, for the moments when what is on screen changes.
   *
   * The other half of `onScreenWorktreeIds`, and the part that keeps it honest:
   * a row that was hidden while its numbers moved has to be read as it appears,
   * or somebody ends up reading a chip that stopped updating when they collapsed
   * the project it was in. Every way a row can appear comes through here or
   * through `openWorktree`, which asks for its own.
   */
  const readOnScreen = (): void => {
    const shown = onScreenWorktreeIds()
    // Ready ones only, exactly as `refreshWorktrees` picks them: there is no
    // git in a checkout that is still being built, or never was.
    const worth = get()
      .worktrees.filter((worktree) => worktree.state === 'ready' && shown.has(worktree.id))
      .map((worktree) => worktree.id)
    if (worth.length > 0) refresher.request(refreshTargets({ statuses: worth }))
  }

  /**
   * Shows a layout without writing it back.
   *
   * For a tree the runtime has already saved: a write-back would send the whole
   * tree as this window computed it, and this window's copy is only ever as new
   * as the last event that reached it.
   */
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
   * Moves the focus `step` places around the pane cycle, wrapping.
   *
   * Both directions out of one walk, because they are one walk: forwards and
   * backwards disagreeing about the order — and they would, written twice — is
   * a pair of chords that do not undo each other.
   *
   * Teammates' panes are in the cycle for the same reason they are in the tree:
   * a pane you can type into that the chord for the next pane refuses to reach
   * is a pane that is only half in the window.
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
    changesOpen: false,
    changes: {},
    logs: {},
    selectedChangePath: null,
    stagedPaths: [],
    committing: false,
    pushing: false,
    cli: null,
    cliPending: false,
    cliInstall: null,
    cliError: null,
    update: null,
    agents: [],
    agentsProbed: false,
    diff: null,
    diffPending: false,

    // Which projects are folded away is a per-person arrangement of the same
    // sidebar the width belongs to, so it is remembered on the same terms.
    // The tabs are not restored here: they name worktrees, and whether those
    // still exist is not known until the runtime has answered. See `bootstrap`.
    collapsedProjects: lastSession.collapsedProjects,
    openWorktreeIds: [],
    activeWorktreeId: null,
    dashboardOpen: false,
    teamworkProjectId: null,
    // Neither is restored from the last session, deliberately: both are places
    // you go to answer a question, and reopening the app onto the answer to
    // yesterday's question is not where anybody left off.
    settingsOpen: false,
    helpOpen: false,

    sidebarWidth: readStoredSidebarWidth(storage) || SIDEBAR_DEFAULT_PX,
    sidebarVisible: lastSession.sidebarVisible,
    paneSearch: null,
    dialog: null,
    notices: [],
    terminalFontSize: readStoredTerminalFontSize(storage),
    startPointDefaults: readStoredStartPoints(storage),
    agentNotices: readStoredAgentNotices(storage),

    // The default until the runtime answers, which is the same palette
    // `tokens.css` already painted the first frame in — so the window does not
    // change shade on the way to its real theme.
    appearance: DEFAULT_APPEARANCE,

    /**
     * The first read of everything. It goes through the same queue the change
     * stream uses, so the opening snapshot cannot be overtaken by an event that
     * arrives while it is still in flight.
     */
    async bootstrap() {
      runtimeClient.onConnectionChange((connection) => set({ connection }))
      set({ connection: runtimeClient.connection })

      try {
        const status = await runtimeClient.call('status.get', {})
        set({ runtimeVersion: status.version })
        // Asked once, and never fatal: an app that cannot list agents is still
        // an app, and the answer only decides which buttons to offer.
        void runtimeClient
          .call('agent.list', {})
          .then((agents) => set({ agents, agentsProbed: true }))
          .catch(() => set({ agents: [], agentsProbed: true }))
        // Asked on the same terms: one cheap read, never fatal, and it decides
        // whether the sidebar has anything to offer about the CLI at all.
        void runtimeClient
          .call('cli.status', {})
          .then((cli) => set({ cli }))
          .catch(() => {})
        // And the theme. Not fatal either: a window that could not read its
        // appearance opens in the default one rather than not opening.
        void runtimeClient
          .call('appearance.get', {})
          .then((appearance) => set({ appearance }))
          .catch(() => {})
        // And the same again for what the runtime knows about newer releases.
        // A read out of its memory: it asks GitHub nothing, and whatever its
        // own check finds arrives later on the change stream.
        void get().loadUpdate()

        refresher.request(refreshTargets({ projects: true, worktrees: true, terminals: true }))
        await refresher.flush()
        // After the projects exist, because teamwork is read per project and
        // there is nothing to read it for until the list has landed.
        refresher.request(refreshTargets({ teammates: true }))
        await refresher.flush()

        if (!get().activeWorktreeId) {
          // The tabs the last window had, in the order it had them, and the one
          // that was in front left in front. Main restores the panes and
          // resumes the agents in them; opening one arbitrary tab instead threw
          // that away every launch. A worktree removed since — from here, from
          // another window, from the CLI — simply has no tab to reopen.
          const live = new Set(get().worktrees.map((worktree) => worktree.id))
          const reopening = lastSession.openWorktreeIds.filter((worktreeId) => live.has(worktreeId))
          for (const worktreeId of reopening) await get().openWorktree(worktreeId)
          const wasActive = lastSession.activeWorktreeId
          if (wasActive !== null && live.has(wasActive)) await get().openWorktree(wasActive)

          // Nothing remembered, or nothing remembered is left: the first ready
          // worktree is still better than an empty window.
          if (reopening.length === 0) {
            const first = get().worktrees.find((worktree) => worktree.state === 'ready')
            if (first) await get().openWorktree(first.id)
          }
        }
      } catch (error) {
        failed('Could not reach the runtime')(error)
      }
    },

    /**
     * The window's one subscription. Everything the runtime changes — from this
     * window, from another, from an agent on the CLI — arrives here as a
     * collection to re-read, which is why nothing in this store polls.
     */
    startWatching() {
      const watch = runtimeClient.watchWorkspace((event) => refresher.push(event))
      return () => {
        watch.close()
        refresher.cancelPending()
      }
    },

    async addProject(path, name) {
      try {
        const project = await runtimeClient.call('project.add', name ? { path, name } : { path })
        set((state) => ({ projects: [...state.projects, project], dialog: null }))
        notify(`Added ${project.name}`, 'info')
      } catch (error) {
        failed('Could not add the project')(error)
      }
    },

    /**
     * One action, three steps, none of which the user waits on: the composer
     * closes immediately and the new row appears in its creating state, because
     * a worktree can take tens of seconds and the sidebar already narrates that
     * better than a spinner in a box would.
     */
    startTask({ projectId, task, startedFrom, agentCommand }) {
      set({ dialog: null })
      const name = task.trim()

      void (async () => {
        const created = await runtimeClient.call(
          'worktree.create',
          startedFrom ? { projectId, name, startedFrom } : { projectId, name }
        )
        set((state) => ({
          worktrees: [...state.worktrees.filter((entry) => entry.id !== created.id), created],
          collapsedProjects: { ...state.collapsedProjects, [projectId]: false }
        }))
        // The project may have been collapsed until now, and its other rows
        // with it.
        readOnScreen()

        // The agent needs a checkout to run in, so the pane waits for one. A
        // failure here is already on the row, with its reason and its retry.
        const ready = await awaitWorktreeReady({
          worktreeId: created.id,
          read: (worktreeId) => runtimeClient.call('worktree.get', { worktreeId }),
          watch: (onChange) => runtimeClient.watchWorkspace(onChange)
        })

        if (agentCommand) {
          await runtimeClient.call('terminal.create', { worktreeId: ready.id, command: agentCommand })
        }
        await get().openWorktree(ready.id)
      })().catch(failed('Could not start the task'))
    },

    /**
     * Builds the checkout again, after removing the one that failed.
     *
     * The removal is not forced. A failed row can have a whole checkout behind
     * it — a create the last restart interrupted is marked failed with its
     * files still on disk — and pressing Retry is not consent to throw those
     * away. So the runtime gets to refuse, and the refusal becomes the same
     * question the sidebar's cross asks.
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
     * Removes a worktree, and asks first when there is something to lose.
     *
     * Not forced. The runtime refuses to delete a checkout with work in it and
     * says so, which is a protection worth keeping rather than defeating: the
     * only thing between a small cross in a sidebar and somebody's afternoon
     * is that refusal.
     */
    async removeWorktree(worktreeId) {
      try {
        await runtimeClient.call('worktree.remove', { worktreeId })
        forgetWorktree(worktreeId)
      } catch (error) {
        // A conflict here means the runtime found something worth asking
        // about: uncommitted work, or files only a .gitignore knows of.
        // Anything else is a real failure and is reported as one.
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
      // Read before the removal, because forgetting the row takes the only
      // copy of what the replacement has to be built from.
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
        // Opening a worktree is the answer the dashboard was open to ask for,
        // whichever surface asked it — a row, a tab, the sidebar, the palette.
        // The teamwork view goes for the same reason: somebody who has picked a
        // worktree has asked to be somewhere else. Settings and help go with
        // them: they are read, not worked in, and picking a worktree is the
        // clearest possible statement that the reading is over.
        dashboardOpen: false,
        teamworkProjectId: null,
        settingsOpen: false,
        helpOpen: false,
        openWorktreeIds: state.openWorktreeIds.includes(worktreeId)
          ? state.openWorktreeIds
          : [...state.openWorktreeIds, worktreeId],
        // A patch belongs to the worktree it came from; carrying one across a
        // tab switch would show this worktree's file list beside that one's
        // diff.
        // Ticks belong to the worktree they were made in; carrying them across
        // would stage one worktree's paths against another's index.
        // A maximised pane is a way of looking at one worktree's tree, so it
        // does not travel to another's — the tab you arrive at is the tab as
        // you left it.
        ...(switching
          ? { selectedChangePath: null, diff: null, diffPending: false, stagedPaths: [], expandedTerminalId: null }
          : {})
      }))
      if (get().changesOpen) {
        void refreshChanges(worktreeId).catch(failed('Could not read the changes'))
        void refreshLog(worktreeId).catch(() => undefined)
      }
      // Through the queue like everything else, so opening a tab while an
      // event-driven refetch is in flight cannot interleave the two answers.
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
      // Focus is a property of a layout, and the layout for a worktree that was
      // not open arrives with `openWorktree` — so the focus has to wait for it.
      await get().openWorktree(worktreeId)
      get().focusPane(terminalId)
    },

    recordTerminal(terminal) {
      set((state) =>
        state.terminals[terminal.id] ? { terminals: { ...state.terminals, [terminal.id]: terminal } } : {}
      )
    },

    focusPane(paneId) {
      // A teammate's pane is focused here and not in a layout, because the
      // layouts belong to the runtime and this pane is not one of its sessions.
      // Everything else about focus is the same for both, which is the point:
      // one id space, one chord, one highlighted border.
      if (isWatchedPaneId(paneId)) {
        if (get().watches.some((watch) => watch.id === paneId)) set({ focusedWatchId: paneId })
        return
      }
      // Focusing one of your own is also what takes the focus off a teammate's:
      // two panes wearing the focused border would be two answers to where the
      // next keystroke goes, and one of them would be wrong.
      if (get().focusedWatchId !== null) set({ focusedWatchId: null })
      const layout = activeLayout()
      if (!layout || layout.focusedTerminalId === paneId) return
      persistLayout({ ...layout, focusedTerminalId: paneId })
    },

    async splitFocusedPane(direction) {
      // Splitting somebody else's pane is not a thing that can be asked for:
      // the tree the new pane would go in is on their machine, and this window
      // has no say in it. Refused in silence rather than by a disabled button,
      // because the button splits whatever pane has the focus and most of the
      // time that is one of your own.
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
     * Closes a pane, once anybody who needs asking has been asked.
     *
     * The reasoning underneath is the same one `forceCloseTerminal` carries
     * about ordering, arrived at from the other side: the pane is the only way
     * to reach a PTY and everything running under it, so a close that kills a
     * working process throws that work away with one click and no way back.
     * `closePaneWarning` decides whether this is one of those — a plain shell
     * at a prompt still closes without a word, because a question asked on
     * every close is one people learn to press through.
     *
     * The question lives here and not on the buttons. There are three ways to
     * close a pane now and there will be a fourth, and a guard attached to each
     * of them is a guard the fourth is written without.
     */
    async closeTerminal(terminalId) {
      const warning = closePaneWarning(get().terminals[terminalId])
      if (warning !== null) {
        set({ dialog: { kind: 'confirm-close-pane', terminalId } })
        return
      }
      await get().forceCloseTerminal(terminalId)
    },

    /**
     * Closes a pane, but only once the process behind it is really gone.
     *
     * The pane is the only way to reach a PTY and everything running under it,
     * so taking it off the screen first and asking afterwards would strand an
     * agent mid-task with no row, no pane and no way back short of quitting.
     */
    async forceCloseTerminal(terminalId) {
      const { activeWorktreeId } = get()
      if (!activeWorktreeId || !get().layouts[activeWorktreeId]) return

      try {
        await runtimeClient.call('terminal.close', { terminalId })
      } catch (error) {
        failed('Could not close the terminal')(error)
        return
      }

      // Re-read: the close was awaited, and the layout can have moved under it.
      const layout = get().layouts[activeWorktreeId]
      if (!layout) return
      // Shown, not saved. The runtime took the leaf out and wrote the layout as
      // part of closing the terminal, and it publishes it; writing this
      // window's version back over that would replace the whole tree with one
      // that never contained a pane opened from anywhere else in the meantime,
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
        // Closing the pane that was filling the workspace is a way of asking
        // for the tree back, whether or not it was meant as one.
        return { terminals, ...(state.expandedTerminalId === terminalId ? { expandedTerminalId: null } : {}) }
      })
    },

    /**
     * Runs an exited pane again, in place.
     *
     * Nothing is asked first, unlike closing: the pane is already dead, so
     * there is no work to lose, and what it printed is kept above the new run
     * rather than replaced by it.
     */
    async relaunchTerminal(terminalId) {
      try {
        const terminal = await runtimeClient.call('terminal.relaunch', { terminalId })
        set((state) => ({ terminals: { ...state.terminals, [terminal.id]: terminal } }))
      } catch (error) {
        failed('Could not run this pane again')(error)
      }
    },

    async createTerminal(worktreeId) {
      try {
        const terminal = await runtimeClient.call('terminal.create', { worktreeId })
        set((state) => ({ terminals: { ...state.terminals, [terminal.id]: terminal } }))
        // Creation already appends and focuses one pane in the runtime.
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
     * Maximises the focused pane, or restores the tree if one already is.
     *
     * One command for both halves rather than two, because the second half is
     * not something anybody goes looking for: whatever key put the window into
     * this state is the key that has to take it out again, or the state is a
     * trap. Nothing is saved — see `expandedTerminalId` — so the tree that
     * comes back is the one the runtime has, not a copy made here.
     *
     * A teammate's pane is not maximised, for the reason their pane is refused
     * everywhere else: it is not in this worktree's tree, so there is no tree
     * for it to fill and nothing to give back.
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
      // The sidebar's order, not the store's: these two chords move the same
      // highlight the sidebar draws, so walking the array the runtime happened
      // to answer with would send the highlight up and down the list for
      // reasons nobody looking at it could see.
      const next = worktreeAfter(worktreeOrder(projects, worktrees), activeWorktreeId, step)
      if (next && next.id !== activeWorktreeId) void get().openWorktree(next.id)
    },

    openPaneSearch() {
      // Find searches an emulator's scrollback, and a watched pane's scrollback
      // is a picture held at the owner's size and scaled to fit — there is no
      // search addon on it, and there could not be one that meant anything
      // about the pane rather than about the last few screens of it that
      // reached here. Opening the field over a pane that is not the focused one
      // would be worse than not opening it.
      if (get().focusedWatchId !== null) return
      const focused = activeLayout()?.focusedTerminalId
      if (!focused) return
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
      const opening = !get().changesOpen
      set({ changesOpen: opening })
      if (!opening) return
      // Read on the way open rather than kept warm: until the panel is shown,
      // nothing on screen depends on it.
      const worktreeId = get().activeWorktreeId
      if (!worktreeId) return
      void refreshChanges(worktreeId).catch(failed('Could not read the changes'))
      void refreshLog(worktreeId).catch(() => undefined)
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
        // The commit can capture more than was ticked: anything staged earlier
        // in a terminal goes in too. The runtime reports what actually landed,
        // and saying so is the difference between a notice and a surprise.
        const extra = result.paths.filter((path) => !paths.includes(path))
        notify(
          extra.length === 0
            ? `Committed ${result.shortSha}: ${result.message}`
            : `Committed ${result.shortSha}: ${result.message} — including ${extra.length} path${
                extra.length === 1 ? '' : 's'
              } already staged`,
          'info'
        )
        // Everything that was ticked is in the commit now, so nothing is left
        // ticked; the list underneath refetches on the invalidation the runtime
        // publishes for the write.
        // The runtime announces the write, so the list and the chips refetch
        // through the same path everything else does; doing it here as well
        // would be a second way for this window to disagree with the others.
        set({ stagedPaths: [], selectedChangePath: null, diff: null })
      } catch (error) {
        failed('Could not commit')(error)
      } finally {
        set({ committing: false })
      }
    },

    async startAgent(command) {
      const worktreeId = get().activeWorktreeId
      if (!worktreeId) return
      try {
        // Straight through terminal.create: the runtime is what pins the
        // session id, so a pane started here resumes like any other.
        const terminal = await runtimeClient.call('terminal.create', { worktreeId, command })
        set((state) => ({ terminals: { ...state.terminals, [terminal.id]: terminal } }))
        refresher.request(refreshTargets({ layouts: [worktreeId] }))
        await refresher.flush()
      } catch (error) {
        failed('Could not start the agent')(error)
      }
    },

    async loadCli() {
      // A refusal belongs to the attempt that earned it, and so does a success.
      // Without this, cancelling the password prompt and closing the dialog
      // leaves "the password was not given" waiting for whoever opens it next,
      // about an attempt nobody made — and a link made in March and broken in
      // April leaves a panel saying the CLI is not on your PATH with a line
      // under it saying it now points at this app. Cleared on the read rather
      // than on open because the read is what opening does, and because
      // `installCli` re-reads before it records its own refusal.
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
        // The runtime resolved the link before answering, so its status is the
        // read-back rather than a guess, and there is nothing left to re-read.
        set({ cliInstall: install, cli: install.status })
      } catch (error) {
        // Re-read first, then say what refused: what is at the destination may
        // be exactly why it was refused, so "there is a file there" has to
        // survive the refusal — and the read clears the last refusal, so the
        // new one goes on afterwards or it goes nowhere.
        await get().loadCli()
        set({ cliError: error instanceof Error ? error.message : String(error) })
      } finally {
        set({ cliPending: false })
      }
    },

    async dismissCliPrompt() {
      // Optimistic, because the card must go the instant it is answered: a
      // question that lingers while a round trip completes is a question the
      // user answers twice. The runtime's reply replaces the guess.
      const current = get().cli
      if (current && current.askedAt === null) set({ cli: { ...current, askedAt: Date.now() } })
      try {
        set({ cli: await runtimeClient.call('cli.dismissPrompt', {}) })
      } catch (error) {
        // Worth a notice rather than a shrug: an answer that was not written
        // down is an answer that will be asked for again on the next launch.
        failed('Could not record that teamree asked about putting its CLI on your PATH')(error)
      }
    },

    async loadUpdate() {
      try {
        set({ update: await runtimeClient.call('update.state', {}) })
      } catch {
        // Nothing. This is a read of what the runtime already knows, and a
        // window that cannot perform it simply says nothing about updates —
        // which is the same silence a check that found nothing produces.
      }
    },

    async checkForUpdates() {
      // Optimistic, so the row the user just pressed says "Checking…" rather
      // than staying still until a round trip over a slow link completes.
      const before = get().update
      if (before) set({ update: { ...before, checking: true } })
      try {
        const update = await runtimeClient.call('update.check', {})
        set({ update })
        // The card says the rest when there is something to say. This is for
        // the other two answers, which have nowhere else to appear — and which
        // somebody who has just chosen "Check for updates" is owed.
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
        // Said out loud, unlike a failed check: this one is a button somebody
        // pressed, and a button that does nothing at all is the worst outcome
        // here — the release page is still reachable by hand.
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
      // A refusal is about one attempt at one project, so re-opening the panel
      // must not show somebody else's.
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
      // A refusal is about one attempt at one project, so re-opening the dialog
      // must not show somebody else's.
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
        // The same half-done state a join leaves behind, said the same way: the
        // file exists and means nothing to anybody else until it is pushed.
        notify(`Wrote ${setting.file}. Commit and push it so your team meets there.`, 'info')
      } catch (error) {
        // Kept in the dialog rather than raised as a notice: a refusal names
        // the URL to type instead, and that is only useful beside the field.
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
        // Said as a notice as well as in the dialog, because the file being
        // written is the smaller half of what just happened: until it is
        // committed and pushed, nobody else can see it.
        if (list.selfFile) notify(`Wrote ${list.selfFile}. Commit and push it to join.`, 'info')
      } catch (error) {
        // Kept in the panel rather than raised as a notice, exactly as a
        // refused relay URL is: the runtime's refusals here all end in "choose
        // another handle", which is an instruction about the box the cursor is
        // in and belongs under it.
        set({ membersError: error instanceof Error ? error.message : String(error) })
      } finally {
        set({ membersPending: false })
      }
    },

    async setOrigin(projectId, url) {
      set({ originPending: true, originError: null })
      try {
        const result = await runtimeClient.call('teamwork.setOrigin', { projectId, url })
        // The status caches the project key against a stamp of git's config,
        // and that stamp has just moved: this read is what turns the blocker
        // green without anybody restarting the app.
        await get().loadTeamwork(projectId)
        await get().loadPublishPlan(projectId)
        notify(
          result.replaced
            ? `origin now points at ${result.url}.`
            : `Added origin ${result.url}. Your teammates’ checkouts have to name the same repository.`,
          'info'
        )
      } catch (error) {
        // Beside the field, like every other refusal here: what git said about
        // a URL is only useful next to the box that URL is in.
        set({ originError: error instanceof Error ? error.message : String(error) })
      } finally {
        set({ originPending: false })
      }
    },

    async startRelayPane(projectId, kind, argument) {
      const project = get().projects.find((entry) => entry.id === projectId)
      const deployCommand = get().relays[projectId]?.deploy.command
      // Every one of these is already why the button is disabled. Checked again
      // because a store action is reachable from more than one button.
      if (!project || !deployCommand || get().relayPanes[projectId]) return
      // And so is this one. The check button is disabled with `RELAY_CHECK.nothing`
      // when there is no URL to dial, and until now that sentence was the only
      // thing standing between a caller and `<launcher> check` with no argument
      // — a command that is not the check anybody asked for, in a pane titled
      // as though it were.
      if (kind === 'check' && (argument === undefined || argument.trim() === '')) return
      // The runtime reports one command, because the shared contract types one.
      // The other two verbs are the same launcher with the verb swapped, and
      // null when what was reported is not that shape — which is the panel's
      // second reason for a disabled button, checked here for the same reason.
      const command = kind === 'deploy' ? deployCommand : relayLauncherCommand(deployCommand, kind, argument)
      if (command === null) return
      try {
        const terminal = await runtimeClient.call('terminal.create', {
          worktreeId: teamworkPaneWorktreeId(projectId, kind),
          cwd: project.path,
          command
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
      // The terminal goes first and the slot second, now that the slot is
      // rebuilt from the runtime's list: dropping it first leaves a window in
      // which a refresh sees a live teamwork terminal with no slot and dutifully
      // adopts the pane the user just closed straight back onto the screen.
      await runtimeClient.call('terminal.close', { terminalId: pane.terminalId }).catch(() => undefined)
      set((state) => {
        const { [projectId]: _closed, ...rest } = state.relayPanes
        return { relayPanes: rest }
      })
    },

    noteRelayPane(projectId, output, running) {
      const pane = get().relayPanes[projectId]
      if (!pane) return
      // Which schemes count is the pane's own business: a deploy prints wss://
      // and nothing else, a relay run here is ws:// until something terminates
      // TLS in front of it, and a check is a report rather than a source.
      const schemes = RELAY_PANE_URL_SCHEMES[pane.kind]
      // Only the tail of the scrollback is read, and a relay that is working
      // logs: give it long enough and the announcement scrolls out of the
      // window this is looking at, the scrape comes back empty and the button
      // somebody was about to press disappears out from under them. The address
      // did not stop being the address because the pane kept talking, so a URL
      // once found is kept until the pane is closed. Anything later that scrapes
      // still wins — a second deploy in one pane means the second one.
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
        // Not a notice: the panel shows the button disabled with nothing to say
        // about it, and a toast about a plan nobody asked for is noise. The
        // read is retried every time the panel is opened.
        set({ publishError: error instanceof Error ? error.message : String(error) })
      }
    },

    async loadPublishProgress(projectId) {
      try {
        const progress = await runtimeClient.call('teamwork.publishProgress', { projectId })
        if (progress === null) return
        set((state) => ({ publishProgress: { ...state.publishProgress, [projectId]: progress } }))
      } catch {
        // Deliberately silent. This is a poll running beside a call that is
        // already going to report its own failure, and a notice for each read
        // that did not land would bury the one that matters under thirty of
        // its own.
      }
    },

    async cancelPublish(projectId) {
      await runtimeClient.call('teamwork.cancelPublish', { projectId }).catch(() => undefined)
      // Read straight back rather than waiting for the next poll: a Stop that
      // takes a beat to land must still change something on screen at once, or
      // it reads as a button that did nothing.
      await get().loadPublishProgress(projectId)
    },

    async publishTeamwork(projectId) {
      if (get().publishPending) return
      // The previous run's record would otherwise be read as this one's for as
      // long as the first poll takes, which is a stopwatch starting at the last
      // push's duration.
      set((state) => {
        const { [projectId]: _previous, ...rest } = state.publishProgress
        return { publishPending: true, publishError: null, publishProgress: rest }
      })
      try {
        const result = await runtimeClient.call('teamwork.publish', { projectId })
        set((state) => ({ publishResults: { ...state.publishResults, [projectId]: result } }))
        // Said as a notice as well as in the panel, because this is the one act
        // here that leaves the machine and a reader may be looking elsewhere.
        notify(
          result.push.ok
            ? result.push.alreadyUpToDate
              ? `${result.remote} already had ${result.branch}.`
              : `Pushed ${result.branch} to ${result.remote}. Your team can reach this machine now.`
            : // "Refused" is the remote's verdict and is wrong for the two
              // outcomes that are not the remote's at all: a push somebody
              // stopped, and one that never finished.
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
        // One last read, so the panel can report how long it took rather than
        // losing the whole measurement at the moment it becomes a fact.
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

      set({ pushing: true })
      try {
        const result = await runtimeClient.call('worktree.push', { worktreeId })
        // Three things are worth saying and none of them is "done": whether
        // anything was actually sent, whether this push is what made the branch
        // track anything, and what stayed behind uncommitted.
        const parts = [
          result.alreadyUpToDate
            ? `${result.remote} already had ${result.branch}`
            : `Pushed ${result.branch} to ${result.remote}`
        ]
        if (result.setUpstream) parts.push(`now tracking ${result.upstream}`)
        if (result.uncommitted > 0) {
          parts.push(`${result.uncommitted} uncommitted change${result.uncommitted === 1 ? '' : 's'} stayed behind`)
        }
        notify(`${parts.join(' · ')}.`, 'info')
      } catch (error) {
        failed('Could not push')(error)
      } finally {
        set({ pushing: false })
      }
    },

    selectChange(path) {
      const worktreeId = get().activeWorktreeId
      set({ selectedChangePath: path, diff: null, diffPending: path !== null })
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
        // Named rather than swallowed: a prompt that failed to be answered and
        // said nothing would leave the owner believing they had decided.
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
        // Focused on arrival, like a pane you just opened: it is the thing that
        // was asked for, and it is the one you are about to type into.
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
        // Absent means the pane has already been closed, and the chunk is one
        // that was in flight when it went. Keeping it would leave a tail behind
        // for a pane nobody can see, quoted in a row that is no longer live.
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
      // Expanding puts rows back on screen that have not been read while they
      // were hidden. Collapsing needs nothing: what is left was already current.
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
      // The same one main area, and the same rule. Pressing the chord again is
      // how you leave, which is why this toggles rather than opens: a page
      // opened by a key that does nothing on the second press is a page people
      // hunt for a close button on.
      set((state) => ({
        settingsOpen: !state.settingsOpen,
        helpOpen: false,
        dashboardOpen: false,
        teamworkProjectId: null
      }))
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
      // Nothing here decides whether the path is there; the main process does,
      // because it is the only side that can look. What this decides is what
      // happens when the answer is no — a notice rather than a thrown error,
      // because pressing "Reveal in Finder" on a checkout that has been deleted
      // under you is an ordinary thing to do and not a fault to report.
      // Guarded the way `storage` above it is: this store is imported by tests
      // that run under node, where there is no `window` at all and reaching for
      // one is a ReferenceError rather than an undefined.
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

    setStartPointDefault(projectId, ref) {
      const startPointDefaults = withStartPoint(get().startPointDefaults, projectId, ref)
      set({ startPointDefaults })
      writeStoredStartPoints(storage, startPointDefaults)
    },

    async setProjectPaths(projectId, paths) {
      try {
        const project = await runtimeClient.call('project.setPaths', { projectId, ...paths })
        // Taken from the answer rather than from what was typed: the runtime
        // trims, de-duplicates and drops an empty list, and a field that went
        // on showing the typing would disagree with what is stored.
        set((state) => ({ projects: state.projects.map((row) => (row.id === project.id ? project : row)) }))
      } catch (error) {
        failed('Could not save what new worktrees carry over')(error)
      }
    },

    toggleSidebar() {
      set((state) => ({ sidebarVisible: !state.sidebarVisible }))
      // Bringing the sidebar back brings every expanded row with it.
      if (get().sidebarVisible) readOnScreen()
    },

    async setAppearance(appearance) {
      // Held locally first so the window repaints on the keystroke rather than
      // on the round trip, and replaced by what the runtime answers — which is
      // the same choice with anything it refused taken out of it.
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
 * One writer for everything the next launch restores.
 *
 * Here rather than in each action for the reason the sidebar's width is written
 * where it is dragged: there is exactly one place a width changes, and there are
 * a dozen places a tab opens, closes or moves — including the refetch that drops
 * a worktree somebody removed from another window. Watching the state is the
 * only version of this that cannot be forgotten in a new one.
 */
useWorkspaceStore.subscribe((state, previous) => {
  if (!sessionChanged(state, previous)) return
  writeStoredSession(storage, state)
})

/**
 * Whether the runtime refused rather than failed.
 *
 * A refusal is an answer — there is something in this checkout — and the only
 * one this window is allowed to turn into a question for the user. Everything
 * else is a fault, and a fault must never be read as consent.
 */
function isRefusal(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'conflict'
}

function refusalReason(error: unknown): string {
  return error instanceof Error ? error.message : 'this worktree has work in it that is not committed anywhere'
}

/**
 * Whether two scrapes of a pane found the same addresses in the same order.
 *
 * The pane is polled every second and a half, so almost every read finds
 * exactly what the last one did. Comparing before setting is what keeps a
 * running relay from re-rendering the panel forty times a minute over a list
 * that has not moved.
 */
function sameUrls(before: string[], after: string[]): boolean {
  return before.length === after.length && before.every((url, index) => url === after[index])
}

/** Drops entries whose worktree the runtime no longer lists. */
function keptFor<T>(byWorktree: Record<string, T>, live: Set<string>): Record<string, T> {
  const entries = Object.entries(byWorktree).filter(([worktreeId]) => live.has(worktreeId))
  return entries.length === Object.keys(byWorktree).length ? byWorktree : Object.fromEntries(entries)
}

/** Terminal ids on screen right now, for the status bar's pane count. */
export function activeTerminalIds(state: {
  activeWorktreeId: string | null
  layouts: Record<string, Layout>
}): string[] {
  const layout = state.activeWorktreeId ? state.layouts[state.activeWorktreeId] : null
  return collectTerminalIds(layout?.root ?? null)
}

export function worktreesOfProject(worktrees: Worktree[], projectId: string): Worktree[] {
  return worktrees.filter((worktree) => worktree.projectId === projectId)
}

export type { Worktree, WorktreeStatus, Project, Terminal, Layout }
