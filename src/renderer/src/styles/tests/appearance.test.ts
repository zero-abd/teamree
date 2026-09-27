// The Appearance sheet's pins.

import { describe, expect, it } from 'vitest'
import { declarationOf, keyframeFrom, ruleFor } from './css'

const SHEET = 'appearance.css'

describe('appearance.css', () => {
  // The chosen swatch's ring is 4px wide; with no room above it, it cut into the Accent label.
  it('leaves the accent swatches room for their selection ring', () => {
    expect(declarationOf(ruleFor(SHEET, '.appearance__legend'), 'margin-bottom')).toBe('var(--s2)')
    expect(declarationOf(ruleFor(SHEET, '.appearance__accents'), 'padding-block')).toBe('4px')
  })

  it('slides the Appearance sheet in from the right', () => {
    const animation = declarationOf(ruleFor(SHEET, '.appearance-sheet'), 'animation') ?? ''
    expect(animation).toContain('var(--motion-base)')
    const from = keyframeFrom(SHEET, animation.split(' ')[0] ?? '')
    expect(declarationOf(from, 'transform')).toBe('translateX(100%)')
    expect(declarationOf(from, 'opacity')).toBe('0')
  })
})
