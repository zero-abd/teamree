// A file pane: a leaf of the split tree whose content is a worktree file, not a pty.

import type { PaneNode } from './entities'

/** Marks a pane id as a file pane's; a terminal's id never starts with it. */
export const FILE_PANE_PREFIX = 'file:'

/** Where `New markdown` writes when nobody names a file. */
export const DEFAULT_MARKDOWN_PATH = 'NOTES.md'

/** The most `file.read` answers and `file.write` accepts, in bytes. */
export const MAX_FILE_PANE_BYTES = 1024 * 1024

/** How a file pane draws its file; picked by extension, so adding one is adding a case. */
export type FileViewer = 'markdown'

export type FileLeaf = Extract<PaneNode, { kind: 'leaf' }> & { pane: 'file'; path: string }

export function isFilePaneId(id: string): boolean {
  return id.startsWith(FILE_PANE_PREFIX)
}

export function isFileLeaf(node: PaneNode | null | undefined): node is FileLeaf {
  return node?.kind === 'leaf' && node.pane === 'file' && typeof node.path === 'string' && node.path.length > 0
}

export function fileLeaf(id: string, path: string): FileLeaf {
  return { kind: 'leaf', terminalId: id, pane: 'file', path }
}

/** A fresh pane id; `random` is injected so a test can choose it. */
export function newFilePaneId(random: () => string = () => crypto.randomUUID()): string {
  return `${FILE_PANE_PREFIX}${random()}`
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path)
}

/** The viewer for a path, or null when the app has none and the editor should open it. */
export function fileViewerFor(path: string): FileViewer | null {
  return isMarkdownPath(path) ? 'markdown' : null
}

/** A file pane is called by the file's name, without its directory. */
export function filePaneName(path: string): string {
  const name = path
    .split('/')
    .filter((segment) => segment.length > 0)
    .pop()
  return name ?? path
}

/** Every file leaf in the tree, in reading order. */
export function fileLeavesIn(root: PaneNode | null): FileLeaf[] {
  if (root === null) return []
  if (root.kind === 'leaf') return isFileLeaf(root) ? [root] : []
  return root.children.flatMap(fileLeavesIn)
}
