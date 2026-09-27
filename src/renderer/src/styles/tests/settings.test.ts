// Settings' pins.

import { describe, expect, it } from 'vitest'
import { findRule } from './css'

describe('settings.css', () => {
  it('draws no head, close or column of its own; the page frame does', () => {
    for (const selector of ['.settings__head', '.settings__close', '.settings__column']) {
      expect(findRule('settings.css', selector), selector).toBeUndefined()
    }
  })

  it('leaves the switch to the shared layer', () => {
    expect(findRule('settings.css', '.switch')).toBeUndefined()
  })
})
