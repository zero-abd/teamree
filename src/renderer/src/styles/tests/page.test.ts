// The page frame's pins: one head and one column for Settings, Help, Teamwork and All Panes.

import { describe, expect, it } from 'vitest'
import { declarationOf, keyframeFrom, ruleFor } from './css'

const SHEET = 'page.css'

describe('page.css', () => {
  it('measures the head and the body with one column', () => {
    const column = ruleFor(SHEET, '.page__column')
    expect(declarationOf(column, 'max-width')).toBeDefined()
    expect(declarationOf(column, 'margin')).toBe('0 auto')
    const head = declarationOf(ruleFor(SHEET, '.page__head'), 'padding')
    const body = declarationOf(ruleFor(SHEET, '.page__body'), 'padding')
    expect(head?.split(' ')[1]).toBe(body?.split(' ')[1])
  })

  it('titles a page at 26/32, bold, with a 32px icon tile and a 28px close', () => {
    const title = ruleFor(SHEET, '.page__title')
    expect(declarationOf(title, 'font-size')).toBe('var(--text-2xl)')
    expect(declarationOf(title, 'line-height')).toBe('32px')
    expect(declarationOf(title, 'font-weight')).toBe('700')
    expect(declarationOf(ruleFor(SHEET, '.page__tile'), 'width')).toBe('32px')
    expect(declarationOf(ruleFor(SHEET, '.page__close'), 'width')).toBe('28px')
    expect(declarationOf(ruleFor(SHEET, '.page__lede'), 'color')).toBe('var(--fg-muted)')
  })

  // A page is a `.workspace` too; it arrives from the right over the slow enter curve.
  it('slides a page in 12px over 280ms', () => {
    const animation = declarationOf(ruleFor(SHEET, '.page'), 'animation') ?? ''
    expect(animation).toContain('var(--motion-slow)')
    expect(animation).toContain('var(--ease-enter)')
    const from = keyframeFrom(SHEET, animation.split(' ')[0] ?? '')
    expect(declarationOf(from, 'transform')).toBe('translateX(12px)')
    expect(declarationOf(from, 'opacity')).toBe('0')
  })
})
