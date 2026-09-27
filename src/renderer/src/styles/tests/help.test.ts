// Help's pins.

import { describe, expect, it } from 'vitest'
import { findRule } from './css'

describe('help.css', () => {
  it('draws no head or close of its own; the page frame does', () => {
    expect(findRule('help.css', '.help__head')).toBeUndefined()
    expect(findRule('help.css', '.help__close')).toBeUndefined()
  })
})
