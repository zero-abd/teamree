// Whether a teammate's row is a live view or a remembered one. Sits beside `statusStaleness.ts`
// and says doubt the same way: the age, rounded down by `sinceLabel` so a row never flatters a
// silence, and one sentence.

import { sinceLabel } from './agentRows'

/**
 * Grace before a dropped link marks its rows: reconnection is ordinary, and a badge blinking on each
 * would train a reader to ignore it. Display only; the row carries `live` regardless.
 */
export const TEAMMATE_AWAY_AFTER_MS = 15_000

export type TeammateStaleness = {
  /** How old the picture is, rounded down, as every other row here does it. */
  age: string
  /** The whole sentence, for the title and for a screen reader. */
  detail: string
}

export function teammateStaleness(options: {
  /** Whether the link behind this row is connected and confirmed right now. */
  live: boolean
  /** This machine's clock when the snapshot arrived. Never the sender's. */
  heardAt: number
  handle: string
  now: number
}): TeammateStaleness | null {
  const { live, heardAt, handle, now } = options
  if (live) return null

  const awayFor = Math.max(0, now - heardAt)
  if (awayFor < TEAMMATE_AWAY_AFTER_MS) return null

  const age = sinceLabel(awayFor)
  return {
    age,
    // Only that the machine is not reachable, never anything about the worktree: a worktree that
    // has gone is a row that is not here at all.
    detail: `${handle}’s machine is not connected · showing what it had ${age} ago`
  }
}
