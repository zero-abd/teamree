// Unsaved edits that outlive the editor: switching worktree unmounts every pane,
// and the next mount picks the draft back up. Gone on reload, like any window state.

export type FileDraft = { text: string; savedText: string; modifiedAt: number }

const drafts = new Map<string, FileDraft>()

export function keepDraft(paneId: string, draft: FileDraft): void {
  drafts.set(paneId, draft)
}

/** The draft for a pane, taken: whoever asks now owns the edits. */
export function takeDraft(paneId: string): FileDraft | undefined {
  const draft = drafts.get(paneId)
  drafts.delete(paneId)
  return draft
}

export function dropDraft(paneId: string): void {
  drafts.delete(paneId)
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
