// A markdown note one teammate sends the rest of the project: the wire shape, its caps, and what the receiver holds.

import { z } from 'zod'

/** The most a shared note may weigh, title and body together, in UTF-8 bytes. */
export const MAX_SHARED_NOTE_BYTES = 256 * 1024
export const MAX_NOTE_TITLE_CHARS = 200
export const MAX_NOTE_ID_CHARS = 512

/** Title and body as UTF-8 bytes, counted without allocating the encoding. */
export function sharedNoteBytes(title: string, markdown: string): number {
  let bytes = 0
  for (const text of [title, markdown]) {
    for (const character of text) {
      const code = character.codePointAt(0) ?? 0
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    }
  }
  return bytes
}

/** The words for a note over the cap, said by both ends. */
export const NOTE_TOO_LARGE = 'Note is over 256 KB'

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

export type SharedNotePayload = z.infer<typeof SharedNotePayload>

/** One received note as the window lists it: everything but the body. */
export type SharedNoteSummary = {
  /** This machine's id for this one arrival. */
  shareId: string
  projectId: string
  /** What this project's roster files the sender under. */
  handle: string
  publicKey: string
  noteId: string
  title: string
  /** The sender's clock. */
  sentAt: number
  /** This machine's clock. */
  receivedAt: number
  /** Opened or dismissed from its popup once; a seen note no longer asks for attention. */
  seen: boolean
  bytes: number
}

export type SharedNote = SharedNoteSummary & { markdown: string }

/** Who a share reached. Only connected teammates receive one; the rest are named with why not. */
export type NoteShareResult = {
  projectId: string
  delivered: string[]
  missed: { handle: string; reason: string }[]
}
