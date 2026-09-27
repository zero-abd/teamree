// The window frame's pins: its ground, and the columns that slide as the sidebar and panel open.

import { describe, expect, it } from 'vitest'
import { declarationOf, ruleFor } from './css'

const SHEET = 'shell.css'

describe('shell.css', () => {
  it('paints the window in its own ground', () => {
    expect(declarationOf(ruleFor(SHEET, '.shell'), 'background')).toBe('var(--bg-window)')
  })

  // A sheet mid-slide hangs past the window's edge; with the shell a scroller, a focus scrolled the app to it.
  it('clips the shell, so nothing sliding in can scroll the window', () => {
    expect(declarationOf(ruleFor(SHEET, '.shell'), 'overflow')).toBe('clip')
  })

  // A width with the same number of tracks either side interpolates; `1fr` alone against three does not.
  it('animates the sidebar’s column and the right panel’s width', () => {
    expect(declarationOf(ruleFor(SHEET, '.shell'), 'transition')).toBe(
      'grid-template-columns var(--motion-base) var(--ease)'
    )
    const tracks = (selector: string): number =>
      (declarationOf(ruleFor(SHEET, selector), 'grid-template-columns') ?? '').split(/ (?![^(]*\))/).length
    expect(tracks('.shell--collapsed')).toBe(tracks('.shell'))
    expect(declarationOf(ruleFor('rightPanel.css', '.panel'), 'transition')).toBe(
      'width var(--motion-base) var(--ease)'
    )
  })
})
