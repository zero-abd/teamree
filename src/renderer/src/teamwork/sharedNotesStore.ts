// Notes teammates shared with this machine, as the window holds them: the runtime's list, the bodies
// opened so far, and the popups still asking. Re-read on the `teammates` event.

import { create } from 'zustand'
import type { SharedNote, SharedNoteSummary } from '@shared/sharedNote'
import { UNDO_LIFETIME_MS } from '../notices/noticeLifetime'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { copyName } from './shareNote'

/** How many popups are on screen at once; the rest wait their turn, oldest first. */
export const MAX_NOTE_POPUPS = 3

/** The saved names tried before giving up, so a folder of copies cannot keep a loop going. */
const COPY_ATTEMPTS = 50

type SharedNotesState = {
  inbox: SharedNoteSummary[]
  /** Bodies read so far by share id; null once the runtime says the note is gone. */
  bodies: Record<string, SharedNote | null>
  /** Deleted here and waiting out their Undo; the runtime still has them. */
  deleting: Record<string, true>
  /** The note read in place on the Teamwork page. */
  expanded: string | null
  refresh: () => Promise<void>
  /** The note whole, read once; marks it seen and read, which retires its popup. */
  open: (shareId: string) => Promise<SharedNote | null>
  /** Later: retires the popup and keeps the note. */
  dismiss: (shareId: string) => Promise<void>
  /** Toggles reading a note in place, opening it the first time. */
  expand: (shareId: string | null) => void
  /** Hides the note now; the runtime forgets it once the Undo window has passed. */
  remove: (shareId: string) => void
  /** Undo: the note is back and the runtime is never told. */
  restore: (shareId: string) => void
  /** Writes the note into the worktree's root under a free name; the path written. */
  saveCopy: (shareId: string, worktreeId: string) => Promise<string>
}

/** The popups asking now: unseen notes, oldest first, at most `MAX_NOTE_POPUPS`. */
export function notePopups(inbox: readonly SharedNoteSummary[]): SharedNoteSummary[] {
  return inbox
    .filter((note) => !note.seen)
    .sort((a, b) => a.receivedAt - b.receivedAt)
    .slice(0, MAX_NOTE_POPUPS)
}

/** The notes a list shows, newest first: none waiting out a Delete, only `projectId`'s when given. */
export function listedNotes(
  state: Pick<SharedNotesState, 'inbox' | 'deleting'>,
  projectId?: string
): SharedNoteSummary[] {
  return state.inbox
    .filter((note) => !state.deleting[note.shareId] && (projectId === undefined || note.projectId === projectId))
    .sort((a, b) => b.receivedAt - a.receivedAt)
}

export function unreadNotes(state: Pick<SharedNotesState, 'inbox' | 'deleting'>, projectId?: string): number {
  return listedNotes(state, projectId).filter((note) => note.read !== true).length
}

/** Per share id: the runtime forgets the note when this fires. */
const pendingDeletes = new Map<string, ReturnType<typeof setTimeout>>()

export const useSharedNotes = create<SharedNotesState>()((set, get) => ({
  inbox: [],
  bodies: {},
  deleting: {},
  expanded: null,

  async refresh() {
    const inbox = await runtimeClient.call('teamwork.sharedNotes', {}).catch(() => null)
    if (inbox) set({ inbox })
  },

  async open(shareId) {
    const held = get().bodies[shareId]
    if (held !== undefined) return held
    set((state) => ({
      inbox: state.inbox.map((note) => (note.shareId === shareId ? { ...note, seen: true, read: true } : note))
    }))
    const note = await runtimeClient.call('teamwork.viewNote', { shareId }).catch(() => null)
    set((state) => ({ bodies: { ...state.bodies, [shareId]: note } }))
    return note
  },

  async dismiss(shareId) {
    set((state) => ({ inbox: state.inbox.map((note) => (note.shareId === shareId ? { ...note, seen: true } : note)) }))
    await runtimeClient.call('teamwork.dismissNote', { shareId }).catch(() => undefined)
  },

  expand(shareId) {
    const next = shareId === get().expanded ? null : shareId
    set({ expanded: next })
    if (next !== null) void get().open(next)
  },

  remove(shareId) {
    clearTimeout(pendingDeletes.get(shareId))
    set((state) => ({
      deleting: { ...state.deleting, [shareId]: true },
      expanded: state.expanded === shareId ? null : state.expanded
    }))
    pendingDeletes.set(
      shareId,
      setTimeout(() => {
        pendingDeletes.delete(shareId)
        // Hidden until the runtime has forgotten it, so a re-read in between cannot bring it back.
        void runtimeClient
          .call('teamwork.closeNote', { shareId })
          .catch(() => undefined)
          .then(() => {
            set((state) => {
              const { [shareId]: _gone, ...deleting } = state.deleting
              return { deleting, inbox: state.inbox.filter((note) => note.shareId !== shareId) }
            })
          })
      }, UNDO_LIFETIME_MS)
    )
  },

  restore(shareId) {
    clearTimeout(pendingDeletes.get(shareId))
    pendingDeletes.delete(shareId)
    set((state) => {
      const { [shareId]: _restored, ...deleting } = state.deleting
      return { deleting }
    })
  },

  async saveCopy(shareId, worktreeId) {
    const note = await get().open(shareId)
    if (!note) throw new Error('That note is gone')
    for (let attempt = 0; attempt < COPY_ATTEMPTS; attempt += 1) {
      const path = copyName(note.title, attempt)
      const existing = await runtimeClient.call('file.read', { worktreeId, path })
      if (existing.exists) continue
      await runtimeClient.call('file.write', { worktreeId, path, content: note.markdown })
      return path
    }
    throw new Error(`Too many copies of ${note.title}`)
  }
}))
