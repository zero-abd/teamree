// How many lines each open code file holds, for Go to Line's range; outside the store since only ⌃G reads it.

const counts = new Map<string, number>()

const keyOf = (worktreeId: string, path: string): string => `${worktreeId}\0${path}`

export function noteEditorLines(worktreeId: string, path: string, lines: number): void {
  counts.set(keyOf(worktreeId, path), lines)
}

/** Undefined until an editor for the file has drawn it. */
export function editorLines(worktreeId: string, path: string): number | undefined {
  return counts.get(keyOf(worktreeId, path))
}
