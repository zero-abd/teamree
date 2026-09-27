// How the Changes tab is laid out: list or tree, kept per machine, and which sections and folders are folded.

import { create } from 'zustand'

export type ChangesView = 'list' | 'tree'

const VIEW_KEY = 'teamree.shell.changesView'

/** Sections that start folded: the settled and the secondary. */
const FOLDED_AT_FIRST = ['section:committed', 'section:commits', 'section:context']

export function readStoredView(storage: Pick<Storage, 'getItem'> | undefined): ChangesView {
  try {
    return storage?.getItem(VIEW_KEY) === 'tree' ? 'tree' : 'list'
  } catch {
    return 'list'
  }
}

function writeStoredView(storage: Pick<Storage, 'setItem'> | undefined, view: ChangesView): void {
  try {
    storage?.setItem(VIEW_KEY, view)
  } catch {
    // Forgetting the view is not worth failing the click that chose it.
  }
}

const storage = typeof localStorage === 'undefined' ? undefined : localStorage

type ScmViewState = {
  view: ChangesView
  /** `section:<id>` or `<section>:<folder path>`; true when folded. */
  folded: Record<string, boolean>
  setView: (view: ChangesView) => void
  toggleFold: (key: string) => void
  setFold: (key: string, folded: boolean) => void
}

export const useScmView = create<ScmViewState>((set) => ({
  view: readStoredView(storage),
  folded: Object.fromEntries(FOLDED_AT_FIRST.map((key) => [key, true])),
  setView(view) {
    writeStoredView(storage, view)
    set({ view })
  },
  toggleFold(key) {
    set((state) => ({ folded: { ...state.folded, [key]: state.folded[key] !== true } }))
  },
  setFold(key, folded) {
    set((state) => ({ folded: { ...state.folded, [key]: folded } }))
  }
}))
