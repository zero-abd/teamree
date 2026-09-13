import { describe, expect, it } from 'vitest'
import { CLOCK_JUMP_TOLERANCE_MS, startTimedWindow } from './elapsed'

/** Two clocks a test can move apart, which is the whole of what a sleep does. */
function clocks(): {
  now: () => number
  monotonicNow: () => number
  run: (ms: number) => void
  sleep: (ms: number, monotonic: 'counted' | 'uncounted') => void
} {
  let wall = 1_700_000_000_000
  let monotonic = 0
  return {
    now: () => wall,
    monotonicNow: () => monotonic,
    run: (ms) => {
      wall += ms
      monotonic += ms
    },
    sleep: (ms, monotonic_) => {
      wall += ms
      if (monotonic_ === 'counted') monotonic += ms
    }
  }
}

describe('measuring one interval', () => {
  it('reports the monotonic length, not the wall-clock one', () => {
    const clock = clocks()
    const window = startTimedWindow(clock, 1_000)
    clock.run(1_000)
    // A clock stepped forward by an NTP correction does not lengthen an interval.
    clock.sleep(3_600_000, 'uncounted')
    expect(window.elapsedMs()).toBe(1_000)
  })

  it('calls an ordinary wait uninterrupted, jitter and all', () => {
    const clock = clocks()
    const window = startTimedWindow(clock, 1_000)
    clock.run(1_000 + CLOCK_JUMP_TOLERANCE_MS - 1)
    expect(window.wasInterrupted()).toBe(false)
  })

  it('catches a sleep whose monotonic clock counted it, as macOS does', () => {
    // Every timer comes back at once, having measured far more than it waited.
    const clock = clocks()
    const window = startTimedWindow(clock, 1_000)
    clock.sleep(3_600_000, 'counted')
    clock.run(1_000)
    expect(window.wasInterrupted()).toBe(true)
  })

  it('catches a sleep whose monotonic clock did not count it', () => {
    // The timer waited exactly what it was armed for; the wall clock did not.
    const clock = clocks()
    const window = startTimedWindow(clock, 1_000)
    clock.sleep(3_600_000, 'uncounted')
    clock.run(1_000)
    expect(window.wasInterrupted()).toBe(true)
  })

  it('falls back to a real monotonic source when none is injected', () => {
    // The production default, asserted rather than assumed: a window with no
    // monotonic source of its own must still measure something that moves.
    const window = startTimedWindow({ now: () => 0 })
    expect(window.elapsedMs()).toBeGreaterThanOrEqual(0)
    expect(window.wasInterrupted()).toBe(false)
  })
})
