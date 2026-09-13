// Whether a teammate's row is still a live view or a remembered one.
//
// Written to sit beside `statusStaleness.ts` rather than to replace or repeat
// it. The question there is "the app tried to confirm these numbers and could
// not"; the question here is "the machine that produces these numbers is not
// reachable". They are the same shape of doubt about two different things, so
// they say it the same way — the age, rounded down by `sinceLabel`, and one
// sentence — and neither invents a second vocabulary for "I am not sure".
//
// Age is the whole of what a stale row promises. `sinceLabel` rounds *down* on
// purpose, so a row never flatters a silence, and that is exactly the property
// a stale teammate row needs: "4m" while the fifth minute runs is the wrong way
// round for a number whose job is to say this has been sitting there.

import { sinceLabel } from './agentRows'

/**
 * Grace before a dropped link marks its rows.
 *
 * Reconnection is ordinary — a relay restarting, a network changing, the hour's
 * rendezvous turning — and a badge that blinked on every one of them would
 * train a reader to ignore it. Past this, the link has failed to come back
 * rather than merely gone round again. It is a display threshold only: the row
 * carries `live` regardless, and nothing that can act on a pane reads this.
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
    // Says what is actually known — that the machine is not reachable — and
    // never anything about the worktree itself. A worktree that has gone is a
    // row that is not here at all, and the two must not read alike.
    detail: `${handle}’s machine is not connected. This is what they were showing ${age} ago.`
  }
}
