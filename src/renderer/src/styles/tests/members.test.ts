// Teamwork's pins.

import { describe, expect, it } from 'vitest'
import { findRule } from './css'

describe('members.css', () => {
  it('draws no head or column of its own; the page frame does', () => {
    expect(findRule('members.css', '.teamwork-view__head')).toBeUndefined()
    expect(findRule('members.css', '.teamwork-view__column')).toBeUndefined()
  })
})
