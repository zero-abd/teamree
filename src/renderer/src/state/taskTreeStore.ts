// Which task trees are folded in the sidebar, and which view the board shows: this machine's habit,
// kept in `localStorage` beside the other preferences.

import { create } from 'zustand'

const COLLAPSED_KEY = 'teamree.sidebar.collapsedTasks'
const BOARD_MODE_KEY = 'teamree.board.mode'

export type BoardMode = 'panes' | 'tasks'

export function readStoredCollapsedTasks(storage: Pick<Storage, 'getItem'> | undefined): Record<string, true> {
  try {
    const record: unknown = JSON.parse(storage?.getItem(COLLAPSED_KEY) ?? '{}')
    if (typeof record !== 'object' || record === null) return {}
    return onlyCollapsed(record as Record<string, unknown>)
  } catch {
    return {}
  }
}

export function writeStoredCollapsedTasks(
  storage: Pick<Storage, 'setItem'> | undefined,
  collapsed: Readonly<Record<string, boolean>>
): void {
  try {
    storage?.setItem(COLLAPSED_KEY, JSON.stringify(onlyCollapsed(collapsed)))
  } catch {
    // Storage full or blocked: the fold holds for this window.
  }
}

export function readStoredBoardMode(storage: Pick<Storage, 'getItem'> | undefined): BoardMode {
  try {
    return storage?.getItem(BOARD_MODE_KEY) === 'tasks' ? 'tasks' : 'panes'
  } catch {
    return 'panes'
  }
}

export function writeStoredBoardMode(storage: Pick<Storage, 'setItem'> | undefined, mode: BoardMode): void {
  try {
    storage?.setItem(BOARD_MODE_KEY, mode)
  } catch {
    // As above.
  }
}

function onlyCollapsed(record: Readonly<Record<string, unknown>>): Record<string, true> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value === true)) as Record<string, true>
}

const storage = typeof window === 'undefined' ? undefined : window.localStorage

type TaskTreeState = {
  collapsedTasks: Record<string, true>
  boardMode: BoardMode
  setTaskCollapsed: (worktreeId: string, collapsed: boolean) => void
  setBoardMode: (mode: BoardMode) => void
}

export const useTaskTreeStore = create<TaskTreeState>()((set, get) => ({
  collapsedTasks: readStoredCollapsedTasks(storage),
  boardMode: readStoredBoardMode(storage),
  setTaskCollapsed(worktreeId, collapsed) {
    const { [worktreeId]: _, ...rest } = get().collapsedTasks
    const collapsedTasks: Record<string, true> = collapsed ? { ...rest, [worktreeId]: true } : rest
    set({ collapsedTasks })
    writeStoredCollapsedTasks(storage, collapsedTasks)
  },
  setBoardMode(boardMode) {
    set({ boardMode })
    writeStoredBoardMode(storage, boardMode)
  }
}))
