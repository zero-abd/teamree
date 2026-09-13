// Elapsed time, measured so that this machine falling asleep cannot be read as
// somebody else's machine going quiet.
//
// Every deadline in teamwork is a one-shot that, when it fires, asks how long
// it has been. `Date.now()` cannot answer that across a closing lid: the wall
// clock jumps by the whole sleep, so the deadline fires on wake and the answer
// it computes indicts whoever it was watching. The teammate was fine. This
// machine slept.
//
// What separates the two is that a suspended process leaves a trace on the
// clocks, and platforms split over which trace:
//
//   * where the monotonic source counts time spent suspended — macOS's does —
//     a one-shot armed for five minutes returns having measured an hour, and
//     the two clocks agree;
//   * where it does not, the monotonic reading comes back near what the timer
//     was armed for while the wall clock has run away from it.
//
// So both are checked. Either shape means this process was not running, which
// is a fact about this machine and no evidence whatsoever about another one.

/**
 * How far a reading may be out before it is an interruption rather than noise.
 *
 * Far above scheduler jitter and NTP slew, far below every deadline that reads
 * it. The cost of calling a wedged event loop a sleep is that a healthy link is
 * re-established and liveness is briefly unknown; the cost of the opposite
 * mistake is telling somebody their teammate's machine died. They are not the
 * same size, so the threshold sits where the cheaper mistake is the likelier.
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
  /**
   * Whether this process stopped running inside the window.
   *
   * A suspended machine, a stepped clock, an event loop wedged for half a
   * minute: all of them mean the same thing here, which is that nothing
   * measured across this window says anything about a peer.
   */
  wasInterrupted: () => boolean
}

/**
 * Starts measuring one interval.
 *
 * `armedForMs` is what a timer covering this window was asked to wait — zero
 * for a window nobody is waiting on — so a one-shot that comes back far later
 * than it was armed for can say so.
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
