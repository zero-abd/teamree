// A file pane: a leaf of the split tree whose content is a worktree file, not a pty.

import type { PaneNode } from './entities'

/** Marks a pane id as a file pane's; a terminal's id never starts with it. */
export const FILE_PANE_PREFIX = 'file:'

/** Where `New markdown` writes when nobody names a file. */
export const DEFAULT_MARKDOWN_PATH = 'NOTES.md'

/** The most text `file.read` answers and `file.write` accepts, in bytes. */
export const MAX_FILE_PANE_BYTES = 2 * 1024 * 1024

/** How a file pane draws its file; picked by extension, so adding one is adding a case. */
export type FileViewer = 'markdown' | 'code' | 'image' | 'pdf' | 'audio' | 'video'

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

const MEDIA: Record<string, { viewer: 'image' | 'pdf' | 'audio' | 'video'; mime: string }> = {
  png: { viewer: 'image', mime: 'image/png' },
  jpg: { viewer: 'image', mime: 'image/jpeg' },
  jpeg: { viewer: 'image', mime: 'image/jpeg' },
  gif: { viewer: 'image', mime: 'image/gif' },
  webp: { viewer: 'image', mime: 'image/webp' },
  avif: { viewer: 'image', mime: 'image/avif' },
  bmp: { viewer: 'image', mime: 'image/bmp' },
  ico: { viewer: 'image', mime: 'image/x-icon' },
  svg: { viewer: 'image', mime: 'image/svg+xml' },
  pdf: { viewer: 'pdf', mime: 'application/pdf' },
  mp3: { viewer: 'audio', mime: 'audio/mpeg' },
  wav: { viewer: 'audio', mime: 'audio/wav' },
  ogg: { viewer: 'audio', mime: 'audio/ogg' },
  oga: { viewer: 'audio', mime: 'audio/ogg' },
  m4a: { viewer: 'audio', mime: 'audio/mp4' },
  aac: { viewer: 'audio', mime: 'audio/aac' },
  flac: { viewer: 'audio', mime: 'audio/flac' },
  mp4: { viewer: 'video', mime: 'video/mp4' },
  m4v: { viewer: 'video', mime: 'video/mp4' },
  webm: { viewer: 'video', mime: 'video/webm' },
  mov: { viewer: 'video', mime: 'video/quicktime' },
  ogv: { viewer: 'video', mime: 'video/ogg' }
}

function extensionOf(path: string): string {
  const name = filePaneName(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** The viewer for a path; `code` for anything unknown, since the runtime still sniffs binary. */
export function fileViewerFor(path: string): FileViewer {
  if (isMarkdownPath(path)) return 'markdown'
  return MEDIA[extensionOf(path)]?.viewer ?? 'code'
}

/** The MIME type a media file is served as, or null for anything read as text. */
export function mediaTypeFor(path: string): string | null {
  return MEDIA[extensionOf(path)]?.mime ?? null
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
