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
    expect(stale?.detail).toBe('bob’s machine is not connected · showing what it had 10m ago')
    // A worktree that is gone is a row not on screen at all; the two must not read alike.
    expect(stale?.detail).not.toMatch(/delet|remov|gone/i)
  })

  it('rounds the age of the picture down', () => {
    expect(away(3_600_000)?.age).toBe('1h')
  })

  it('never reads a clock ahead of this one as time already elapsed', () => {
    expect(teammateStaleness({ live: false, heardAt: NOW + 60_000, handle: 'bob', now: NOW })).toBeNull()
  })
})
