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
    // The same rule every other age in this sidebar is written by, on purpose:
    // two vocabularies for "I am not sure" is one too many.
    expect(away(299_000)?.age).toBe('4m')
    expect(away(299_000)?.age).toBe(sinceLabel(299_000))
    expect(away(86_399_000)?.age).toBe('23h')
  })

  it('says whose machine is away, and nothing whatever about the worktree', () => {
    const stale = away(600_000)
    expect(stale?.detail).toBe('bob’s machine is not connected. This is what they were showing 10m ago.')
    // The word this must never come near. A worktree that is gone is a row that
    // is not on screen at all, and the two cannot be allowed to read alike.
    expect(stale?.detail).not.toMatch(/delet|remov|gone/i)
  })

  it('never reads a clock ahead of this one as time already elapsed', () => {
    expect(teammateStaleness({ live: false, heardAt: NOW + 60_000, handle: 'bob', now: NOW })).toBeNull()
  })
})
