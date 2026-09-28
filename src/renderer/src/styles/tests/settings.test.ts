// Settings' pins.

import { describe, expect, it } from 'vitest'
import type postcss from 'postcss'
import { declarationOf, findRule, parse, ruleFor } from './css'

describe('settings.css', () => {
  it('draws no head, close or column of its own; the page frame does', () => {
    for (const selector of ['.settings__head', '.settings__close', '.settings__column']) {
      expect(findRule('settings.css', selector), selector).toBeUndefined()
    }
  })

  it('leaves the switch to the shared layer', () => {
    expect(findRule('settings.css', '.switch')).toBeUndefined()
  })

  // Settings owns the window; the status bar describes panes it has covered.
  it('covers the status bar while it is open', () => {
    expect(declarationOf(ruleFor('settings.css', '.shell:has(.settings-side) > .statusbar'), 'display')).toBe('none')
  })

  it('draws rows 52 high with fields at 240 or 320 wide', () => {
    expect(declarationOf(ruleFor('settings.css', '.settings-field'), 'min-height')).toBe('52px')
    const widths = [
      '.settings-field__control > .select,\n.settings-field__control > .settings-input:not(.settings-input--number),\n.settings-field__control > .settings-stack',
      '.settings-field__control > .settings-input--command,\n.settings-field__control > .settings-input--lines'
    ].map((selector) => declarationOf(ruleFor('settings.css', selector), 'width'))
    expect(widths).toEqual(['240px', '320px'])
  })

  it('lists the sections in a 248px column of 30px rows, the current one on an accent edge', () => {
    // The wide window's rules, not the narrow one's under its media query.
    const wide = (selector: string): postcss.Rule =>
      parse('settings.css').nodes.find(
        (node): node is postcss.Rule => node.type === 'rule' && node.selector === selector
      ) as postcss.Rule
    expect(declarationOf(wide('.settings-side'), 'width')).toBe('248px')
    expect(declarationOf(wide('.settings-nav__item'), 'height')).toBe('30px')
    expect(declarationOf(wide(".settings-nav__item[aria-current='true']"), 'box-shadow')).toBe(
      'inset 2px 0 var(--accent)'
    )
  })
})
