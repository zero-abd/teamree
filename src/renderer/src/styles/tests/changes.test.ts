// The Changes tab's pins: rows that read in grey at rest, file letters in their state's colour, the diff.

import { describe, expect, it } from 'vitest'
import { BUILT_IN_THEMES } from '@shared/theme'
import { contrastRatio, mix } from '@shared/color'
import { declarationOf, paletteOf, parse, rgbOf, ruleFor, ruleListing } from './css'

const SHEET = 'changes.css'

describe('changes.css', () => {
  // Red is for the confirm; a row's Discard is one pointer move from the row being read.
  it('draws a changed file’s Discard and line counts in grey, never red', () => {
    expect(declarationOf(ruleFor(SHEET, '.change__discard'), 'color')).toBe('var(--fg-muted)')
    expect(declarationOf(ruleFor(SHEET, '.change__stat'), 'color')).toBe('var(--fg-secondary)')
  })

  it.each(['.changes__item--selected', '.commit--selected'])(
    'fills the selected row %s with the selected surface',
    (selector) => {
      expect(declarationOf(ruleFor(SHEET, selector), 'background')).toBe('var(--bg-selected)')
    }
  )

  it('keeps a changed file’s icon out of sight until its row is hovered, focused or selected', () => {
    expect(declarationOf(ruleFor(SHEET, '.change__icon'), 'opacity')).toBe('var(--row-action-rest)')
    for (const shown of [
      '.changes__item:hover .change__icon',
      '.changes__item:focus-within .change__icon',
      '.changes__item--selected .change__icon'
    ]) {
      const rule = ruleListing(SHEET, shown)
      expect(rule && declarationOf(rule, 'opacity'), shown).toBe('1')
    }
  })

  // Amber stays the asking agent's, so a modified file is blue.
  it.each([
    ['modified', 'var(--info)'],
    ['renamed', 'var(--info)'],
    ['added', 'var(--success)'],
    ['untracked', 'var(--success)'],
    ['deleted', 'var(--danger)'],
    ['conflicted', 'var(--danger)']
  ])('names a %s file in %s, the colour of its letter', (kind, colour) => {
    const name = ruleListing('rightPanel.css', `.tree__name--${kind}`)
    const letter = ruleListing(SHEET, `.change__kind--${kind}`)
    expect(name && declarationOf(name, 'color')).toBe(colour)
    expect(letter && declarationOf(letter, 'color')).toBe(colour)
  })

  it('sets diff code at 13 px on 20 px lines, in the app’s monospace', () => {
    const patch = ruleFor(SHEET, '.patch')
    expect(declarationOf(patch, 'font-size')).toBe('var(--text-code)')
    expect(declarationOf(patch, 'line-height')).toBe('20px')
    expect(declarationOf(patch, 'font-family')).toBe('var(--font-mono)')
  })

  // A changed word's fill sits on its line's fill, and the line's on the pane every patch is drawn in.
  it.each(BUILT_IN_THEMES.map((theme) => theme.id))(
    'fills changed lines and words so they stand out, and their text still reads, in %s',
    (id) => {
      const palette = paletteOf(id)
      const amountOf = (sheet: string, selector: string): number => {
        const rule = ruleListing(sheet, selector)
        return Number(/(\d+)%/.exec((rule && declarationOf(rule, 'background')) ?? '')?.[1]) / 100
      }
      for (const [tone, side] of [
        ['success', 'added'],
        ['danger', 'removed']
      ] as const) {
        const line = amountOf(SHEET, `.patch__row--${side}`)
        const word = amountOf('review.css', `.patch__row--${side} .patch__word`)
        expect(line, side).toBeGreaterThanOrEqual(0.2)
        expect(word, side).toBeGreaterThanOrEqual(0.35)
        const lineFill = mix(rgbOf(palette['bg-pane']), rgbOf(palette[tone]), line)
        const wordFill = mix(lineFill, rgbOf(palette[tone]), word)
        expect(contrastRatio(rgbOf(palette['fg-secondary']), lineFill), `${side} line`).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(rgbOf(palette.fg), wordFill), `${side} word`).toBeGreaterThanOrEqual(4.5)
      }
    }
  )

  // A ring round the inner button left the checkbox and the counts outside it, inside the selected fill.
  it('rings a focused changed file as the whole row, as thickly as every other control', () => {
    expect(declarationOf(ruleFor(SHEET, '.changes__item .change:focus-visible'), 'outline')).toBe('none')
    expect(declarationOf(ruleFor(SHEET, '.changes__item:has(.change:focus-visible)'), 'box-shadow')).toBe(
      'inset 0 0 0 2px var(--accent-bright)'
    )
  })

  // Faded text failed 4.5:1 (Discard… at 2.4:1); a word rests in the muted ink, which the theme tests hold to 4.5:1.
  it.each(['.change__discard', '.context__resolve'])(
    'rests the text control %s at full opacity, in the muted ink',
    (selector) => {
      const faded: string[] = []
      parse(SHEET).walkRules((rule) => {
        if (!rule.selectors.some((each) => each.includes(selector) && !each.includes(':disabled'))) return
        rule.walkDecls('opacity', (decl) => {
          faded.push(`${rule.selector} { opacity: ${decl.value} }`)
        })
      })
      expect(faded).toEqual([])
      const rule = ruleListing(SHEET, selector)
      expect(rule && declarationOf(rule, 'color')).toBe('var(--fg-muted)')
    }
  )
})
