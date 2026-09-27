// The sidebar's view: its filter, chips, Compact and unfolded done rows, kept for this window in
// `localStorage`; plus the requests other surfaces make of it (reveal a row, focus the filter).

import { create } from 'zustand'
import { QUICK_FILTERS, type QuickFilter, type SidebarView } from '../sidebar/sidebarFilter'

const VIEW_KEY = 'teamree.sidebar.view'

export type StoredSidebarView = SidebarView

const EMPTY: StoredSidebarView = { query: '', quick: [], compact: false, openDone: [] }

export function readStoredSidebarView(storage: Pick<Storage, 'getItem'> | undefined): StoredSidebarView {
  try {
    const record: unknown = JSON.parse(storage?.getItem(VIEW_KEY) ?? '{}')
    if (typeof record !== 'object' || record === null) return EMPTY
    const fields = record as Partial<Record<keyof StoredSidebarView, unknown>>
    const known = new Set<string>(QUICK_FILTERS.map((chip) => chip.id))
    return {
      query: typeof fields.query === 'string' ? fields.query : '',
      quick: strings(fields.quick).filter((chip): chip is QuickFilter => known.has(chip)),
      compact: fields.compact === true,
      openDone: strings(fields.openDone)
    }
  } catch {
    return EMPTY
  }
}

export function writeStoredSidebarView(storage: Pick<Storage, 'setItem'> | undefined, view: StoredSidebarView): void {
  try {
    const { query, quick, compact, openDone } = view
    storage?.setItem(VIEW_KEY, JSON.stringify({ query, quick, compact, openDone }))
  } catch {
    // Storage full or blocked: the view holds until the window closes.
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string'))] : []
}

const storage = typeof window === 'undefined' ? undefined : window.localStorage

type SidebarViewState = StoredSidebarView & {
  /** Bumped whenever a worktree is picked, from anywhere; the sidebar scrolls the open row into view. */
  revealSeq: number
  /** Set by Filter Sidebar until the field has taken the focus; the sidebar may not be mounted yet. */
  filterAsked: boolean
  /** The field is drawn; it also is while it holds text. */
  filterOpen: boolean
  setQuery: (query: string) => void
  toggleQuick: (chip: QuickFilter) => void
  setCompact: (compact: boolean) => void
  toggleDone: (projectId: string) => void
  reveal: () => void
  askFilter: () => void
  filterTaken: () => void
  /** Puts the field away, and its text with it. */
  closeFilter: () => void
}

export const useSidebarView = create<SidebarViewState>()((set, get) => {
  const save = (next: Partial<StoredSidebarView>): void => {
    set(next)
    writeStoredSidebarView(storage, get())
  }
  return {
    ...readStoredSidebarView(storage),
    revealSeq: 0,
    filterAsked: false,
    filterOpen: false,
    setQuery: (query) => save({ query }),
    toggleQuick(chip) {
      const { quick } = get()
      save({ quick: quick.includes(chip) ? quick.filter((entry) => entry !== chip) : [...quick, chip] })
    },
    setCompact: (compact) => save({ compact }),
    toggleDone(projectId) {
      const { openDone } = get()
      save({
        openDone: openDone.includes(projectId)
          ? openDone.filter((entry) => entry !== projectId)
          : [...openDone, projectId]
      })
    },
    reveal: () => set((state) => ({ revealSeq: state.revealSeq + 1 })),
    askFilter: () => set({ filterAsked: true, filterOpen: true }),
    filterTaken: () => set({ filterAsked: false }),
    closeFilter() {
      set({ filterOpen: false })
      save({ query: '' })
    }
  }
})
