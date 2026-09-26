// Notes teammates have shared with this machine: in memory, bounded, oldest first. Seen notes
// make way before anything is refused, and one sender can hold only so many unseen.

import { randomUUID } from 'node:crypto'
import { sharedNoteBytes, type SharedNote, type SharedNoteSummary } from '../../../shared/sharedNote'
import { ErrorCode } from '../../../shared/protocol'
import { TeamworkError } from '../errors'

/** How many notes are held at once, seen or not. Each is at most 256 KB. */
export const MAX_HELD_NOTES = 20

/** How many unseen notes one teammate may have waiting here; the next is refused back to them. */
export const MAX_UNSEEN_PER_SENDER = 5

export type ArrivingNote = Omit<SharedNote, 'shareId' | 'receivedAt' | 'seen' | 'bytes'>

export type NoteInbox = {
  /** Files a note, or throws the refusal its sender is answered with. */
  add: (note: ArrivingNote) => SharedNoteSummary
  list: () => SharedNoteSummary[]
  /** The note whole, now marked seen; undefined once it is gone. */
  view: (shareId: string) => SharedNote | undefined
  close: (shareId: string) => boolean
  /** Forgets every note the predicate names; how many went. */
  dropWhere: (predicate: (note: SharedNoteSummary) => boolean) => number
}

export function createNoteInbox(options: { now: () => number; newId?: () => string }): NoteInbox {
  const notes: SharedNote[] = []
  const newId = options.newId ?? randomUUID

  return {
    add(arriving) {
      const unseen = notes.filter((note) => !note.seen && note.publicKey === arriving.publicKey).length
      if (unseen >= MAX_UNSEEN_PER_SENDER) {
        throw new TeamworkError(ErrorCode.Conflict, `${MAX_UNSEEN_PER_SENDER} of your notes are still unread here`)
      }
      if (notes.length >= MAX_HELD_NOTES) {
        const oldestSeen = notes.findIndex((note) => note.seen)
        if (oldestSeen === -1) throw new TeamworkError(ErrorCode.Conflict, 'too many unread notes here')
        notes.splice(oldestSeen, 1)
      }
      const note: SharedNote = {
        ...arriving,
        shareId: newId(),
        receivedAt: options.now(),
        seen: false,
        bytes: sharedNoteBytes(arriving.title, arriving.markdown)
      }
      notes.push(note)
      return summaryOf(note)
    },
    list: () => notes.map(summaryOf),
    view(shareId) {
      const note = notes.find((candidate) => candidate.shareId === shareId)
      if (!note) return undefined
      note.seen = true
      return { ...note }
    },
    close(shareId) {
      const at = notes.findIndex((note) => note.shareId === shareId)
      if (at === -1) return false
      notes.splice(at, 1)
      return true
    },
    dropWhere(predicate) {
      const before = notes.length
      for (let at = notes.length - 1; at >= 0; at -= 1) {
        const note = notes[at]
        if (note && predicate(summaryOf(note))) notes.splice(at, 1)
      }
      return before - notes.length
    }
  }
}

function summaryOf(note: SharedNote): SharedNoteSummary {
  const { markdown: _markdown, ...summary } = note
  return summary
}
