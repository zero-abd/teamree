// The menu's pins: a floating surface, 32px rows, and chords written as plain text.

import { describe, expect, it } from 'vitest'
import { declarationOf, keyframeFrom, ruleFor } from './css'

const SHEET = 'menu.css'

describe('menu.css', () => {
  it('floats on the elevated ground behind a strong edge, 220px wide', () => {
    const menu = ruleFor(SHEET, '.row-menu')
    expect(declarationOf(menu, 'background')).toBe('var(--bg-elevated)')
    expect(declarationOf(menu, 'border')).toBe('1px solid var(--line-strong)')
    expect(declarationOf(menu, 'border-radius')).toBe('var(--r3)')
    expect(declarationOf(menu, 'min-width')).toBe('220px')
  })

  it('gives every row 32px and a 16px icon slot', () => {
    expect(declarationOf(ruleFor(SHEET, '.row-menu__item'), 'min-height')).toBe('32px')
    expect(declarationOf(ruleFor(SHEET, '.row-menu__icon'), 'width')).toBe('16px')
  })

  // A menu writes its chords as the menu bar does: plain text at the right, no keycaps.
  it('draws a menu chord as plain text', () => {
    const hint = ruleFor(SHEET, '.row-menu__hint')
    expect(declarationOf(hint, 'border')).toBe('0')
    expect(declarationOf(hint, 'background')).toBe('none')
    expect(declarationOf(hint, 'padding')).toBe('0')
  })

  it('opens over 180ms on the enter curve, dropping 4px into place', () => {
    const animation = declarationOf(ruleFor(SHEET, '.row-menu'), 'animation') ?? ''
    expect(animation).toContain('var(--motion-base)')
    expect(animation).toContain('var(--ease-enter)')
    expect(declarationOf(keyframeFrom(SHEET, animation.split(' ')[0] ?? ''), 'transform')).toBe(
      'translateY(-4px) scale(0.98)'
    )
  })
})
