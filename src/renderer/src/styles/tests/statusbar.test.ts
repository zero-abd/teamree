// The status rail's pins: its ground, and the setup ask that lives in it.

import { describe, expect, it } from 'vitest'
import { declarationOf, ruleFor } from './css'

const SHEET = 'statusbar.css'

describe('statusbar.css', () => {
  it('paints the status bar on the rail', () => {
    expect(declarationOf(ruleFor(SHEET, '.statusbar'), 'background')).toBe('var(--bg-rail)')
  })

  // A row across the panes refit them; a floating card covered the prompt line and sat over the scrim.
  it('asks for the setup command in the status rail, under any dialog', () => {
    const ask = ruleFor(SHEET, '.setup-ask')
    expect(declarationOf(ask, 'position')).toBeUndefined()
    expect(declarationOf(ask, 'box-shadow')).toBeUndefined()
    expect(declarationOf(ask, 'min-width')).toBe('0')
    expect(declarationOf(ruleFor(SHEET, '.statusbar'), 'z-index')).toBeUndefined()
  })
})
