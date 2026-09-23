// Elapsed time, measured so this machine falling asleep cannot be read as a
// teammate going quiet. macOS's monotonic clock counts time suspended and
// others do not, so both the wall and monotonic readings are checked.

/**
 * How far a reading may be out before it is an interruption rather than noise:
 * far above scheduler jitter and NTP slew, far below every deadline that reads it.
 */
export const CLOCK_JUMP_TOLERANCE_MS = 30_000

/** The two clocks, as one injectable seam. */
export type ElapsedClock = {
  /** The wall clock: what timestamps are kept in, and what a sleep moves. */
  now: () => number
  /** A clock nothing outside this process can set. Defaults to `performance.now()`. */
  monotonicNow?: () => number
}

export type TimedWindow = {
  /** How long the window has been open, on the monotonic clock. */
  elapsedMs: () => number
  /** Whether this process stopped running inside the window; if so nothing measured says anything about a peer. */
  wasInterrupted: () => boolean
}

/**
 * Starts measuring one interval. `armedForMs` is what a timer covering this
 * window was asked to wait, so a one-shot that comes back far later can say so.
 */
export function startTimedWindow(clock: ElapsedClock, armedForMs = 0): TimedWindow {
  const monotonicNow = clock.monotonicNow ?? defaultMonotonicNow
  const startedWall = clock.now()
  const startedMonotonic = monotonicNow()

  const elapsedMs = (): number => monotonicNow() - startedMonotonic

  return {
    elapsedMs,
    wasInterrupted: () => {
      const monotonic = elapsedMs()
      const wall = clock.now() - startedWall
      return monotonic - armedForMs >= CLOCK_JUMP_TOLERANCE_MS || Math.abs(wall - monotonic) >= CLOCK_JUMP_TOLERANCE_MS
    }
  }
}

/** The default monotonic source, in one place so the fallback is not repeated. */
export const defaultMonotonicNow = (): number => performance.now()
