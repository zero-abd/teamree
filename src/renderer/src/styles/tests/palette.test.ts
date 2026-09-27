// The palette's pins.

import { describe, expect, it } from 'vitest'
import { declarationOf, ruleFor } from './css'

describe('palette.css', () => {
  it('fills the selected row with the selected surface', () => {
    expect(declarationOf(ruleFor('palette.css', '.palette__row--selected'), 'background')).toBe('var(--bg-selected)')
  })

  it('floats 600 wide, its field borderless at the heading size', () => {
    expect(declarationOf(ruleFor('palette.css', '.modal:has(.palette)'), 'width')).toBe('min(600px, calc(100vw - 48px))')
    const input = ruleFor('palette.css', '.palette__input')
    expect(declarationOf(input, 'border')).toBe('0')
    expect(declarationOf(input, 'font-size')).toBe('var(--text-lg)')
    expect(declarationOf(input, 'height')).toBe('48px')
  })

  it('rows are 40 high and mark what matched in accent ink', () => {
    expect(declarationOf(ruleFor('palette.css', '.palette__row'), 'min-height')).toBe('40px')
    const match = ruleFor('palette.css', '.palette__match')
    expect(declarationOf(match, 'color')).toBe('var(--accent-bright)')
    expect(declarationOf(match, 'font-weight')).toBe('600')
    expect(declarationOf(ruleFor('palette.css', '.palette__footer'), 'height')).toBe('32px')
  })

  it('opens from 8px above at the enter curve', () => {
    expect(declarationOf(ruleFor('palette.css', '.modal:has(.palette)'), 'animation')).toBe(
      'palette-in var(--motion-base) var(--ease-enter)'
    )
  })
})
