// One store for everything the window shows. The runtime is the source of
// truth; this keeps a read model of it plus the purely local bits (which tabs
// are open, which pane has focus, how wide the sidebar is).

import { create } from 'zustand'
import type {
  InstalledAgent,
  Layout,
  PaneNode,
  Project,
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

export type DialogState =
  | { kind: 'add-project' }
  | { kind: 'new-task'; projectId: string }
  | { kind: 'palette' }
  /** Raised only when git has already refused: there is work here to lose. */
  | { kind: 'confirm-remove'; worktreeId: string; reason: string }
  | null

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

type WorkspaceState = {
  connection: ConnectionState
  runtimeVersion: string | null

  projects: Project[]
  worktrees: Worktree[]
  statuses: Record<string, WorktreeStatus>
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

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => {
  const notify = (text: string, tone: Notice['tone'] = 'error'): void => {
    const notice: Notice = { id: ++noticeSeq, text, tone }
    set((state) => ({ notices: [...state.notices.slice(-2), notice] }))
  }

  const failed = (what: string) => (error: unknown) => {
    notify(`${what}: ${error instanceof Error ? error.message : String(error)}`)
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
    set((state) => ({
      statuses: statuses.reduce((map, status) => (status ? { ...map, [status.worktreeId]: status } : map), {
        ...state.statuses
      })
    }))
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
    for (const worktreeId of targets.layouts) reads.push(refreshLayout(worktreeId))
    if (targets.worktrees) {
      reads.push(
        refreshWorktrees().then((ready) => {
          for (const worktreeId of ready) stale.add(worktreeId)
        })
      )
    }

    await Promise.all(reads)
    // Last, so a status is never asked for a worktree the list just dropped.
    const live = new Set(get().worktrees.map((worktree) => worktree.id))
    const readable = [...stale].filter((worktreeId) => live.has(worktreeId))
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

  const refresher = createWorkspaceRefresher({
    run: applyRefresh,
    onError: failed('Could not refresh the workspace')
  })

  const persistLayout = (layout: Layout): void => {
    layoutEdits.bump(layout.worktreeId)
    set((state) => ({ layouts: { ...state.layouts, [layout.worktreeId]: layout } }))
    void runtimeClient
      .call('layout.set', {
        worktreeId: layout.worktreeId,
        root: layout.root,
        focusedTerminalId: layout.focusedTerminalId
      })
      .catch(failed('Could not save the layout'))
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
    terminals: {},
    layouts: {},

    mergePreviews: {},
    changesOpen: false,
    changes: {},
    logs: {},
    selectedChangePath: null,
    stagedPaths: [],
    committing: false,
    pushing: false,
    agents: [],
    agentsProbed: false,
    diff: null,
    diffPending: false,

    collapsedProjects: {},
    openWorktreeIds: [],
    activeWorktreeId: null,
    dashboardOpen: false,

    sidebarWidth: readStoredSidebarWidth(storage) || SIDEBAR_DEFAULT_PX,
    sidebarVisible: true,
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

        refresher.request(refreshTargets({ projects: true, worktrees: true, terminals: true }))
        await refresher.flush()

        if (!get().activeWorktreeId) {
          const first = get().worktrees.find((worktree) => worktree.state === 'ready')
          if (first) await get().openWorktree(first.id)
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

    retryWorktree(worktreeId) {
      const worktree = get().worktrees.find((entry) => entry.id === worktreeId)
      if (!worktree) return
      void runtimeClient
        .call('worktree.remove', { worktreeId, force: true, deleteBranch: false })
        .then(() =>
          runtimeClient.call('worktree.create', {
            projectId: worktree.projectId,
            name: worktree.name,
            startedFrom: worktree.startedFrom
          })
        )
        .then((created) => {
          set((state) => ({
            worktrees: [...state.worktrees.filter((entry) => entry.id !== worktreeId), created]
          }))
        })
        .catch(failed('Retry failed'))
    },

    /**
     * Removes a worktree, and asks first when there is something to lose.
     *
     * Not forced. The runtime refuses to delete a checkout with uncommitted
     * changes and says so, which is a protection worth keeping rather than
     * defeating: the only thing between a small cross in a sidebar and
     * somebody's afternoon is that refusal.
     */
    async removeWorktree(worktreeId) {
      try {
        await runtimeClient.call('worktree.remove', { worktreeId })
        forgetWorktree(worktreeId)
      } catch (error) {
        // A conflict here means exactly one thing: git found work in the
        // checkout. Anything else is a real failure and is reported as one.
        if ((error as { code?: string } | null)?.code === 'conflict') {
          set({
            dialog: {
              kind: 'confirm-remove',
              worktreeId,
              reason: error instanceof Error ? error.message : 'this worktree has uncommitted changes'
            }
          })
          return
        }
        failed('Could not remove the worktree')(error)
      }
    },

    async forceRemoveWorktree(worktreeId) {
      set({ dialog: null })
      try {
        await runtimeClient.call('worktree.remove', { worktreeId, force: true })
        forgetWorktree(worktreeId)
      } catch (error) {
        failed('Could not remove the worktree')(error)
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

    async closeTerminal(terminalId) {
      const { activeWorktreeId, layouts } = get()
      const layout = activeWorktreeId ? layouts[activeWorktreeId] : null
      if (!layout || !activeWorktreeId) return

      const nextFocus = neighbourTerminalId(layout.root, terminalId)
      const root = closePane(layout.root, terminalId)
      persistLayout({
        worktreeId: activeWorktreeId,
        root,
        focusedTerminalId: layout.focusedTerminalId === terminalId ? nextFocus : layout.focusedTerminalId
      })
      set((state) => {
        const terminals = { ...state.terminals }
        delete terminals[terminalId]
        return { terminals }
      })

      try {
        await runtimeClient.call('terminal.close', { terminalId })
      } catch (error) {
        failed('Could not close the terminal')(error)
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

    toggleProject(projectId) {
      set((state) => ({
        collapsedProjects: { ...state.collapsedProjects, [projectId]: !state.collapsedProjects[projectId] }
      }))
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
