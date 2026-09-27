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
})
