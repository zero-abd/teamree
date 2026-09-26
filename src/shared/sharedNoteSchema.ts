// The schemas a shared note is checked against, apart from `sharedNote.ts` so the window never loads zod.

import { z } from 'zod'
import {
  MAX_NOTE_ID_CHARS,
  MAX_NOTE_TITLE_CHARS,
  MAX_SHARED_NOTE_BYTES,
  NOTE_TOO_LARGE,
  sharedNoteBytes
} from './sharedNote'

const NoteFields = z.object({
  noteId: z.string().min(1).max(MAX_NOTE_ID_CHARS),
  title: z.string().trim().min(1).max(MAX_NOTE_TITLE_CHARS),
  markdown: z.string()
})

const withinCap = (note: { title: string; markdown: string }): boolean =>
  sharedNoteBytes(note.title, note.markdown) <= MAX_SHARED_NOTE_BYTES

/**
 * What crosses the wire as `peer.shareNote`. Who sent it is the key the handshake
 * authenticated, never a field: a handle in the payload would be a claim.
 */
export const SharedNotePayload = NoteFields.extend({ sentAt: z.number().int().nonnegative() }).refine(withinCap, {
  message: NOTE_TOO_LARGE
})

/** The same note as this machine's window asks for it to be sent. */
export const ShareNoteRequest = NoteFields.extend({ projectId: z.string().min(1) }).refine(withinCap, {
  message: NOTE_TOO_LARGE
})
