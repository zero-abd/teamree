// The panes' pins: flush panes on one ground, their dividers and the terminal surface.

import { describe, expect, it } from 'vitest'
import { GUTTER_PX } from '../../panes/paneLayout'
import { declarationOf, opacitiesOf, parse, ruleFor } from './css'

const SHEET = 'panes.css'

describe('panes.css', () => {
  it.each([
    ['.pane', 'var(--bg-pane)'],
    ['.pane--terminal', 'var(--term-bg)']
  ])('paints %s in %s', (selector, token) => {
    expect(declarationOf(ruleFor(SHEET, selector), 'background')).toBe(token)
  })

  // Panes sit edge to edge, split by one hairline; the tab strip names them, so they carry no card or title.
  it('draws no card, corner or gutter round a pane or a group of tabs', () => {
    for (const selector of ['.pane', '.group']) {
      const rule = ruleFor(SHEET, selector)
      expect(declarationOf(rule, 'border'), selector).toBeUndefined()
      expect(declarationOf(rule, 'border-radius'), selector).toBeUndefined()
    }
    expect(declarationOf(ruleFor('workspace.css', '.workspace__panes'), 'padding')).toBeUndefined()
  })

  it('divides panes with a 1px line on a handle at least 6px wide', () => {
    expect(declarationOf(ruleFor(SHEET, '.gutter--row::before'), 'width')).toBe('1px')
    expect(declarationOf(ruleFor(SHEET, '.gutter--column::before'), 'height')).toBe('1px')
    const reach = (selector: string, prop: string): number =>
      -Number.parseFloat(declarationOf(ruleFor(SHEET, selector), prop) ?? '0')
    expect(GUTTER_PX + 2 * reach('.gutter--row::after', 'left')).toBeGreaterThanOrEqual(6)
    expect(reach('.gutter--row::after', 'left')).toBe(reach('.gutter--row::after', 'right'))
    expect(GUTTER_PX + 2 * reach('.gutter--column::after', 'top')).toBeGreaterThanOrEqual(6)
    expect(reach('.gutter--column::after', 'top')).toBe(reach('.gutter--column::after', 'bottom'))
    // Above the panes either side, or their text layers take the pointer first.
    expect(Number(declarationOf(ruleFor(SHEET, '.gutter'), 'z-index'))).toBeGreaterThan(11)
  })

  // Under border-box the addon counted the padding as room and printed past the slider.
  it('hands the fit addon a text box without the surface’s padding', () => {
    expect(declarationOf(ruleFor(SHEET, '.terminal-surface'), 'box-sizing')).toBe('content-box')
  })

  it('draws the terminal’s scrollbar as a rounded slider', () => {
    expect(declarationOf(ruleFor(SHEET, '.terminal-surface .xterm .scrollbar > .slider'), 'border-radius')).toBe('99px')
  })

  // Most people never hover, so a control drawn only under the pointer is one they never find.
  it('draws a pane’s close faintly at rest, not invisibly', () => {
    expect(opacitiesOf(SHEET, '.pane__close')).toEqual(['var(--control-rest)'])
  })

  // Forced to `display: flex !important`, a marker's rule stayed where it was drawn once its line scrolled off.
  it('leaves a marker rule’s display to xterm, which hides it off the screen', () => {
    parse(SHEET).walkRules((rule) => {
      if (!/pane-marker|xterm-decoration/.test(rule.selector)) return
      rule.walkDecls('display', (decl) => expect(decl.important ?? false, rule.selector).toBe(false))
    })
    expect(declarationOf(ruleFor(SHEET, '.pane-marker-row'), 'pointer-events')).toBe('none')
  })
})
