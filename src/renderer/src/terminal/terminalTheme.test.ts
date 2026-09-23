/** @vitest-environment jsdom */

// The seam between the palette and the emulator.
//
// It is a seam because xterm cannot read CSS: the colours have to be handed to
// it as strings, once when a pane is created and again whenever the theme
// moves. Two things can go wrong there and neither of them throws. A key that
// is not mapped keeps xterm's own default, so one colour in the window comes
// from a palette nobody chose; and the literals this file falls back to can
// drift from the palette they were copied out of, so a pane created before the
// custom properties resolve is painted in last year's theme.
//
// Both are silent, and both are checked here.

import { describe, expect, it } from 'vitest'
import { Terminal as XTerm } from '@xterm/xterm'
import { DEFAULT_APPEARANCE, resolvePalette, THEME_TOKENS, type Palette } from '@shared/theme'
import { readSearchDecorations, readTerminalColors, readTerminalTheme } from './terminalTheme'

/** A root element carrying one palette, the way the renderer sets one. */
function rootWith(values: Record<string, string>): HTMLElement {
  const root = document.createElement('div')
  for (const [name, value] of Object.entries(values)) root.style.setProperty(name, value)
  return root
}

describe('what the emulator is handed', () => {
  it('takes every colour from the palette on the element, leaving none behind', () => {
    // A different colour per token, so a key that was never mapped is a key
    // that still holds a fallback — and every fallback is outside this range.
    const sentinels: Record<string, string> = {}
    THEME_TOKENS.forEach((token, index) => {
      sentinels[`--${token}`] = `#${(index + 1).toString(16).padStart(2, '0')}0000`
    })

    const theme = readTerminalTheme(rootWith(sentinels)) as unknown as Record<string, string>
    const painted = Object.entries(theme).filter(([, value]) => typeof value === 'string')
    expect(painted.length).toBeGreaterThanOrEqual(21)
    const unmapped = painted.filter(([, value]) => !value.endsWith('0000'))
    expect(unmapped).toEqual([])
  })

  it('reads the search decorations off the same element', () => {
    const decorations = readSearchDecorations(rootWith({ '--term-selection': '#123456' }))
    expect(decorations.matchBackground).toBe('#123456')
    expect(decorations.activeMatchBackground).toBe('#123456')
  })
})

// The fallbacks stand for the instant before a palette resolves, and for a
// harness with no `getComputedStyle` at all. They are only honest if they are
// the default theme, which is what the window is painted in at that instant.
describe('the colours used when there is no element to read', () => {
  const palette = resolvePalette(DEFAULT_APPEARANCE)

  it('is the default theme, not a palette of its own', () => {
    const theme = readTerminalTheme(null) as unknown as Record<string, string>
    expect(theme.background).toBe(palette['term-bg'])
    expect(theme.foreground).toBe(palette['term-fg'])
    expect(theme.cursor).toBe(palette['term-cursor'])
    expect(theme.red).toBe(palette['term-red'])
    expect(theme.brightBlack).toBe(palette['term-bright-black'])
    expect(theme.brightWhite).toBe(palette['term-bright-white'])
  })

  it('carries the same selection and active-match colours the theme does', () => {
    const decorations = readSearchDecorations(null)
    expect(decorations.matchBackground).toBe(palette['term-selection'])
    expect(decorations.activeMatchBorder).toBe(palette['accent-bright'])
  })
})

// Agents pick truecolour for a dark ground; codex's footer is (243,227,188), 1.2:1 on white.
describe('the contrast floor the emulator is handed', () => {
  const light = resolvePalette({ ...DEFAULT_APPEARANCE, mode: 'light' })
  const dark = resolvePalette({ ...DEFAULT_APPEARANCE, mode: 'dark' })

  it('lifts colours to 4.5:1 on a light ground', () => {
    expect(readTerminalColors(rootWith(asProperties(light))).minimumContrastRatio).toBe(4.5)
  })

  it('leaves a dark ground as the program painted it', () => {
    expect(readTerminalColors(rootWith(asProperties(dark))).minimumContrastRatio).toBe(1)
    expect(readTerminalColors(null).minimumContrastRatio).toBe(1)
  })

  it('reaches a running emulator with the theme', () => {
    const term = new XTerm()
    Object.assign(term.options, readTerminalColors(rootWith(asProperties(light))))
    expect(term.options.minimumContrastRatio).toBe(4.5)
    expect(term.options.theme?.background).toBe(light['term-bg'])
    Object.assign(term.options, readTerminalColors(rootWith(asProperties(dark))))
    expect(term.options.minimumContrastRatio).toBe(1)
    term.dispose()
  })
})

function asProperties(palette: Palette): Record<string, string> {
  return Object.fromEntries(THEME_TOKENS.map((token) => [`--${token}`, palette[token]]))
}
