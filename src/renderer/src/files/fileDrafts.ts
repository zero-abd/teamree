// Code-pane edits not yet on disk, kept in the profile so a crash or a SIGTERM loses nothing: the next
// mount opens them dirty. A mounted editor registers how to save itself; an unmounted one saves its draft.

export type FileDraft = {
  worktreeId: string
  path: string
  text: string
  /** What was on disk when the edit began, and when; the save checks against it. */
  savedText: string
  modifiedAt: number
  encoding?: 'utf-8' | 'utf-8-bom'
}

const STORAGE_KEY = 'teamree.fileDrafts'

const storage = typeof window === 'undefined' ? undefined : window.localStorage

const drafts = new Map<string, FileDraft>(readDrafts())
const savers = new Map<string, () => Promise<boolean>>()

function readDrafts(): [string, FileDraft][] {
  try {
    const record: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '{}')
    if (typeof record !== 'object' || record === null) return []
    return Object.entries(record).filter((entry): entry is [string, FileDraft] => isDraft(entry[1]))
  } catch {
    return []
  }
}

function isDraft(value: unknown): value is FileDraft {
  const draft = value as Partial<FileDraft> | null
  return (
    typeof draft === 'object' &&
    draft !== null &&
    typeof draft.worktreeId === 'string' &&
    typeof draft.path === 'string' &&
    typeof draft.text === 'string' &&
    typeof draft.savedText === 'string' &&
    typeof draft.modifiedAt === 'number'
  )
}

function persist(): void {
  try {
    if (drafts.size === 0) storage?.removeItem(STORAGE_KEY)
    else storage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(drafts)))
  } catch {
    // Full or blocked storage: the edit is still in the editor.
  }
}

export function keepDraft(paneId: string, draft: FileDraft): void {
  drafts.set(paneId, draft)
  persist()
}

/** The draft for this pane's file, if one was kept. */
export function draftFor(paneId: string, worktreeId: string, path: string): FileDraft | undefined {
  const draft = drafts.get(paneId)
  return draft?.worktreeId === worktreeId && draft.path === path ? draft : undefined
}

export function dropDraft(paneId: string): void {
  if (drafts.delete(paneId)) persist()
}

export function keptDrafts(): ReadonlyMap<string, FileDraft> {
  return drafts
}

/** Registers a mounted editor's save, which resolves false when the write did not happen. */
export function registerSaver(paneId: string, save: () => Promise<boolean>): () => void {
  savers.set(paneId, save)
  return () => {
    if (savers.get(paneId) === save) savers.delete(paneId)
  }
}

export function saverFor(paneId: string): (() => Promise<boolean>) | undefined {
  return savers.get(paneId)
}

/** Sizes the way a file manager prints them. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
