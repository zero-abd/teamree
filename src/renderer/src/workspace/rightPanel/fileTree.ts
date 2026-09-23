// The files tab's tree, as data: which directories are open, what each one
// was last read as, and which rows that makes.
//
// No watcher. The runtime lists one directory per call and never recurses,
// and this holds those answers and nothing more: a directory is read when it
// is opened and read again when it is opened again, and a file an agent writes
// meanwhile appears the next time its folder is opened. That is a deliberate
// trade — a watcher over a checkout with `node_modules` in it is the thing
// that makes an app feel heavy — and the store's own worktree events already
// move the letters beside the rows, which is the half a person is watching.
//
// Everything here is a pure function of the state, so the component is only
// the calls and the clicks and this file is what the tests are written against.

import type {
  WorktreeChangeKind,
  WorktreeChanges,
  WorktreeFileEntry,
  WorktreeFileKind,
  WorktreeFiles
} from '@shared/entities'
import { KIND_LETTER } from './changeKinds'

/** The root, which has no name and is always open. */
export const ROOT = ''

export type TreeDir = {
  /** The last listing, or null before the first one arrives. */
  entries: WorktreeFileEntry[] | null
  loading: boolean
  /** Why the last read failed, or null. Cleared by the next listing. */
  error: string | null
  truncated: boolean
}

export type TreeState = {
  /** Only the open ones; a directory absent from this record is folded. */
  expanded: Record<string, boolean>
  dirs: Record<string, TreeDir>
}

export type TreeRow = {
  /** Relative to the worktree root, with forward slashes. */
  path: string
  name: string
  depth: number
  kind: WorktreeFileKind
  ignored: boolean
  /** Only meaningful for a directory. */
  expanded: boolean
  loading: boolean
  error: string | null
  truncated: boolean
}

const EMPTY_DIR: TreeDir = { entries: null, loading: false, error: null, truncated: false }

export function emptyTree(): TreeState {
  return { expanded: { [ROOT]: true }, dirs: {} }
}

export function childPath(directory: string, name: string): string {
  return directory === ROOT ? name : `${directory}/${name}`
}

/** Marks a directory as being read, keeping whatever it last read. */
export function beginListing(tree: TreeState, path: string): TreeState {
  const current = tree.dirs[path] ?? EMPTY_DIR
  return { ...tree, dirs: { ...tree.dirs, [path]: { ...current, loading: true } } }
}

/** Replaces a directory's listing with what the runtime just answered. */
export function applyListing(tree: TreeState, listing: WorktreeFiles): TreeState {
  return {
    ...tree,
    dirs: {
      ...tree.dirs,
      [listing.path]: { entries: listing.entries, loading: false, error: null, truncated: listing.truncated }
    }
  }
}

export function failListing(tree: TreeState, path: string, error: string): TreeState {
  const current = tree.dirs[path] ?? EMPTY_DIR
  return { ...tree, dirs: { ...tree.dirs, [path]: { ...current, loading: false, error } } }
}

/**
 * Opens a directory. `read` is always true, and is returned rather than
 * assumed so the caller's "and now list it" sits beside the reason: there is
 * no watcher, so every open is a fresh read, even of a folder read a second
 * ago. Whatever it read last is drawn meanwhile.
 */
export function expandDir(tree: TreeState, path: string): { tree: TreeState; read: boolean } {
  return { tree: { ...tree, expanded: { ...tree.expanded, [path]: true } }, read: true }
}

export function foldDir(tree: TreeState, path: string): TreeState {
  const expanded = { ...tree.expanded }
  delete expanded[path]
  return { ...tree, expanded }
}

export function isExpanded(tree: TreeState, path: string): boolean {
  return tree.expanded[path] === true
}

/** Every open directory, root included, for a reload to read again. */
export function expandedDirs(tree: TreeState): string[] {
  return Object.keys(tree.expanded).filter((path) => tree.expanded[path] === true)
}

/** The rows in drawing order: depth first, each open directory's listing under it. */
export function treeRows(tree: TreeState): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (directory: string, depth: number): void => {
    const listed = tree.dirs[directory]
    if (!listed?.entries) return
    for (const entry of listed.entries) {
      const path = childPath(directory, entry.name)
      const own = tree.dirs[path]
      const expanded = entry.kind === 'dir' && isExpanded(tree, path)
      rows.push({
        path,
        name: entry.name,
        depth,
        kind: entry.kind,
        ignored: entry.ignored,
        expanded,
        loading: own?.loading ?? false,
        error: own?.error ?? null,
        truncated: own?.truncated ?? false
      })
      if (expanded) walk(path, depth + 1)
    }
  }
  walk(ROOT, 0)
  return rows
}

/** How git sees this path, or null when it is unchanged. */
export function statusKindFor(path: string, changes: WorktreeChanges | undefined): WorktreeChangeKind | null {
  return changes?.changes.find((entry) => entry.path === path)?.kind ?? null
}

/** The letter the changes tab prints for this path, or null when it is unchanged. */
export function statusLetterFor(path: string, changes: WorktreeChanges | undefined): string | null {
  const kind = statusKindFor(path, changes)
  return kind === null ? null : KIND_LETTER[kind]
}

/** How many changed paths sit somewhere under this directory. */
export function changesUnder(directory: string, changes: WorktreeChanges | undefined): number {
  if (!changes) return 0
  const prefix = `${directory}/`
  return changes.changes.filter((entry) => entry.path.startsWith(prefix)).length
}
