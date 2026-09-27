// The palette's pins.

import { describe, expect, it } from 'vitest'
import { declarationOf, ruleFor } from './css'

describe('palette.css', () => {
  it('fills the selected row with the selected surface', () => {
    expect(declarationOf(ruleFor('palette.css', '.palette__row--selected'), 'background')).toBe('var(--bg-selected)')
  })
})
