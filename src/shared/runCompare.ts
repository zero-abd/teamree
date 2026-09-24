// Two runs of one task set side by side, file by file: what each run did to each path either touched.

import { parsePatch, type PatchFile } from './patch'

/** One run's change to one file: its slice of the patch as git wrote it, and the lines it adds and removes. */
export type RunFile = { patch: string; added: number; removed: number }

/** A path either run touched; the run that left it alone has null. `same` when both made the one change. */
export type ComparedFile = { path: string; left: RunFile | null; right: RunFile | null; same: boolean }

/** A run's patch cut at each `diff --git`, keyed by the path after the change. */
export function patchByFile(patch: string): Map<string, RunFile> {
  const files = new Map<string, RunFile>()
  for (const text of patch.split(/^(?=diff --git )/m)) {
    const [file] = parsePatch(text)
    if (file === undefined) continue
    const lines = file.hunks.flatMap((hunk) => hunk.lines)
    files.set(file.path, {
      patch: text,
      added: lines.filter((line) => line.kind === 'added').length,
      removed: lines.filter((line) => line.kind === 'removed').length
    })
  }
  return files
}

export function compareRuns(left: string, right: string): ComparedFile[] {
  const ours = patchByFile(left)
  const theirs = patchByFile(right)
  const paths = [...new Set([...ours.keys(), ...theirs.keys()])].sort((a, b) => a.localeCompare(b))
  return paths.map((path) => {
    const one = ours.get(path) ?? null
    const other = theirs.get(path) ?? null
    return { path, left: one, right: other, same: one !== null && other !== null && sameChange(one, other) }
  })
}

/** Equal from the hunks down; a binary file, which has none, by its whole text. */
function sameChange(one: RunFile, other: RunFile): boolean {
  const shape = (file: PatchFile | undefined): string =>
    file === undefined ? '' : JSON.stringify([file.status, file.from, file.binary, file.hunks])
  const [a] = parsePatch(one.patch)
  const [b] = parsePatch(other.patch)
  return a !== undefined && b !== undefined && (a.binary ? one.patch === other.patch : shape(a) === shape(b))
}
