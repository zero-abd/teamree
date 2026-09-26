import { describe, expect, it } from 'vitest'
import { costOf, emptyTokens, priceKey, priceOf, type ModelTokens } from './prices'

describe('priceKey', () => {
  it('finds the listed model under a date, a provider prefix, a version or a context tag', () => {
    expect(priceKey('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5')
    expect(priceKey('us.anthropic.claude-opus-4-1-20250805-v1:0')).toBe('claude-opus-4-1')
    expect(priceKey('claude-opus-4-6[1m]')).toBe('claude-opus-4-6')
    expect(priceKey('claude-haiku-4-5@20251001')).toBe('claude-haiku-4-5')
    expect(priceKey('gpt-5-2025-08-07')).toBe('gpt-5')
  })

  it('never prices one model as another that shares its start', () => {
    expect(priceOf('claude-opus-4-9')).toBeNull()
    expect(priceOf('gpt-5-mini')?.input).toBe(0.25)
    expect(priceOf('gpt-5')?.input).toBe(1.25)
  })
})

describe('costOf', () => {
  it('sums every model, and is null when any tokens are unpriced', () => {
    const priced: ModelTokens = new Map([
      ['claude-opus-4-6', { ...emptyTokens(), input: 1e6, output: 1e6 }],
      ['gpt-5-codex', { ...emptyTokens(), cacheRead: 1e6 }]
    ])
    expect(costOf(priced)).toBeCloseTo(5 + 25 + 0.125, 10)
    priced.set('', { ...emptyTokens(), output: 1 })
    expect(costOf(priced)).toBeNull()
  })
})
