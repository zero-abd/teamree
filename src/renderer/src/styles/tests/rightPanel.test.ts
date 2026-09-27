// The right panel's pins: its ground, its closed rail, and the narrow window that lays it over the panes.

import postcss from 'postcss'
import { describe, expect, it } from 'vitest'
import { PANEL_OVERLAY_QUERY } from '../../workspace/roomForPanes'
import { declarationOf, findRule, ruleFor, ruleListing } from './css'

const SHEET = 'rightPanel.css'

describe('rightPanel.css', () => {
  it('paints the panel in its own ground', () => {
    expect(declarationOf(ruleFor(SHEET, '.panel'), 'background')).toBe('var(--bg-panel)')
  })

  it.each(['.panel__tab--current', '.search__hit--current'])(
    'fills the selected row %s with the selected surface',
    (selector) => {
      expect(declarationOf(ruleFor(SHEET, selector), 'background')).toBe('var(--bg-selected)')
    }
  )

  it('keeps a file tree row’s reveal out of sight until its row is hovered or focused', () => {
    expect(declarationOf(ruleFor(SHEET, '.tree__reveal'), 'opacity')).toBe('var(--row-action-rest)')
    for (const shown of ['.tree__item:hover .tree__reveal', '.tree__item:focus-within .tree__reveal']) {
      const rule = ruleListing(SHEET, shown)
      expect(rule && declarationOf(rule, 'opacity'), shown).toBe('1')
    }
  })

  it('keeps the Changes header one height in every state', () => {
    const head = ruleFor(SHEET, '.changes__head')
    expect(declarationOf(head, 'height')).toBe('38px')
    expect(declarationOf(head, 'flex-wrap')).toBeUndefined()
    // A failed push is a line of its own under the header, not squeezed into it.
    expect(findRule(SHEET, '.changes__pushError')).toBeUndefined()
    expect(declarationOf(ruleFor(SHEET, '.changes__pushFailed'), 'flex')).toBe('none')
  })

  it('draws a conflicting overlap in the danger tone', () => {
    expect(declarationOf(ruleFor(SHEET, '.changes__overlap--conflict'), 'color')).toBe('var(--danger)')
  })

  it('marks a folder holding changes in the file letter’s ink', () => {
    expect(declarationOf(ruleFor(SHEET, '.tree__under'), 'background')).toBe(
      declarationOf(ruleFor('changes.css', '.change__kind'), 'color')
    )
  })

  it('draws a pull request’s checks red, green or ink, never amber', () => {
    expect(declarationOf(ruleFor(SHEET, '.prcheck--fail'), 'color')).toBe('var(--danger)')
    expect(declarationOf(ruleFor(SHEET, '.prcheck--pass'), 'color')).toBe('var(--success)')
    expect(declarationOf(ruleFor(SHEET, '.prcheck--pending'), 'color')).toBe('var(--fg-secondary)')
  })

  // Closed, the panel is a 30px strip with a 1px border; a count on its edge was clipped.
  it('keeps a closed rail’s counts at least 2px inside the rail', () => {
    const px = (value: string | undefined): number => Number.parseFloat(value ?? 'NaN')
    const inner = px(declarationOf(ruleFor(SHEET, '.panel--closed'), 'width')) - 1
    const tab = px(declarationOf(ruleFor(SHEET, '.panel__rail--edge .panel__tab'), 'width'))
    expect((inner - tab) / 2).toBeGreaterThanOrEqual(2)
  })

  // Over the glyph's corner, the pill covered the icon and the digit sat above the pill.
  it('stacks a closed rail’s count under its glyph, the digit centred in the pill', () => {
    const tab = ruleFor(SHEET, '.panel__rail--edge .panel__tab')
    const count = ruleFor(SHEET, '.panel__rail--edge .panel__count')
    expect(declarationOf(tab, 'flex-direction')).toBe('column')
    expect(declarationOf(count, 'position')).toBeUndefined()
    expect(declarationOf(count, 'line-height')).toBe(declarationOf(count, 'height'))
  })

  it('keeps the closed rail’s width for the panes when a narrow window lays the panel over them', () => {
    const kept = ruleFor(SHEET, '.workspace__body:has(> .panel:not(.panel--closed))')
    expect(declarationOf(kept, 'padding-right')).toBe(declarationOf(ruleFor(SHEET, '.panel--closed'), 'width'))
  })

  // At 1024 px a 340 px column left the agent 38 columns; a narrow window lays the panel over the panes.
  it('lays the open right panel over the panes in a narrow window, like the Appearance sheet', () => {
    const narrow = (selector: string): postcss.Rule => {
      const rule = ruleFor(SHEET, selector)
      expect((rule.parent as postcss.AtRule | undefined)?.params, selector).toBe(PANEL_OVERLAY_QUERY)
      return rule
    }
    const panel = narrow('.panel:not(.panel--closed)')
    expect(declarationOf(panel, 'position')).toBe('absolute')
    expect(declarationOf(panel, 'right')).toBe('0')
    expect(declarationOf(panel, 'box-shadow')).toBe('var(--shadow-pop)')
    expect(declarationOf(narrow('.panel__resizer'), 'display')).toBe('none')
    expect(declarationOf(narrow('.workspace__body'), 'position')).toBe('relative')
  })
})
