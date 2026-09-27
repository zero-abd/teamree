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

  it('sets the wordmark at the page size and the tile at 84', () => {
    expect(declarationOf(ruleFor(SHEET, '.welcome__wordmark'), 'font-size')).toBe('var(--text-2xl)')
    expect(declarationOf(ruleFor(SHEET, '.welcome__tile'), 'width')).toBe('84px')
  })

  // Setup… is reachable from Help and the palette; on the welcome it arrives with the pointer.
  it('keeps Setup… out of the status line at rest', () => {
    expect(declarationOf(ruleFor(SHEET, '.welcome__status .button'), 'opacity')).toBe('var(--row-action-rest)')
  })
})
