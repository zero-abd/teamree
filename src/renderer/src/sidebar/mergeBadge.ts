// How a merge preview reads in one word. It has to survive being three
// characters wide and keep "could not tell" visibly apart from "nothing wrong".

import type { WorktreeMergePreview } from '@shared/entities'

export type MergeBadge = {
  /** What the row shows. */
  label: string
  /** Drives the colour; `unknown` is not a warning. */
  tone: 'clean' | 'conflicts' | 'unknown'
  /** The full sentence, for the title attribute. */
  detail: string
}

export function mergeBadge(preview: WorktreeMergePreview | undefined): MergeBadge | null {
  // Nothing read yet; the answer arrives a moment later on its own.
  if (!preview) return null

  switch (preview.state) {
    case 'nothingToMerge':
      // Nothing, on purpose: every fresh worktree is in this state. Never
      // "merged": a branch whose commits are all in the base and one that never
      // made any are the same fact to git, and the row must not talk somebody into deleting.
      return null
    case 'clean':
      return {
        label: 'merges',
        tone: 'clean',
        detail: `${preview.ahead} commit${
          preview.ahead === 1 ? '' : 's'
        } that merge into ${preview.baseRef} without conflicts.`
      }
    case 'conflicts':
      return {
        label: `${preview.conflicts.length} conflict${preview.conflicts.length === 1 ? '' : 's'}`,
        tone: 'conflicts',
        detail: conflictDetail(preview)
      }
    case 'unrelated':
    case 'unavailable':
      return {
        label: 'unknown',
        tone: 'unknown',
        detail: preview.reason ?? `Could not tell whether this merges into ${preview.baseRef}.`
      }
  }
}

/** The first few paths, then a count: a tooltip is not a file list. */
function conflictDetail(preview: WorktreeMergePreview): string {
  const shown = preview.conflicts.slice(0, 5)
  const rest = preview.conflicts.length - shown.length
  const paths = shown.join('\n')
  const more = rest > 0 ? `\n…and ${rest} more` : ''
  return `Would conflict with ${preview.baseRef} in:\n${paths}${more}`
}
