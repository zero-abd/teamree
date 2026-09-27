// The pane strip's pins: one row, one height, and tabs that give way to their names.

import { describe, expect, it } from 'vitest'
import { declarationOf, findRule, opacitiesOf, ruleFor } from './css'

const SHEET = 'workspace.css'

describe('workspace.css', () => {
  it.each([
    ['.workspace', 'var(--bg-pane)'],
    ['.workspace__head', 'var(--bg-tabstrip)'],
    ['.tabs', 'var(--bg-tabstrip)'],
    ['.tabs--active', 'var(--bg-tabstrip-active)']
  ])('paints %s in %s', (selector, token) => {
    expect(declarationOf(ruleFor(SHEET, selector), 'background')).toBe(token)
  })

  // One tab was squeezed to its glyph while the others kept their names.
  it('shrinks a pane tab no further than six characters of its name, then cuts the name short', () => {
    expect(declarationOf(ruleFor(SHEET, '.tab'), 'min-width')).toMatch(/\b6ch\b/)
    const name = ruleFor(SHEET, '.tab__name')
    expect(declarationOf(name, 'text-overflow')).toBe('ellipsis')
    expect(declarationOf(name, 'white-space')).toBe('nowrap')
  })

  // The strip has one vertical centre, and the active mark sits on its own bottom edge.
  describe('the tab strip is one row', () => {
    it('centres the tabs, the pane buttons and the sidebar control on one height', () => {
      expect(declarationOf(ruleFor(SHEET, '.tabs'), 'align-items')).toBe('center')
      expect(declarationOf(ruleFor(SHEET, '.tabs__list'), 'align-self')).toBe('stretch')
      expect(declarationOf(ruleFor(SHEET, '.tab'), 'align-items')).toBe('center')
      expect(declarationOf(ruleFor(SHEET, '.tabs__actions'), 'align-self')).toBeUndefined()
    })

    it('makes the head the window’s drag edge, and no strip of tabs', () => {
      expect(declarationOf(ruleFor(SHEET, '.workspace__head'), '-webkit-app-region')).toBe('drag')
      expect(declarationOf(ruleFor(SHEET, '.tabs'), '-webkit-app-region')).toBeUndefined()
    })

    // Every group marks the tab it shows; the one holding the keys in the accent, the rest quietly.
    it('marks the group holding the focus by an accent line under its shown tab, not a frame', () => {
      expect(declarationOf(ruleFor(SHEET, '.tab--active'), 'box-shadow')).toBe('inset 0 -2px 0 var(--line-strong)')
      expect(declarationOf(ruleFor(SHEET, '.tabs--active .tab--active'), 'box-shadow')).toBe(
        'inset 0 -2px 0 var(--accent)'
      )
      expect(findRule('panes.css', '.pane--focused')).toBeUndefined()
      expect(findRule('panes.css', '.group--active')).toBeUndefined()
    })

    it('marks the active tab on the strip’s bottom edge', () => {
      const active = ruleFor(SHEET, '.tab--active')
      expect(declarationOf(active, 'box-shadow')).toMatch(/^inset 0 -2px 0 /)
      expect(declarationOf(ruleFor(SHEET, '.tab'), 'border-bottom')).toBeUndefined()
    })
  })

  // A zoom restarts the fade only if the name changes with it.
  it('fades the panes and a zoom in or out, quickly', () => {
    for (const selector of ['.workspace__panes', '.workspace__panes--zoomed']) {
      expect(declarationOf(ruleFor(SHEET, selector), 'animation'), selector).toMatch(/ var\(--motion-fast\) /)
    }
    const name = (selector: string): string | undefined =>
      declarationOf(ruleFor(SHEET, selector), 'animation')?.split(' ')[0]
    expect(name('.workspace__panes--zoomed')).not.toBe(name('.workspace__panes'))
  })

  it.each(['.tab__rename', '.tab__close'])('draws %s faintly at rest, not invisibly', (selector) => {
    expect(opacitiesOf(SHEET, selector)).toEqual(['var(--control-rest)'])
  })
})
