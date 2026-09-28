// The diff's pins: code at the code size, changed lines and words that stand out and still read, quiet hunk verbs.

import { describe, expect, it } from 'vitest'
import { BUILT_IN_THEMES } from '@shared/theme'
import { contrastRatio, mix } from '@shared/color'
import { declarationOf, paletteOf, rgbOf, ruleFor, ruleListing } from './css'

const SHEET = 'diff.css'

describe('diff.css', () => {
  it('sets diff code at 13 px on 20 px lines, in the app’s monospace', () => {
    const patch = ruleFor(SHEET, '.patch')
    expect(declarationOf(patch, 'font-size')).toBe('var(--text-code)')
    expect(declarationOf(patch, 'line-height')).toBe('20px')
    expect(declarationOf(patch, 'font-family')).toBe('var(--font-mono)')
  })

  // A changed line is a 14% wash of its tone and a changed word 30% over it; the sign carries the full colour.
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
        expect(line, side).toBe(0.14)
        expect(word, side).toBe(0.3)
        const lineFill = mix(rgbOf(palette['bg-pane']), rgbOf(palette[tone]), line)
        const wordFill = mix(lineFill, rgbOf(palette[tone]), word)
        expect(contrastRatio(rgbOf(palette['fg-secondary']), lineFill), `${side} line`).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(rgbOf(palette.fg), wordFill), `${side} word`).toBeGreaterThanOrEqual(4.5)
      }
    }
  )

  it.each([
    ['added', 'var(--success)'],
    ['removed', 'var(--danger)']
  ])('signs an %s line in %s at full strength', (side, colour) => {
    expect(declarationOf(ruleFor(SHEET, `.patch__sign--${side}`), 'color')).toBe(colour)
  })

  it('keeps a hunk’s Stage and Discard out of sight until the hunk is hovered or focused', () => {
    expect(declarationOf(ruleFor(SHEET, '.patch__stage'), 'opacity')).toBe('var(--row-action-rest)')
    for (const shown of ['.patch__hunk:hover .patch__stage', '.patch__hunk:focus-within .patch__stage']) {
      const rule = ruleListing(SHEET, shown)
      expect(rule && declarationOf(rule, 'opacity'), shown).toBe('1')
    }
  })

  it('heads the staged and unstaged halves in sentence case', () => {
    const half = ruleFor(SHEET, '.patch__half')
    expect(declarationOf(half, 'text-transform')).toBeUndefined()
    expect(declarationOf(half, 'font-size')).toBe('var(--text-sm)')
  })
})
