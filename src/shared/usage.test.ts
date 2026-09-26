import { describe, expect, it } from 'vitest'
import type { UsageTotals } from './tasks'
import { formatCost, formatTokens, totalTokens, usageDetail, usageLabel, usageLines } from './usage'

const totals = (partial: Partial<UsageTotals>): UsageTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: null,
  sessions: 1,
  ...partial
})

describe('formatTokens', () => {
  it('is terse at every size', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(1_200)).toBe('1.2k')
    expect(formatTokens(12_345)).toBe('12k')
    expect(formatTokens(999_999)).toBe('1.0M')
    expect(formatTokens(1_234_567)).toBe('1.2M')
    expect(formatTokens(45_600_000)).toBe('46M')
    expect(formatTokens(2_100_000_000)).toBe('2.1B')
  })
})

describe('formatCost', () => {
  it('rounds to cents, and says so below one', () => {
    expect(formatCost(3.104)).toBe('$3.10')
    expect(formatCost(0.004)).toBe('<$0.01')
    expect(formatCost(0)).toBe('$0.00')
    expect(formatCost(1234.5)).toBe('$1,235')
  })
})

describe('usageLabel', () => {
  it('counts every token, cache included', () => {
    expect(totalTokens(totals({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }))).toBe(10)
  })

  it('shows tokens only while Show Cost is off', () => {
    const usage = totals({ input: 200_000, output: 1_000_000, costUsd: 3.1 })
    expect(usageLabel(usage, false)).toBe('1.2M tok')
    expect(usageLabel(usage, true)).toBe('1.2M tok · ≈$3.10')
  })

  it('keeps tokens and drops the cost of an unpriced model', () => {
    expect(usageLabel(totals({ output: 5_000, costUsd: null }), true)).toBe('5.0k tok')
  })

  it('marks a lower bound when some panes could not be read', () => {
    expect(usageLabel({ ...totals({ output: 5_000 }), unknownPanes: 1 }, false)).toBe('≥5.0k tok')
    expect(usageLabel({ ...totals({ sessions: 0 }), unknownPanes: 2 }, false)).toBe('? tok')
  })

  it('is null with nothing to say', () => {
    expect(usageLabel(totals({ sessions: 0 }), true)).toBeNull()
  })
})

describe('usageLines', () => {
  const read = { worktreeId: 'w1', unknownPanes: 0, readAt: 1 }
  it('gives a parent its own line and its subtree’s', () => {
    const usage = { ...read, ...totals({ output: 1_200 }), subtree: totals({ output: 3_400, sessions: 2 }) }
    expect(usageLines(usage, false)).toEqual(['1.2k tok', '3.4k tok with children'])
    expect(usageLines({ ...usage, ...totals({ sessions: 0 }) }, false)).toEqual(['0 tok', '3.4k tok with children'])
  })

  it('is null before a read and with nothing spent', () => {
    expect(usageLines(undefined, false)).toBeNull()
    expect(usageLines({ ...read, ...totals({ sessions: 0 }) }, false)).toBeNull()
  })

  it('spells out every kind for a hover', () => {
    expect(usageDetail(totals({ input: 13, output: 12, cacheRead: 1000, cacheWrite: 600 }))).toBe(
      'in 13 · out 12 · cache read 1.0k · cache write 600'
    )
  })
})
