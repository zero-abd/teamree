// The corner stack's pins: above every dialog, one stack for notices and the update card.

import { describe, expect, it } from 'vitest'
import { declarationOf, ruleFor, zIndexOf } from './css'

const SHEET = 'notices.css'

describe('notices.css', () => {
  // A notice under the modal scrim is painted and covered; the two z-indexes live in two files.
  it('stacks the notices above the modal layer, so no dialog can hide its own error', () => {
    expect(zIndexOf('.corner-stack')).toBeGreaterThan(zIndexOf('.modal-layer'))
  })

  // One stack in the bottom-right corner, so the update card and a notice never overlap.
  it('puts the update card in the notices’ stack rather than a corner of its own', () => {
    const stack = ruleFor(SHEET, '.corner-stack')
    expect(declarationOf(stack, 'position')).toBe('fixed')
    expect(declarationOf(stack, 'right')).toBeDefined()
    expect(declarationOf(stack, 'left')).toBeUndefined()
    expect(declarationOf(ruleFor(SHEET, '.notices'), 'position')).toBeUndefined()
    expect(declarationOf(ruleFor('updates.css', '.update-card'), 'position')).toBeUndefined()
  })

  // Spoken, never drawn; and while it holds no notice the region takes no room in the corner stack.
  it('keeps the spoken line out of sight, and the empty notice region out of the stack', () => {
    const spoken = ruleFor(SHEET, '.notices__spoken')
    expect(declarationOf(spoken, 'position')).toBe('absolute')
    expect(declarationOf(spoken, 'clip-path')).toBe('inset(50%)')
    expect(declarationOf(ruleFor(SHEET, '.notices:not(:has(.notice))'), 'position')).toBe('absolute')
  })

  // The tone is an edge, never a fill; the cards are one width.
  it('draws a card 340 wide with its tone as a 2px inset edge', () => {
    expect(declarationOf(ruleFor(SHEET, '.notices'), 'width')).toBe('340px')
    const edge = ruleFor(SHEET, '.notice::before')
    expect(declarationOf(edge, 'width')).toBe('2px')
    expect(declarationOf(edge, 'left')).toBe('2px')
    expect(declarationOf(ruleFor(SHEET, '.notice--error::before'), 'background')).toBe('var(--danger)')
    expect(declarationOf(ruleFor(SHEET, '.notice'), 'background')).toBe('var(--bg-elevated)')
  })

  it('slides a card in from the right at the enter curve and out at the exit curve', () => {
    expect(declarationOf(ruleFor(SHEET, '.notice'), 'animation')).toBe('notice-in var(--motion-slow) var(--ease-enter)')
    expect(declarationOf(ruleFor(SHEET, '.notice--leaving'), 'animation')).toBe(
      'notice-out var(--motion-base) var(--ease-exit) forwards'
    )
  })

  it('keeps the close control out of sight at rest, where something can hover', () => {
    expect(declarationOf(ruleFor(SHEET, '.notice__close'), 'opacity')).toBe('var(--row-action-rest)')
  })

  // An agent asking out of sight: amber, the one tone that means asking, on its edge and its icon.
  it('edges an asking card in amber and quotes its ask on one line', () => {
    expect(declarationOf(ruleFor(SHEET, '.notice--asking::before'), 'background')).toBe('var(--warning)')
    expect(declarationOf(ruleFor(SHEET, '.notice--asking .notice__icon'), 'color')).toBe('var(--warning)')
    expect(declarationOf(ruleFor(SHEET, '.notice__detail--ask'), 'white-space')).toBe('nowrap')
  })

  // A teammate's popup answered in the same buttons as every other card: one filled, the rest ghost.
  it('fills a popup’s first action and leaves the rest ghost', () => {
    expect(declarationOf(ruleFor(SHEET, '.notice__action'), 'background')).toBe('transparent')
    expect(declarationOf(ruleFor(SHEET, '.notice__text + .notice__action'), 'background')).toBe('var(--accent)')
  })
})
