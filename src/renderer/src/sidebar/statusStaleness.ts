// Whether a row is still vouching for the numbers printed on it. Stale is not
// "old": a quiet worktree is read only when something happens. Stale is that
// the app tried to confirm and could not; the threshold only lets a blip go by.

import type { WorktreeStatus } from '@shared/entities'
import { sinceLabel } from './agentRows'

/** Long enough that a passing failure never shows; short enough to matter. */
export const STATUS_UNCONFIRMED_AFTER_MS = 30_000

export type StatusStaleness = {
  /** How old the numbers on screen are, rounded down, as the pane rows do it. */
  age: string
  /** The full sentence, for the title and for a screen reader. */
  detail: string
}

export function statusStaleness(options: {
  status: WorktreeStatus | undefined
  /** When reads for this worktree began failing, if they are still failing. */
  unreadableSince: number | undefined
  now: number
}): StatusStaleness | null {
  const { status, unreadableSince, now } = options
  // Nothing has ever been read, so there is nothing on screen to qualify.
  if (!status || unreadableSince === undefined) return null
  if (now - unreadableSince < STATUS_UNCONFIRMED_AFTER_MS) return null

  const age = sinceLabel(Math.max(0, now - status.readAt))
  return {
    age,
    detail: `Could not read this worktree. These are what it last said, ${age} ago.`
  }
}
