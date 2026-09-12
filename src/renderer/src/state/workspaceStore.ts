// One store for everything the window shows. The runtime is the source of
// truth; this keeps a read model of it plus the purely local bits (which tabs
// are open, which pane has focus, how wide the sidebar is).

import { create } from 'zustand'
import type { Layout, PaneNode, Project, Terminal, Worktree, WorktreeStatus } from '@shared/entities'
import { closePane, collectTerminalIds, neighbourTerminalId, setSizesAt } from '../panes/paneLayout'
import type { ConnectionState } from '../runtimeClient/RuntimeClientContract'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import {
  clampSidebarWidth,
  readStoredSidebarWidth,
  writeStoredSidebarWidth,
  SIDEBAR_DEFAULT_PX
} from '../shell/sidebarWidth'

export type DialogState =
  | { kind: 'add-project' }
  | { kind: 'create-worktree'; projectId: string }
  | null

export type Notice = { id: number; text: string; tone: 'error' | 'info' }

type WorkspaceState = {
  connection: ConnectionState
  runtimeVersion: string | null

  projects: Project[]
  worktrees: Worktree[]
  statuses: Record<string, WorktreeStatus>
  terminals: Record<string, Terminal>
  layouts: Record<string, Layout>

  collapsedProjects: Record<string, boolean>
  openWorktreeIds: string[]
  activeWorktreeId: string | null

  sidebarWidth: number
  sidebarVisible: boolean
  dialog: DialogState
  notices: Notice[]

  bootstrap: () => Promise<void>
  poll: () => Promise<void>

  addProject: (path: string, name?: string) => Promise<void>
  createWorktree: (input: { projectId: string; name: string; startedFrom?: string }) => void
  retryWorktree: (worktreeId: string) => void
  removeWorktree: (worktreeId: string) => Promise<void>

  openWorktree: (worktreeId: string) => Promise<void>
  closeWorktreeTab: (worktreeId: string) => void

  focusPane: (terminalId: string) => void
  /** Adopts a fresh terminal record, e.g. the one a resize answers with. */
  recordTerminal: (terminal: Terminal) => void
  splitFocusedPane: (direction: 'row' | 'column') => Promise<void>
  closeTerminal: (terminalId: string) => Promise<void>
  createTerminal: (worktreeId: string) => Promise<void>
  focusNextPane: () => void
  applySplitSizes: (worktreeId: string, path: number[], sizes: number[]) => void

  toggleProject: (projectId: string) => void
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

  /** Pulls the layout and terminal records for one worktree into the store. */
  const loadWorkspace = async (worktreeId: string): Promise<void> => {
    const [layout, terminals] = await Promise.all([
      runtimeClient.call('layout.get', { worktreeId }),
      runtimeClient.call('terminal.list', { worktreeId })
    ])
    set((state) => ({
      layouts: { ...state.layouts, [worktreeId]: layout },
      terminals: terminals.reduce(
        (map, terminal) => ({ ...map, [terminal.id]: terminal }),
        { ...state.terminals }
      )
    }))
  }

  const persistLayout = (layout: Layout): void => {
    set((state) => ({ layouts: { ...state.layouts, [layout.worktreeId]: layout } }))
    void runtimeClient
      .call('layout.set', {
        worktreeId: layout.worktreeId,
        root: layout.root,
        focusedTerminalId: layout.focusedTerminalId
      })
      .catch(failed('Could not save the layout'))
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

    collapsedProjects: {},
    openWorktreeIds: [],
    activeWorktreeId: null,

    sidebarWidth: readStoredSidebarWidth(storage) || SIDEBAR_DEFAULT_PX,
    sidebarVisible: true,
    dialog: null,
    notices: [],

    async bootstrap() {
      runtimeClient.onConnectionChange((connection) => set({ connection }))
      set({ connection: runtimeClient.connection })

      try {
        const [status, projects, worktrees] = await Promise.all([
          runtimeClient.call('status.get', {}),
          runtimeClient.call('project.list', {}),
          runtimeClient.call('worktree.list', {})
        ])
        set({ runtimeVersion: status.version, projects, worktrees })

        const first = worktrees.find((worktree) => worktree.state === 'ready')
        if (first) await get().openWorktree(first.id)
        await get().poll()
      } catch (error) {
        failed('Could not reach the runtime')(error)
      }
    },

    /**
     * Worktree creation happens in the background and the protocol has no
     * change stream for it, so the shell re-reads the list on a timer and
     * refreshes git status for what is actually on screen.
     */
    async poll() {
      try {
        const worktrees = await runtimeClient.call('worktree.list', {})
        set({ worktrees })

        const visible = new Set([...get().openWorktreeIds, ...worktrees.map((worktree) => worktree.id)])
        const ready = worktrees.filter((worktree) => worktree.state === 'ready' && visible.has(worktree.id))
        const statuses = await Promise.all(
          ready.map((worktree) =>
            runtimeClient.call('worktree.status', { worktreeId: worktree.id }).catch(() => null)
          )
        )
        set((state) => ({
          statuses: statuses.reduce(
            (map, status) => (status ? { ...map, [status.worktreeId]: status } : map),
            { ...state.statuses }
          )
        }))

        // A worktree that finished creating while its tab was open has panes now.
        const openWithoutLayout = get().openWorktreeIds.filter((id) => !get().layouts[id]?.root)
        await Promise.all(openWithoutLayout.map((id) => loadWorkspace(id)))
      } catch (error) {
        failed('Could not refresh worktrees')(error)
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
     * Fire and forget: the dialog closes on submit and the new row appears in
     * its creating state, because a worktree can take tens of seconds.
     */
    createWorktree({ projectId, name, startedFrom }) {
      set({ dialog: null })
      void runtimeClient
        .call('worktree.create', startedFrom ? { projectId, name, startedFrom } : { projectId, name })
        .then((worktree) => {
          set((state) => ({
            worktrees: [...state.worktrees.filter((entry) => entry.id !== worktree.id), worktree],
            collapsedProjects: { ...state.collapsedProjects, [projectId]: false }
          }))
        })
        .catch(failed('Could not start the worktree'))
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

    async removeWorktree(worktreeId) {
      try {
        await runtimeClient.call('worktree.remove', { worktreeId, force: true })
        get().closeWorktreeTab(worktreeId)
        set((state) => ({ worktrees: state.worktrees.filter((entry) => entry.id !== worktreeId) }))
      } catch (error) {
        failed('Could not remove the worktree')(error)
      }
    },

    async openWorktree(worktreeId) {
      set((state) => ({
        activeWorktreeId: worktreeId,
        openWorktreeIds: state.openWorktreeIds.includes(worktreeId)
          ? state.openWorktreeIds
          : [...state.openWorktreeIds, worktreeId]
      }))
      try {
        await loadWorkspace(worktreeId)
      } catch (error) {
        failed('Could not open the worktree')(error)
      }
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

    recordTerminal(terminal) {
      set((state) => (state.terminals[terminal.id] ? { terminals: { ...state.terminals, [terminal.id]: terminal } } : {}))
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
        const layout = get().layouts[worktreeId]
        if (!layout?.root) {
          persistLayout({
            worktreeId,
            root: { kind: 'leaf', terminalId: terminal.id },
            focusedTerminalId: terminal.id
          })
        } else {
          const focused = layout.focusedTerminalId ?? collectTerminalIds(layout.root)[0] ?? null
          if (focused) {
            const { layout: next } = await runtimeClient.call('terminal.split', {
              terminalId: focused,
              direction: 'row'
            })
            set((state) => ({ layouts: { ...state.layouts, [worktreeId]: next } }))
          }
        }
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

    applySplitSizes(worktreeId, path, sizes) {
      const layout = get().layouts[worktreeId]
      if (!layout?.root) return
      persistLayout({ ...layout, root: setSizesAt(layout.root, path, sizes) as PaneNode })
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
