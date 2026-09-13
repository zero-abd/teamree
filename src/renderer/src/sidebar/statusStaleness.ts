// Whether a row is still vouching for the numbers printed on it.
//
// Staleness here is deliberately not "these numbers are old". A quiet worktree
// is read only when something happens to it, so a status can be an hour old
// with nothing whatever wrong; marking that would put a badge on every row in a
// workspace nobody is touching, which says as much as no badge at all.
//
// What makes a number untrustworthy is that the app tried to confirm it and
// could not. That is a fact rather than an inference, so it needs no threshold
// to establish — the threshold below exists only to let a blip go by unremarked:
// a checkout busy under somebody's own git command, a worktree mid-removal, a
// read that lost a race with a refresh. Past it, the chips are the last thing
// the app managed to read rather than the state of the repository, and the two
// are not the same claim.

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
  // Nothing has ever been read, so there is nothing on screen to qualify. The
  // row says nothing at all, which is already the honest answer.
  if (!status || unreadableSince === undefined) return null
  if (now - unreadableSince < STATUS_UNCONFIRMED_AFTER_MS) return null

  const age = sinceLabel(Math.max(0, now - status.readAt))
  return {
    age,
    detail: `Could not read this worktree. These are what it last said, ${age} ago.`
  }
}
