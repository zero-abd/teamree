// A markdown note one teammate sends the rest of the project: its caps and what the receiver holds.
// No zod here: the window imports this, and zod's eval probe trips the renderer's content security policy.

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

/** What crosses the wire as `peer.shareNote`; `sharedNoteSchema.ts` checks it. The sender is the link's key. */
export type SharedNotePayload = { noteId: string; title: string; markdown: string; sentAt: number }

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
