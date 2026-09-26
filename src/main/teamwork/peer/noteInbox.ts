// Notes teammates have shared with this machine, oldest first, kept in one file per project under the
// app's data folder. Bounded per project: seen notes make way before anything is refused, and one
// sender can hold only so many unseen.

import { createHash, randomUUID } from 'node:crypto'
import { readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  MAX_NOTE_ID_CHARS,
  MAX_NOTE_TITLE_CHARS,
  MAX_SHARED_NOTE_BYTES,
  sharedNoteBytes,
  type SharedNote,
  type SharedNoteSummary
} from '../../../shared/sharedNote'
import { ErrorCode } from '../../../shared/protocol'
import { openJsonFile, writeJsonFileAtomically } from '../../store/atomicJsonFile'
import { TeamworkError } from '../errors'

/** The folder under the app's data directory. */
export const NOTES_DIR = 'shared-notes'

/** How many notes one project keeps, seen or not. Each is at most 256 KB. */
export const MAX_HELD_NOTES = 50

/** What one project's notes may weigh together, titles and bodies in UTF-8. */
export const MAX_HELD_BYTES = 4 * 1024 * 1024

/** How many unseen notes one teammate may have waiting here; the next is refused back to them. */
export const MAX_UNSEEN_PER_SENDER = 5

/** A project's file past this is not read: JSON escaping can grow a body up to six times. */
const MAX_FILE_BYTES = 6 * MAX_HELD_BYTES

const NOTES_FILE_VERSION = 1

export type ArrivingNote = Omit<SharedNote, 'shareId' | 'receivedAt' | 'seen' | 'read' | 'bytes'>

export type NoteInbox = {
  /** Reads what earlier runs kept; nothing to read without a folder. */
  load: () => Promise<void>
  /** Files a note, or throws the refusal its sender is answered with. */
  add: (note: ArrivingNote) => SharedNoteSummary
  list: () => SharedNoteSummary[]
  /** The note whole, now marked seen and read; undefined once it is gone. */
  view: (shareId: string) => SharedNote | undefined
  /** Retires its popup and keeps the note. */
  dismiss: (shareId: string) => boolean
  /** Forgets the note, on disk too. */
  close: (shareId: string) => boolean
  /** Forgets every note the predicate names; how many went. */
  dropWhere: (predicate: (note: SharedNoteSummary) => boolean) => number
  /** Resolves once every change so far is on disk. */
  flush: () => Promise<void>
}

const KeptNote = z.object({
  shareId: z.string().min(1).max(MAX_NOTE_ID_CHARS),
  projectId: z.string().min(1).max(MAX_NOTE_ID_CHARS),
  handle: z.string().max(MAX_NOTE_TITLE_CHARS),
  publicKey: z.string().min(1).max(MAX_NOTE_ID_CHARS),
  noteId: z.string().min(1).max(MAX_NOTE_ID_CHARS),
  title: z.string().min(1).max(MAX_NOTE_TITLE_CHARS),
  markdown: z.string(),
  sentAt: z.number(),
  receivedAt: z.number(),
  seen: z.boolean(),
  read: z.boolean().optional()
})

const KeptFile = z.object({
  version: z.literal(NOTES_FILE_VERSION),
  projectId: z.string(),
  notes: z.array(z.unknown())
})

export function createNoteInbox(options: {
  now: () => number
  newId?: () => string
  /** Where each project's file goes; left out, notes last as long as the process. */
  dir?: string
  onError?: (error: unknown) => void
}): NoteInbox {
  const notes: SharedNote[] = []
  const newId = options.newId ?? randomUUID
  const { dir } = options
  const report = (error: unknown): void => options.onError?.(error)

  const dirty = new Set<string>()
  let queue: Promise<void> = Promise.resolve()
  const persist = (projectId: string): void => {
    if (dir === undefined) return
    dirty.add(projectId)
    queue = queue.then(async () => {
      for (const id of [...dirty]) {
        dirty.delete(id)
        const kept = notes.filter((note) => note.projectId === id)
        const file = fileFor(dir, id)
        try {
          if (kept.length === 0) await rm(file, { force: true })
          else await writeJsonFileAtomically(file, { version: NOTES_FILE_VERSION, projectId: id, notes: kept })
        } catch (error) {
          report(error)
        }
      }
    })
  }

  /** Drops the oldest seen notes until one more of `extra` bytes fits; false when it cannot. */
  const makeRoom = (projectId: string, extra: number): boolean => {
    const over = (): boolean => {
      const held = notes.filter((note) => note.projectId === projectId)
      return held.length >= MAX_HELD_NOTES || held.reduce((sum, note) => sum + note.bytes, extra) > MAX_HELD_BYTES
    }
    while (over()) {
      const oldestSeen = notes.findIndex((note) => note.projectId === projectId && note.seen)
      if (oldestSeen === -1) return false
      notes.splice(oldestSeen, 1)
    }
    return true
  }

  return {
    async load() {
      if (dir === undefined) return
      const names = await readdir(dir).catch(() => [])
      const loaded: SharedNote[] = []
      for (const name of names.filter((entry) => entry.endsWith('.json'))) {
        const file = join(dir, name)
        const kept = await readKept(dir, file)
        if (kept === undefined) await rename(file, `${file}.unreadable`).catch(report)
        else loaded.push(...kept)
      }
      for (const note of loaded.sort((a, b) => a.receivedAt - b.receivedAt)) {
        if (notes.some((held) => held.shareId === note.shareId) || !makeRoom(note.projectId, note.bytes)) continue
        notes.push(note)
      }
      notes.sort((a, b) => a.receivedAt - b.receivedAt)
    },

    add(arriving) {
      const unseen = notes.filter((note) => !note.seen && note.publicKey === arriving.publicKey).length
      if (unseen >= MAX_UNSEEN_PER_SENDER) {
        throw new TeamworkError(ErrorCode.Conflict, `${MAX_UNSEEN_PER_SENDER} of your notes are still unread here`)
      }
      const bytes = sharedNoteBytes(arriving.title, arriving.markdown)
      if (!makeRoom(arriving.projectId, bytes)) {
        throw new TeamworkError(ErrorCode.Conflict, 'too many unread notes here')
      }
      const note: SharedNote = { ...arriving, shareId: newId(), receivedAt: options.now(), seen: false, bytes }
      notes.push(note)
      persist(note.projectId)
      return summaryOf(note)
    },
    list: () => notes.map(summaryOf),
    view(shareId) {
      const note = notes.find((candidate) => candidate.shareId === shareId)
      if (!note) return undefined
      if (!note.seen || !note.read) {
        note.seen = true
        note.read = true
        persist(note.projectId)
      }
      return { ...note }
    },
    dismiss(shareId) {
      const note = notes.find((candidate) => candidate.shareId === shareId)
      if (!note) return false
      if (!note.seen) {
        note.seen = true
        persist(note.projectId)
      }
      return true
    },
    close(shareId) {
      const at = notes.findIndex((note) => note.shareId === shareId)
      const note = notes[at]
      if (!note) return false
      notes.splice(at, 1)
      persist(note.projectId)
      return true
    },
    dropWhere(predicate) {
      const before = notes.length
      for (let at = notes.length - 1; at >= 0; at -= 1) {
        const note = notes[at]
        if (note && predicate(summaryOf(note))) {
          notes.splice(at, 1)
          persist(note.projectId)
        }
      }
      return before - notes.length
    },
    async flush() {
      let awaited: Promise<void>
      do {
        awaited = queue
        await awaited
      } while (awaited !== queue)
    }
  }
}

/** Hashed, so a project id never has to be a safe file name. */
function fileFor(dir: string, projectId: string): string {
  return join(dir, `${createHash('sha256').update(projectId).digest('hex').slice(0, 32)}.json`)
}

/** The notes one project's file holds, each checked; undefined when the file itself will not read. */
async function readKept(dir: string, file: string): Promise<SharedNote[] | undefined> {
  const size = await stat(file).then(
    (stats) => stats.size,
    () => 0
  )
  if (size > MAX_FILE_BYTES) return undefined
  const read = await openJsonFile(file)
  if (read.kind === 'missing') return []
  if (read.kind === 'unreadable') return undefined
  const parsed = KeptFile.safeParse(read.value)
  if (!parsed.success || fileFor(dir, parsed.data.projectId) !== file) return undefined
  const { projectId } = parsed.data
  return parsed.data.notes.flatMap((raw) => {
    const note = KeptNote.safeParse(raw)
    if (!note.success || note.data.projectId !== projectId) return []
    const { read: wasRead, ...rest } = note.data
    const bytes = sharedNoteBytes(rest.title, rest.markdown)
    if (bytes > MAX_SHARED_NOTE_BYTES) return []
    return [{ ...rest, ...(wasRead === undefined ? {} : { read: wasRead }), bytes }]
  })
}

function summaryOf(note: SharedNote): SharedNoteSummary {
  const { markdown: _markdown, ...summary } = note
  return summary
}
