import { describe, expect, it } from 'vitest'
import { markerLabel, markerText, markerTime } from './paneMarker'

describe('a pane marker', () => {
  it('is its label between two rules, and reads back as that label', () => {
    expect(markerText('Restored · 11:07')).toBe('── Restored · 11:07 ──')
    expect(markerLabel('── Restored · 11:07 ──')).toBe('Restored · 11:07')
    expect(markerLabel('── Ended 11:04 · ^C ──   ')).toBe('Ended 11:04 · ^C')
  })

  it('is not any line that merely starts with a rule', () => {
    expect(markerLabel('── Restored')).toBeNull()
    expect(markerLabel('[end of record — new shell below]')).toBeNull()
    expect(markerLabel('──────')).toBeNull()
  })

  it('says the time alone the same day, and the day with it after', () => {
    const now = new Date(2026, 8, 27, 12, 30).getTime()
    expect(markerTime(new Date(2026, 8, 27, 9, 5).getTime(), now)).toBe('09:05')
    expect(markerTime(new Date(2026, 8, 23, 11, 40).getTime(), now)).toBe('Sep 23 11:40')
  })
})
