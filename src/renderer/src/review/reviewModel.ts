// Reading a whole change: hunk headings, the order files come in, and which files are marked viewed.

import type { WorktreeChange } from '@shared/entities'
import type { PatchFile, PatchHunk } from '@shared/patch'
import { patchByFile } from '@shared/runCompare'

/** A file as it read when marked viewed: its lines, and its counts for the Changes list, which has no patch. */
export type ViewedMark = { fingerprint: string; added: number; removed: number }

/** The function git found the hunk in, arguments folded; else the lines it covers. */
export function hunkLabel(hunk: PatchHunk): string {
  const context = hunk.header.replace(/^@@[^@]*@@\s?/, '').trim()
  if (context !== '') {
    const open = context.indexOf('(')
    return open > 0 ? `${context.slice(0, open)}(…)` : context.replace(/\s*\{$/, '')
  }
  const [start, count] = hunk.newCount > 0 ? [hunk.newStart, hunk.newCount] : [hunk.oldStart, hunk.oldCount]
  return count <= 1 ? `Line ${start}` : `Lines ${start}–${start + count - 1}`
}

export function viewedMark(file: PatchFile): ViewedMark {
  let added = 0
  let removed = 0
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'added') added += 1
      else if (line.kind === 'removed') removed += 1
    }
  }
  return { fingerprint: fingerprint(file), added, removed }
}

export function isViewedFile(mark: ViewedMark | undefined, file: PatchFile): boolean {
  return mark !== undefined && mark.fingerprint === fingerprint(file)
}

export function isViewedRow(mark: ViewedMark | undefined, change: WorktreeChange): boolean {
  return mark !== undefined && mark.added === change.added && mark.removed === change.removed
}

function fingerprint(file: PatchFile): string {
  const body = file.hunks.map((hunk) => hunk.lines.map((line) => `${line.kind[0]}${line.text}`).join('\n'))
  return `${file.status}\n${file.binary ? 'binary' : ''}\n${body.join('\n@@\n')}`
}

/** The patch with its files in the Changes list's order; any it does not list keep theirs, after it. */
export function inChangesOrder(patch: string, changes: readonly WorktreeChange[]): string {
  const at = new Map(changes.map((change, index) => [change.path, index]))
  const files = [...patchByFile(patch)]
  const place = (path: string): number => at.get(path) ?? changes.length
  return files
    .map(([path, file], index) => ({ path, text: file.patch, index }))
    .sort((a, b) => place(a.path) - place(b.path) || a.index - b.index)
    .map((entry) => entry.text)
    .join('')
}
