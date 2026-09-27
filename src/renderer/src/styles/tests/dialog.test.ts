// The dialog frame's pins: one floating sheet, one head, one body inset, one footer, and the scrim behind it.

import { describe, expect, it } from 'vitest'
import { declarationOf, findRule, keyframeFrom, parse, ruleFor } from './css'

const SHEET = 'dialog.css'

describe('dialog.css', () => {
  // The frame pads the body on the same edge as the head; no content class pads itself.
  describe('one dialog frame', () => {
    it('floats a 520px sheet on the elevated ground, with the largest corner and the floating shadow', () => {
      const modal = ruleFor(SHEET, '.modal')
      expect(declarationOf(modal, 'background')).toBe('var(--bg-elevated)')
      expect(declarationOf(modal, 'border-radius')).toBe('var(--r4)')
      expect(declarationOf(modal, 'box-shadow')).toBe('var(--shadow-pop)')
      expect(declarationOf(modal, 'width')).toBe('min(520px, calc(100vw - 48px))')
    })

    it('heads it with a 54px bar holding the title and a 28px close', () => {
      const head = ruleFor(SHEET, '.modal__head')
      expect(declarationOf(head, 'min-height')).toBe('54px')
      expect(declarationOf(head, 'border-bottom')).toBe('1px solid var(--line)')
      const title = ruleFor(SHEET, '.modal__title')
      expect(declarationOf(title, 'font-size')).toBe('var(--text-xl)')
      expect(declarationOf(title, 'line-height')).toBe('24px')
      const close = ruleFor(SHEET, '.modal__close')
      expect(declarationOf(close, 'width')).toBe('28px')
      expect(declarationOf(close, 'height')).toBe('28px')
    })

    it('puts the body on the title’s edge', () => {
      const head = declarationOf(ruleFor(SHEET, '.modal__head'), 'padding')
      const body = declarationOf(ruleFor(SHEET, '.modal__body'), 'padding')
      expect(head?.split(' ')[1]).toBe('20px')
      expect(body).toBe('20px')
    })

    it('lets no dialog content pad or size itself', () => {
      for (const [sheet, selector] of [
        [SHEET, '.confirm'],
        [SHEET, '.consent'],
        [SHEET, '.form'],
        ['palette.css', '.palette'],
        ['cli.css', '.cli-install']
      ] as const) {
        const rule = ruleFor(sheet, selector)
        expect(declarationOf(rule, 'padding'), selector).toBeUndefined()
        expect(declarationOf(rule, 'width'), selector).toBeUndefined()
      }
    })

    // A dialog whose height changes (a mode switch, a list filling) must not move under the pointer.
    it('anchors every dialog’s top edge, as the palette’s', () => {
      const layer = ruleFor(SHEET, '.modal-layer')
      expect(declarationOf(layer, 'place-items')).toBe('start center')
      expect(declarationOf(layer, 'padding-block')?.split(' ')[0]).toBe('12vh')
      expect(findRule(SHEET, '.modal-layer:has(.palette)')).toBeUndefined()
    })

    // The footer runs edge to edge on the raised tone, under a line, the answers at its right.
    it('ends every dialog in one right-aligned footer with an 8px gap', () => {
      const actions = ruleFor(SHEET, '.modal__actions')
      expect(declarationOf(actions, 'justify-content')).toBe('flex-end')
      expect(declarationOf(actions, 'gap')).toBe('8px')
      expect(declarationOf(actions, 'background')).toBe('var(--bg-raised)')
      expect(declarationOf(actions, 'border-top')).toBe('1px solid var(--line)')
      expect(declarationOf(actions, 'margin')).toBe('var(--s5) -20px -20px')
      expect(findRule(SHEET, '.confirm__actions')).toBeUndefined()
      expect(findRule(SHEET, '.form__actions')).toBeUndefined()
      expect(findRule(SHEET, '.consent__actions')).toBeUndefined()
    })

    // A fieldset's legend is a label too; its default inset put "Agents" off the other labels' edge.
    it('sizes and insets every field label alike', () => {
      expect(declarationOf(ruleFor(SHEET, '.field__label'), 'padding')).toBe('0')
      const overrides: string[] = []
      parse(SHEET).walkRules((rule) => {
        if (rule.selector !== '.field__label' && rule.selector.includes('field__label')) overrides.push(rule.selector)
      })
      expect(overrides).toEqual([])
    })

    it('draws every picker at one height and size, the ref face changing only the family', () => {
      const picker = ruleFor(SHEET, '.picker__input')
      expect(declarationOf(picker, 'height')).toBeDefined()
      expect(declarationOf(picker, 'font-size')).toBe('var(--text-base)')
      const ref = ruleFor(SHEET, '.picker__input--ref')
      expect(declarationOf(ref, 'font-family')).toBe('var(--font-mono)')
      expect(declarationOf(ref, 'font-size')).toBeUndefined()
    })

    it('draws a stepper that cannot step like every other disabled button', () => {
      for (const property of ['border-color', 'background', 'color']) {
        expect(declarationOf(ruleFor(SHEET, '.agents__step:disabled'), property)).toBe(
          declarationOf(ruleFor('base.css', '.button:disabled'), property)
        )
      }
    })
  })

  // The scrim parts a dialog from a dark window; a light one needs no blur to read.
  it('dims behind a dialog, and blurs the window 8px only in the dark', () => {
    expect(declarationOf(ruleFor(SHEET, '.modal-layer'), 'background')).toBe('var(--scrim)')
    expect(declarationOf(ruleFor(SHEET, '.modal-layer'), 'backdrop-filter')).toBeUndefined()
    expect(declarationOf(ruleFor(SHEET, ":root[data-tone='dark'] .modal-layer"), 'backdrop-filter')).toBe('blur(8px)')
    expect(findRule(SHEET, ":root[data-tone='light'] .modal-layer")).toBeUndefined()
  })

  // Arriving surfaces take the slow enter curve: the scrim fades, the sheet rises 10px and settles from .985.
  it('opens a dialog over 280ms on the enter curve', () => {
    for (const selector of ['.modal-layer', '.modal']) {
      const animation = declarationOf(ruleFor(SHEET, selector), 'animation') ?? ''
      expect(animation, selector).toContain('var(--motion-slow)')
      expect(animation, selector).toContain('var(--ease-enter)')
    }
    const from = keyframeFrom(SHEET, (declarationOf(ruleFor(SHEET, '.modal'), 'animation') ?? '').split(' ')[0] ?? '')
    expect(declarationOf(from, 'transform')).toBe('translateY(10px) scale(0.985)')
    expect(declarationOf(from, 'opacity')).toBe('0')
  })

  it('fills the active start-from row with the selected surface', () => {
    expect(declarationOf(ruleFor(SHEET, '.combo__row.is-active'), 'background')).toBe('var(--bg-selected)')
  })
})
