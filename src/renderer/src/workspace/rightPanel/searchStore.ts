// The Search tab's query, options and last results, kept while the tab is away. One search runs at
// a time; starting another or leaving closes the stream, which kills the engine.

import { create } from 'zustand'
import type { SearchFileHits, SearchSummary } from '@shared/search'
import { runtimeClient } from '../../runtimeClient/currentRuntimeClient'
import type { Subscription } from '../../runtimeClient/RuntimeClientContract'
import { mergeHits } from './searchModel'

export type SearchScope = 'task' | 'all'

export type SearchForm = {
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
  scope: SearchScope
  /** Comma-separated globs; `!glob` excludes. */
  include: string
}

type SearchState = SearchForm & {
  /** What the results shown answer, so a remount does not search again. */
  answered: string | null
  files: SearchFileHits[]
  summary: SearchSummary | null
  running: boolean
  failed: string | null
  /** The hit row walked to or opened, by its row key; kept across the remount a jump to another task causes. */
  selected: string | null
  setForm: (patch: Partial<SearchForm>) => void
  select: (key: string | null) => void
  run: (target: { worktreeId: string; projectId: string }) => void
  cancel: () => void
}

const EMPTY_FORM: SearchForm = {
  query: '',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  scope: 'task',
  include: ''
}

let current: Subscription | null = null
let generation = 0
let pending: SearchFileHits[] = []
let frame: number | null = null

/** The request a form and target make, as one string. */
export function searchSignature(form: SearchForm, target: { worktreeId: string; projectId: string }): string {
  const { query, caseSensitive, wholeWord, regex, scope, include } = form
  const where = scope === 'all' ? `p:${target.projectId}` : `w:${target.worktreeId}`
  return JSON.stringify([where, query, caseSensitive, wholeWord, regex, include])
}

export function includeGlobs(include: string): string[] {
  return include
    .split(',')
    .map((glob) => glob.trim())
    .filter((glob) => glob !== '')
}

export const useSearchStore = create<SearchState>((set, get) => ({
  ...EMPTY_FORM,
  answered: null,
  files: [],
  summary: null,
  running: false,
  failed: null,
  selected: null,

  setForm: (patch) => set(patch),
  select: (selected) => set({ selected }),

  run: (target) => {
    get().cancel()
    const form = get()
    if (form.query === '') {
      set({ answered: null, files: [], summary: null, failed: null })
      return
    }
    const mine = ++generation
    const include = includeGlobs(form.include)
    set({
      answered: searchSignature(form, target),
      files: [],
      summary: null,
      running: true,
      failed: null,
      selected: null
    })
    runtimeClient
      .searchContents(
        {
          ...(form.scope === 'all' ? { projectId: target.projectId } : { worktreeId: target.worktreeId }),
          query: form.query,
          ...(form.caseSensitive ? { caseSensitive: true } : {}),
          ...(form.wholeWord ? { wholeWord: true } : {}),
          ...(form.regex ? { regex: true } : {}),
          ...(include.length === 0 ? {} : { include })
        },
        (event) => {
          if (mine !== generation) return
          if (event.type === 'hits') {
            pending.push(...event.files)
            frame ??= requestAnimationFrame(flushPending)
            return
          }
          flushPending()
          set({ summary: event, running: false })
        }
      )
      .then(
        (subscription) => {
          if (mine === generation) current = subscription
          else closeQuietly(subscription)
        },
        (error: unknown) => {
          if (mine !== generation) return
          set({ running: false, failed: error instanceof Error ? error.message : String(error) })
        }
      )
  },

  cancel: () => {
    generation += 1
    dropPending()
    if (current !== null) closeQuietly(current)
    current = null
    if (get().running) set({ running: false, answered: null })
  }
}))

// Hits stream in faster than frames; one merge and render per frame keeps the renderer responsive.
function flushPending(): void {
  const batch = pending
  dropPending()
  if (batch.length > 0) useSearchStore.setState((state) => ({ files: mergeHits(state.files, batch) }))
}

function dropPending(): void {
  if (frame !== null) cancelAnimationFrame(frame)
  frame = null
  pending = []
}

// The runtime may have ended the stream already; a close that fails has nothing left to stop.
function closeQuietly(subscription: Subscription): void {
  void Promise.resolve(subscription.close()).catch(() => {})
}
