// The markdown page's pins.

import { describe, expect, it } from 'vitest'
import { declarationOf, ruleFor } from './css'

const SHEET = 'markdown.css'

describe('markdown.css', () => {
  // Red on pink read as the failed tone; inline code is text on the raised ground, like a code block.
  it('draws inline code in a markdown page in neutral ink', () => {
    const rule = ruleFor(SHEET, '.md-editor code')
    expect(declarationOf(rule, 'color')).toBe('var(--fg)')
    expect(declarationOf(rule, 'background')).toBe('var(--bg-raised)')
  })

  // A 52px gutter left 266px of text in a 370px column.
  it('narrows the page gutter with its column', () => {
    const gutter = declarationOf(ruleFor(SHEET, '.md-editor'), '--page-gutter') ?? ''
    const at = (width: number): number => {
      const parts = /^clamp\((\d+)px, ([\d.]+)cqi - ([\d.]+)px, (\d+)px\)$/.exec(gutter)
      expect(parts, `--page-gutter: ${gutter}`).not.toBeNull()
      const [low, per, less, high] = parts!.slice(1).map(Number) as [number, number, number, number]
      return Math.min(high, Math.max(low, (per * width) / 100 - less))
    }
    expect(at(370)).toBeLessThanOrEqual(16)
    expect(at(479)).toBeLessThanOrEqual(16)
    expect(at(760)).toBeCloseTo(52, 0)
    expect(at(600)).toBeLessThan(52)
  })

  // The editor's own `pre-wrap` split a one-line import in two.
  it('scrolls a code block sideways rather than wrapping it', () => {
    expect(declarationOf(ruleFor(SHEET, '.md-editor .md-code pre'), 'white-space')).toBe('pre')
    expect(declarationOf(ruleFor(SHEET, '.md-code pre'), 'overflow-x')).toBe('auto')
  })
})
