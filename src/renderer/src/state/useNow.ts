// A clock that ticks on its own.
//
// "no output for 4m" is the one number in this app that changes when nothing
// happens: the workspace stream says a pane started or stopped talking, and
// then says nothing more, because more time passing is not an event. Anything
// rendering a silence has to re-render itself.

import { useEffect, useState } from 'react'

/** Slow enough to cost nothing, fast enough that the number is never a lie. */
export const CLOCK_INTERVAL_MS = 5_000

export function useNow(intervalMs: number = CLOCK_INTERVAL_MS): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])

  return now
}
