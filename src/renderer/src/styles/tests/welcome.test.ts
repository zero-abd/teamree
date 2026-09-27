// The front door's pins.

import { describe, expect, it } from 'vitest'
import { declarationOf, ruleFor } from './css'

const SHEET = 'welcome.css'

describe('welcome.css', () => {
  it('centres the welcome and an empty worktree in the whole pane area', () => {
    for (const selector of ['.welcome', '.worktree-start']) {
      expect(declarationOf(ruleFor(SHEET, selector), 'align-self'), selector).toBe('stretch')
    }
  })

  it('names a missing checkout in the danger tone', () => {
    expect(declarationOf(ruleFor(SHEET, '.checkout-missing__label'), 'color')).toBe('var(--danger)')
  })
})
