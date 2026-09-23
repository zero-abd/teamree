import { describe, expect, it } from 'vitest'
import { sinceLabel } from './agentRows'
import { TEAMMATE_AWAY_AFTER_MS, teammateStaleness } from './teammateStaleness'

const NOW = 1_700_000_000_000

const away = (heardAgoMs: number): ReturnType<typeof teammateStaleness> =>
  teammateStaleness({ live: false, heardAt: NOW - heardAgoMs, handle: 'bob', now: NOW })

describe('a row that is remembered rather than watched', () => {
  it('says nothing at all while the link is live, however old the picture is', () => {
    expect(teammateStaleness({ live: true, heardAt: NOW - 86_400_000, handle: 'bob', now: NOW })).toBeNull()
  })

  it('lets a reconnection go by unremarked rather than blinking a badge at every one', () => {
    expect(away(TEAMMATE_AWAY_AFTER_MS - 1)).toBeNull()
    expect(away(TEAMMATE_AWAY_AFTER_MS)).not.toBeNull()
  })

  it('rounds the age down, so a row never flatters how long a teammate has been away', () => {
    // The same rule every other age in this sidebar is written by.
    expect(away(299_000)?.age).toBe('4m')
    expect(away(299_000)?.age).toBe(sinceLabel(299_000))
    expect(away(86_399_000)?.age).toBe('23h')
  })

  it('says whose machine is away, and nothing whatever about the worktree', () => {
    const stale = away(600_000)
    expect(stale?.detail).toBe('bob’s machine is not connected. This is what they were showing 10m ago.')
    // A worktree that is gone is a row not on screen at all; the two must not read alike.
    expect(stale?.detail).not.toMatch(/delet|remov|gone/i)
  })

  it('says which fact its number is the age of, because it is the picture and not the absence', () => {
    // `heardAt` moves when a teammate's snapshot changes, not on contact, so a
    // colleague static for an hour arrives here at an hour the instant their
    // link drops; `away · 1h` read as an hour of absence.
    const stale = away(3_600_000)
    expect(stale?.age).toBe('1h')
    expect(stale?.badge).toBe('away · picture 1h old')
    // The machine is away; a badge that dropped the word would leave that to a dashed border.
    expect(stale?.badge).toContain('away')
  })

  it('never reads a clock ahead of this one as time already elapsed', () => {
    expect(teammateStaleness({ live: false, heardAt: NOW + 60_000, handle: 'bob', now: NOW })).toBeNull()
  })
})
