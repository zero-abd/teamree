// The shared layer's pins: the button family, fields, switch, segmented control, chips, caps and the focus ring.

import postcss from 'postcss'
import { describe, expect, it } from 'vitest'
import { declarationOf, keyframeFrom, parse, ruleFor, ruleListing } from './css'

const SHEET = 'base.css'
const listed = (selector: string): postcss.Rule => {
  const rule = ruleListing(SHEET, selector)
  expect(rule, `base.css should list ${selector}`).toBeTruthy()
  return rule as postcss.Rule
}

describe('base.css', () => {
  describe('buttons', () => {
    it.each([
      ['.button', 'var(--control-md)', '0 12px', 'var(--r2)'],
      ['.button--small', 'var(--control-sm)', '0 9px', 'var(--r1)'],
      ['.button--lg', 'var(--control-lg)', '0 16px', 'var(--r2)']
    ])('draws %s at %s high, padded %s, cornered %s', (selector, height, padding, radius) => {
      const rule = ruleFor(SHEET, selector)
      expect(declarationOf(rule, 'height')).toBe(height)
      expect(declarationOf(rule, 'padding')).toBe(padding)
      expect(declarationOf(rule, 'border-radius')).toBe(radius)
    })

    it('labels every button at 12/600', () => {
      const button = ruleFor(SHEET, '.button')
      expect(declarationOf(button, 'font-size')).toBe('var(--text-sm)')
      expect(declarationOf(button, 'font-weight')).toBe('600')
    })

    it('fills the primary with the accent, darker under the pointer and darker still when held', () => {
      expect(declarationOf(ruleFor(SHEET, '.button--primary'), 'background')).toBe('var(--accent)')
      expect(declarationOf(ruleFor(SHEET, '.button--primary'), 'color')).toBe('var(--on-accent)')
      expect(declarationOf(listed(".button--primary:hover:not(:disabled, [aria-disabled='true'])"), 'background')).toBe(
        'var(--accent-hover)'
      )
      expect(
        declarationOf(listed(".button--primary:active:not(:disabled, [aria-disabled='true'])"), 'background')
      ).toBe('var(--accent-press)')
    })

    it('draws the secondary raised behind a strong edge, the ghost bare, the danger filled red', () => {
      const secondary = listed('.button--secondary')
      expect(declarationOf(secondary, 'background')).toBe('var(--bg-raised)')
      expect(declarationOf(secondary, 'border-color')).toBe('var(--line-strong)')
      expect(declarationOf(ruleFor(SHEET, '.button--ghost'), 'background')).toBe('transparent')
      expect(declarationOf(ruleFor(SHEET, '.button--danger'), 'background')).toBe('var(--danger)')
      expect(declarationOf(ruleFor(SHEET, '.button--danger'), 'color')).toBe('var(--on-accent)')
    })

    // Pressed moves a pixel down in 70ms, so the press is felt before anything it does.
    it('presses a button a pixel down, at the instant speed', () => {
      expect(declarationOf(listed(".button:active:not(:disabled, [aria-disabled='true'])"), 'transform')).toBe(
        'translateY(1px)'
      )
      expect(declarationOf(ruleFor(SHEET, '.button'), 'transition')).toContain('transform var(--motion-instant)')
    })

    // A dimmed accent reads as a pressable primary; disabled is one neutral look whatever the variant.
    it('greys a disabled button out rather than dimming its colour', () => {
      const disabled = ruleFor(SHEET, '.button:disabled')
      expect(declarationOf(disabled, 'opacity')).toBeUndefined()
      expect(declarationOf(disabled, 'color')).toBe('var(--fg-muted)')
      expect(declarationOf(disabled, 'background')).toBe('transparent')
    })

    // Still filled, so a dialog shows its primary before the form can go.
    it('keeps a primary that cannot go yet filled, at .45', () => {
      expect(declarationOf(listed(".button--primary[aria-disabled='true']"), 'opacity')).toBe('0.45')
    })

    it('holds a loading button’s width and spins in place of its icon', () => {
      expect(ruleFor(SHEET, '.button--loading::before')).toBeTruthy()
      expect(declarationOf(ruleFor(SHEET, '.button--loading'), 'pointer-events')).toBe('none')
    })

    it('draws an icon button bare at rest, 24px square', () => {
      const icon = ruleFor(SHEET, '.button--icon')
      expect(declarationOf(icon, 'width')).toBe('24px')
      expect(declarationOf(icon, 'height')).toBe('24px')
      expect(declarationOf(icon, 'background')).toBe('transparent')
      expect(declarationOf(icon, 'border-color')).toBe('transparent')
    })
  })

  it('draws a field 32px high on the input ground behind a strong edge, at the body size', () => {
    expect(declarationOf(ruleFor(SHEET, '.input'), 'height')).toBe('var(--control-md)')
    expect(declarationOf(ruleFor(SHEET, '.textarea'), 'min-height')).toBe('80px')
    let both: postcss.Rule | undefined
    parse(SHEET).walkRules((rule) => {
      if (rule.selectors.join() === '.input,.textarea') both = rule
    })
    expect(both && declarationOf(both, 'background')).toBe('var(--bg-input)')
    expect(both && declarationOf(both, 'border')).toBe('1px solid var(--line-strong)')
    expect(both && declarationOf(both, 'font-size')).toBe('var(--text-base)')
  })

  it('draws a switch 32 by 18 whose thumb springs 14px', () => {
    const track = ruleFor(SHEET, '.switch')
    expect(declarationOf(track, 'width')).toBe('32px')
    expect(declarationOf(track, 'height')).toBe('18px')
    expect(declarationOf(ruleFor(SHEET, '.switch:checked::before'), 'transform')).toBe('translateX(14px)')
    expect(declarationOf(ruleFor(SHEET, '.switch::before'), 'transition')).toBe(
      'transform var(--motion-base) var(--ease-spring)'
    )
  })

  it('sets a segmented control in a 28px sunken well, its choice raised', () => {
    const well = ruleFor(SHEET, '.segmented')
    expect(declarationOf(well, 'height')).toBe('28px')
    expect(declarationOf(well, 'background')).toBe('var(--bg-sunken)')
    const on = listed(".segmented__item[aria-pressed='true']")
    expect(declarationOf(on, 'background')).toBe('var(--bg-raised)')
    expect(declarationOf(on, 'box-shadow')).toBe('var(--shadow-1)')
  })

  // One chip radius and size everywhere.
  it('draws every chip from one rule, a 20px pill', () => {
    const chip = ruleFor(SHEET, '.chip')
    expect(declarationOf(chip, 'border-radius')).toBe('var(--r-pill)')
    expect(declarationOf(chip, 'font-size')).toBe('var(--text-xs)')
    expect(declarationOf(chip, 'min-height')).toBe('20px')
    for (const [sheet, selector] of [
      ['sidebar.css', '.worktree__tag'],
      ['sidebar.css', '.worktree__merge'],
      ['panes.css', '.pane__exit'],
      ['panes.css', '.pane__restored--agent']
    ] as const) {
      const rule = ruleFor(sheet, selector)
      expect(declarationOf(rule, 'border-radius'), selector).toBeUndefined()
      expect(declarationOf(rule, 'font-size'), selector).toBeUndefined()
    }
  })

  // The pill's ground stays neutral; its dot carries the hue.
  it('colours a status pill by its dot, never its ground', () => {
    expect(declarationOf(ruleFor(SHEET, '.status-pill'), 'background')).toBe('var(--bg-hover)')
    expect(declarationOf(ruleFor(SHEET, '.status--working'), 'color')).toBe('var(--working)')
    expect(declarationOf(listed('.status--ended'), 'color')).toBe('var(--stopped)')
  })

  it('shows a tooltip on the inverted ground at 11/600', () => {
    const tip = ruleFor(SHEET, '.tooltip')
    expect(declarationOf(tip, 'background')).toBe('var(--fg)')
    expect(declarationOf(tip, 'color')).toBe('var(--bg-pane)')
    expect(declarationOf(tip, 'font-size')).toBe('var(--text-xs)')
  })

  it('edges a toast in its tone, never fills it', () => {
    expect(declarationOf(ruleFor(SHEET, '.toast'), 'width')).toBe('340px')
    expect(declarationOf(ruleFor(SHEET, '.toast'), 'background')).toBe('var(--bg-elevated)')
    expect(declarationOf(ruleFor(SHEET, '.toast--asking::before'), 'background')).toBe('var(--warning)')
    const from = keyframeFrom(SHEET, (declarationOf(ruleFor(SHEET, '.toast'), 'animation') ?? '').split(' ')[0] ?? '')
    expect(declarationOf(from, 'transform')).toBe('translateX(16px)')
  })

  // Two pixels away from the control: a ring tight against a border is only a thicker border.
  it('rings the focused control 2px out, in the accent', () => {
    expect(declarationOf(ruleFor(SHEET, ':focus-visible'), 'outline')).toMatch(/^2px /)
  })

  it('follows a dragged edge without easing behind it', () => {
    const rule = listed('body.is-resizing .shell')
    expect(rule.selectors).toContain('body.is-resizing .panel')
    expect(declarationOf(rule, 'transition')).toBe('none')
  })
})
