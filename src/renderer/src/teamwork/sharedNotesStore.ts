// Notes teammates shared with this machine, as the window holds them: the runtime's list, the bodies
// opened so far, and the popups still asking. Re-read on the `teammates` event.

import { create } from 'zustand'
import type { SharedNote, SharedNoteSummary } from '@shared/sharedNote'
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
  refresh: () => Promise<void>
  /** The note whole, read once; marks it seen, which retires its popup. */
  open: (shareId: string) => Promise<SharedNote | null>
  /** Forgets the note here and in the runtime. */
  close: (shareId: string) => Promise<void>
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

export const useSharedNotes = create<SharedNotesState>()((set, get) => ({
  inbox: [],
  bodies: {},

  async refresh() {
    const inbox = await runtimeClient.call('teamwork.sharedNotes', {}).catch(() => null)
    if (inbox) set({ inbox })
  },

  async open(shareId) {
    const held = get().bodies[shareId]
    if (held !== undefined) return held
    set((state) => ({ inbox: state.inbox.map((note) => (note.shareId === shareId ? { ...note, seen: true } : note)) }))
    const note = await runtimeClient.call('teamwork.viewNote', { shareId }).catch(() => null)
    set((state) => ({ bodies: { ...state.bodies, [shareId]: note } }))
    return note
  },

  async close(shareId) {
    set((state) => ({ inbox: state.inbox.filter((note) => note.shareId !== shareId) }))
    await runtimeClient.call('teamwork.closeNote', { shareId }).catch(() => undefined)
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
