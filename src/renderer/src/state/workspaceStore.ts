// One store for everything the window shows. The runtime is the source of
// truth; this keeps a read model of it plus the purely local bits (which tabs
// are open, which pane has focus, how wide the sidebar is).

import { create } from 'zustand'
import type {
  CliInstall,
  CliStatus,
  InstalledAgent,
  Layout,
  MemberList,
  PaneNode,
  PaneWatchers,
  Project,
  RelaySetting,
  TeammatePresence,
  TeamworkStatus,
  Terminal,
  Worktree,
  WorktreeChanges,
  WorktreeDiff,
  WorktreeLog,
  WorktreeMergePreview,
  WorktreeStatus
} from '@shared/entities'
import { closePane, collectTerminalIds, neighbourTerminalId, setSizesAt } from '../panes/paneLayout'
import { awaitWorktreeReady } from './awaitWorktreeReady'
import type { ConnectionState } from '../runtimeClient/RuntimeClientContract'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import {
  clampSidebarWidth,
  readStoredSidebarWidth,
  writeStoredSidebarWidth,
  SIDEBAR_DEFAULT_PX
} from '../shell/sidebarWidth'
import { createLocalEditFence, createWorkspaceRefresher, refreshTargets, type RefreshTargets } from './workspaceRefresh'
import { readStoredSession, sessionChanged, writeStoredSession } from './storedSession'

export type DialogState =
  | { kind: 'add-project' }
  | { kind: 'install-cli' }
  | { kind: 'start-teamwork'; projectId: string }
  | { kind: 'new-task'; projectId: string }
  | { kind: 'palette' }
  /** Raised only when the runtime has already refused: there is something here to lose. */
  | { kind: 'confirm-remove'; worktreeId: string; reason: string; intent: RemoveIntent }
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

  sidebarWidth: number
  sidebarVisible: boolean
  paneSearch: PaneSearch | null
  dialog: DialogState
  notices: Notice[]

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

  focusPane: (terminalId: string) => void
  /** Adopts a fresh terminal record, e.g. the one a resize answers with. */
  recordTerminal: (terminal: Terminal) => void
  splitFocusedPane: (direction: 'row' | 'column') => Promise<void>
  closeTerminal: (terminalId: string) => Promise<void>
  createTerminal: (worktreeId: string) => Promise<void>
  focusNextPane: () => void
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

  toggleProject: (projectId: string) => void
  toggleDashboard: () => void
  setSidebarWidth: (width: number) => void
  toggleSidebar: () => void
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
    const terminals = await runtimeClient.call('terminal.list', {})
    // Replaced wholesale rather than merged: the runtime's list is the whole
    // truth, and a terminal closed elsewhere has to leave this map.
    set({ terminals: Object.fromEntries(terminals.map((terminal) => [terminal.id, terminal])) })
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
          runtimeClient.call('teamwork.watchers', { projectId }).catch(() => null)
        ])
      )
    )
    set((state) => {
      const teamwork = { ...state.teamwork }
      const teammates = { ...state.teammates }
      const watchers = { ...state.watchers }
      for (const [status, presence, reading] of answers) {
        if (status) teamwork[status.projectId] = status
        if (presence) teammates[presence.projectId] = presence
        if (reading) watchers[reading.projectId] = reading
      }
      return { teamwork, teammates, watchers }
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

  return {
    connection: runtimeClient.connection,
    runtimeVersion: null,

    projects: [],
    worktrees: [],
    statuses: {},
    unreadableSince: {},
    terminals: {},
    layouts: {},

    mergePreviews: {},
    members: {},
    membersPending: false,
    membersError: null,
    teamworkReadErrors: {},
    relays: {},
    relayPending: false,
    relayError: null,
    teamwork: {},
    teammates: {},
    watchers: {},
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

    sidebarWidth: readStoredSidebarWidth(storage) || SIDEBAR_DEFAULT_PX,
    sidebarVisible: lastSession.sidebarVisible,
    paneSearch: null,
    dialog: null,
    notices: [],

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
        dashboardOpen: false,
        openWorktreeIds: state.openWorktreeIds.includes(worktreeId)
          ? state.openWorktreeIds
          : [...state.openWorktreeIds, worktreeId],
        // A patch belongs to the worktree it came from; carrying one across a
        // tab switch would show this worktree's file list beside that one's
        // diff.
        // Ticks belong to the worktree they were made in; carrying them across
        // would stage one worktree's paths against another's index.
        ...(switching ? { selectedChangePath: null, diff: null, diffPending: false, stagedPaths: [] } : {})
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

    focusPane(terminalId) {
      const layout = activeLayout()
      if (!layout || layout.focusedTerminalId === terminalId) return
      persistLayout({ ...layout, focusedTerminalId: terminalId })
    },

    async splitFocusedPane(direction) {
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
     * Closes a pane, but only once the process behind it is really gone.
     *
     * The pane is the only way to reach a PTY and everything running under it,
     * so taking it off the screen first and asking afterwards would strand an
     * agent mid-task with no row, no pane and no way back short of quitting.
     */
    async closeTerminal(terminalId) {
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
        return { terminals }
      })
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
      const layout = activeLayout()
      if (!layout?.root) return
      const ids = collectTerminalIds(layout.root)
      const index = layout.focusedTerminalId ? ids.indexOf(layout.focusedTerminalId) : -1
      const next = ids[(index + 1) % ids.length]
      if (next) persistLayout({ ...layout, focusedTerminalId: next })
    },

    openPaneSearch() {
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
      // A refusal belongs to the attempt that earned it. Without this, cancelling
      // the password prompt and closing the dialog leaves "the password was not
      // given" waiting for whoever opens it next, about an attempt nobody made.
      set({ cliPending: true, cliError: null })
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

    async mutePane(terminalId, muted) {
      try {
        const answer = await runtimeClient.call('teamwork.mute', { terminalId, muted })
        set((state) => ({ watchers: { ...state.watchers, [answer.projectId]: answer } }))
      } catch (error) {
        failed('Could not change this pane’s mute')(error)
      }
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
      set((state) => ({ dashboardOpen: !state.dashboardOpen }))
    },

    toggleSidebar() {
      set((state) => ({ sidebarVisible: !state.sidebarVisible }))
      // Bringing the sidebar back brings every expanded row with it.
      if (get().sidebarVisible) readOnScreen()
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
