// The status rail's pins: its ground, and no setup ask in it.

import { describe, expect, it } from 'vitest'
import { declarationOf, findRule, ruleFor } from './css'

const SHEET = 'statusbar.css'

describe('statusbar.css', () => {
  it('paints the status bar on the rail', () => {
    expect(declarationOf(ruleFor(SHEET, '.statusbar'), 'background')).toBe('var(--bg-rail)')
  })

  // Its questions carry buttons, and the rail carries none.
  it('holds no setup ask, and sits under any dialog', () => {
    expect(findRule(SHEET, '.setup-ask')).toBeUndefined()
    expect(declarationOf(ruleFor(SHEET, '.statusbar'), 'z-index')).toBeUndefined()
  })
})
