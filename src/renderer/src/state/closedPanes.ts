// What ⌘⇧T brings back. Terminals are kept by the runtime (`terminal.closed`); file panes are this
// window's own, kept here in `localStorage` so they outlive a relaunch too.

import type { ClosedPane } from '@shared/entities'
import { isFileLeaf, type FileLeaf } from '@shared/filePane'

/** A file pane as it was closed: the leaf, with its path, commit or compare. */
export type ClosedFile = { leaf: FileLeaf; closedAt: number }

/** Closed file panes by worktree id, newest first. */
export type ClosedFiles = Record<string, ClosedFile[]>

/** What a reopen brings back: a terminal by id, or a file leaf. */
export type ReopenTarget = { kind: 'terminal'; terminalId: string } | { kind: 'file'; file: ClosedFile }

const STORAGE_KEY = 'teamree.workspace.closedFiles'

/** As many as the runtime keeps of a worktree's terminals. */
export const CLOSED_FILES_KEPT = 10

export function readClosedFiles(storage: Pick<Storage, 'getItem'> | undefined): ClosedFiles {
  try {
    const record: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '{}')
    if (typeof record !== 'object' || record === null || Array.isArray(record)) return {}
    const files: ClosedFiles = {}
    for (const [worktreeId, list] of Object.entries(record)) {
      if (!Array.isArray(list)) continue
      const kept = list.filter(
        (entry): entry is ClosedFile =>
          typeof entry === 'object' && entry !== null && isFileLeaf(entry.leaf) && typeof entry.closedAt === 'number'
      )
      if (kept.length > 0) files[worktreeId] = kept
    }
    return files
  } catch {
    // Unreadable is the first-launch state: nothing to reopen.
    return {}
  }
}

export function writeClosedFiles(storage: Pick<Storage, 'setItem'> | undefined, files: ClosedFiles): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(files))
  } catch {
    // Storage full or blocked costs the reopen, not the close.
  }
}

export function withClosedFile(files: ClosedFiles, worktreeId: string, file: ClosedFile): ClosedFiles {
  const list = [file, ...(files[worktreeId] ?? [])].slice(0, CLOSED_FILES_KEPT)
  return { ...files, [worktreeId]: list }
}

export function withoutClosedFile(files: ClosedFiles, worktreeId: string, file: ClosedFile): ClosedFiles {
  const list = (files[worktreeId] ?? []).filter((entry) => entry !== file)
  const next = { ...files }
  if (list.length > 0) next[worktreeId] = list
  else delete next[worktreeId]
  return next
}

/** The pane closed last, of either kind, or null when there is none. */
export function nextToReopen(panes: readonly ClosedPane[], files: readonly ClosedFile[]): ReopenTarget | null {
  const pane = panes[0]
  const file = files[0]
  if (pane === undefined && file === undefined) return null
  if (file === undefined || (pane !== undefined && pane.closedAt >= file.closedAt)) {
    return { kind: 'terminal', terminalId: (pane as ClosedPane).terminalId }
  }
  return { kind: 'file', file }
}

/** The agent pane the empty worktree offers to resume: the last closed whose conversation can be picked up. */
export function resumableAgent(panes: readonly ClosedPane[]): ClosedPane | null {
  return panes.find((pane) => pane.agent !== undefined && pane.resumable) ?? null
}
