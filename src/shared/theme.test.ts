// The palette, measured.
//
// A theme is the one part of this app where "looks fine to me" is the whole of
// the review, and it is also the part a future edit is most likely to change by
// a couple of hex digits at a time. So the contrast of every shipped pair is
// computed here rather than eyeballed: an edit that drops an ink under AA fails
// the suite naming the token and the number, which is the only way a palette
// change can be held to the same standard as a code change.
//
// The thresholds are WCAG 2.1 AA for body text — 4.5:1 — because almost every
// one of these pairs is small text: this window's base size is 12.5px and its
// dimmest labels are 10.5px. Nothing here is exempted for being decorative; a
// colour that carries a meaning is text whether or not it is a letter.

import { describe, expect, it } from 'vitest'
import { contrastRatio, ensureContrast, parseColor, toHex, type Rgb } from './color'
import {
  BUILT_IN_THEMES,
  DEFAULT_APPEARANCE,
  DEFAULT_THEME_ID,
  isPristine,
  resolvePalette,
  sanitizeAppearance,
  THEME_TOKENS,
  themeById,
  type Appearance,
  type Palette,
  type ThemeToken
} from './theme'

/**
 * Every ink the app paints, and the lightest surface it is painted on.
 *
 * Lightest because these are dark themes and the lightest surface is the one
 * with the least room: an ink that clears AA on a raised card clears it on the
 * window behind the card as well. The list is a claim about the stylesheets —
 * `--fg-muted` really does appear on `.modal`, `--warning` really is the
 * confirmation dialog's detail line — so a rule that moves an ink onto a
 * surface not listed here belongs in this table too.
 */
const PAIRS: readonly { ink: ThemeToken; on: ThemeToken; least: number; why: string }[] = [
  { ink: 'fg', on: 'bg-raised', least: 7, why: 'body text, everywhere' },
  { ink: 'fg-secondary', on: 'bg-raised', least: 6, why: 'field labels, notice bodies, rail links' },
  { ink: 'fg-muted', on: 'bg-raised', least: 4.5, why: 'hints, counts, branch names, timestamps' },
  { ink: 'accent-bright', on: 'bg-raised', least: 4.5, why: 'the active combo row and the status bar branch' },
  { ink: 'on-accent', on: 'accent', least: 4.5, why: 'the label on a primary button' },
  { ink: 'success', on: 'bg-raised', least: 4.5, why: 'a clean merge, a pane that finished' },
  { ink: 'warning', on: 'bg-raised', least: 4.5, why: 'what a discard is about to cost' },
  { ink: 'danger', on: 'bg-raised', least: 4.5, why: 'conflicts, failures, the destructive button' },
  { ink: 'info', on: 'bg-raised', least: 4.5, why: 'notices that are not errors' },
  { ink: 'term-fg', on: 'term-bg', least: 7, why: 'everything a pane prints' },
  { ink: 'term-bright-black', on: 'term-bg', least: 4.5, why: 'what most agents print their reasoning in' },
  { ink: 'term-red', on: 'term-bg', least: 4.5, why: 'a failing test' },
  { ink: 'term-green', on: 'term-bg', least: 4.5, why: 'a passing one' },
  { ink: 'term-yellow', on: 'term-bg', least: 4.5, why: 'a warning in a build log' },
  { ink: 'term-blue', on: 'term-bg', least: 4.5, why: 'paths and links' },
  { ink: 'term-magenta', on: 'term-bg', least: 4.5, why: 'prompts and diff headers' },
  { ink: 'term-cyan', on: 'term-bg', least: 4.5, why: 'the other half of a diff header' },
  { ink: 'term-white', on: 'term-bg', least: 4.5, why: 'output that asked for plain white' }
]

/** Surfaces that have to be told apart from the ground behind them. */
const ELEVATIONS: readonly ThemeToken[] = ['bg-rail', 'bg-panel', 'bg-raised']

describe.each(BUILT_IN_THEMES.map((theme) => [theme.id, theme.name] as const))('%s (%s)', (id) => {
  const palette = resolvePalette({ ...DEFAULT_APPEARANCE, themeId: id })

  it('gives every token a value', () => {
    const missing = THEME_TOKENS.filter((token) => !palette[token])
    expect(missing).toEqual([])
  })

  it.each(PAIRS)('$ink on $on clears $least:1 — $why', ({ ink, on, least }) => {
    expect(ratio(palette, ink, on)).toBeGreaterThanOrEqual(least)
  })

  // Not an accessibility rule but a legibility one: a panel that cannot be
  // distinguished from the window behind it is a layout nobody can read the
  // shape of, and on a pure black ground that is the easy mistake to make.
  it.each(ELEVATIONS)('%s is visibly above the window', (surface) => {
    expect(ratio(palette, surface, 'bg-window')).toBeGreaterThan(1.05)
  })

  it('draws a hairline that can be seen, and a strong one that can be seen more', () => {
    const line = ratio(palette, 'line', 'bg-window')
    const strong = ratio(palette, 'line-strong', 'bg-window')
    expect(line).toBeGreaterThan(1.15)
    expect(strong).toBeGreaterThan(line)
  })

  // The emulator and the chrome are one surface on purpose: a terminal that
  // sits on a slightly different black than the window is the seam this whole
  // module exists to remove.
  it('paints the terminal on the same ground as the window', () => {
    expect(palette['term-bg']).toBe(palette['bg-window'])
  })
})

describe('the default', () => {
  it('is absolute black, and absolute means #000000', () => {
    expect(DEFAULT_THEME_ID).toBe('black')
    expect(themeById(DEFAULT_THEME_ID).seed.ground).toBe('#000000')
    expect(resolvePalette(DEFAULT_APPEARANCE)['bg-window']).toBe('#000000')
  })

  it('is what an installation that has never chosen anything gets', () => {
    expect(sanitizeAppearance(undefined)).toEqual(DEFAULT_APPEARANCE)
    expect(isPristine(DEFAULT_APPEARANCE)).toBe(true)
  })
})

describe('a theme somebody has edited', () => {
  it('takes a new ground and rebuilds every surface from it', () => {
    const palette = resolvePalette({ ...DEFAULT_APPEARANCE, ground: '#101820' })
    expect(palette['bg-window']).toBe('#101820')
    expect(ratio(palette, 'bg-raised', 'bg-window')).toBeGreaterThan(1.05)
    expect(ratio(palette, 'fg', 'bg-raised')).toBeGreaterThanOrEqual(7)
  })

  it('takes a new accent, and relabels the button that is filled with it', () => {
    const palette = resolvePalette({ ...DEFAULT_APPEARANCE, accent: '#e0a13e' })
    expect(palette.accent).toBe('#e0a13e')
    expect(ratio(palette, 'on-accent', 'accent')).toBeGreaterThanOrEqual(4.5)
    expect(ratio(palette, 'accent-bright', 'bg-raised')).toBeGreaterThanOrEqual(4.5)
  })

  it('takes a literal value for one token and leaves the rest alone', () => {
    const palette = resolvePalette({ ...DEFAULT_APPEARANCE, overrides: { 'bg-panel': '#123456' } })
    expect(palette['bg-panel']).toBe('#123456')
    expect(palette['bg-window']).toBe(resolvePalette(DEFAULT_APPEARANCE)['bg-window'])
  })
})

// The whole reason the editor can be as open as it is. Each of these is
// somebody typing a value that would make the window unusable, and each one is
// answered by lifting their colour rather than by refusing it.
describe('a theme somebody has broken', () => {
  const hostile: readonly { what: string; appearance: Appearance }[] = [
    {
      what: 'text the same colour as the surface it sits on',
      appearance: { ...DEFAULT_APPEARANCE, overrides: { fg: '#171718', 'fg-muted': '#171718' } }
    },
    {
      what: 'a foreground one shade off the ground',
      appearance: { ...DEFAULT_APPEARANCE, overrides: { fg: '#010101', 'fg-secondary': '#020202' } }
    },
    {
      what: 'a white ground under inks meant for a black one',
      appearance: { ...DEFAULT_APPEARANCE, ground: '#ffffff' }
    },
    {
      what: 'an accent that is the ground',
      appearance: { ...DEFAULT_APPEARANCE, accent: '#000000' }
    },
    {
      what: 'terminal colours all set to the terminal background',
      appearance: {
        ...DEFAULT_APPEARANCE,
        overrides: { 'term-red': '#000000', 'term-green': '#000000', 'term-bright-black': '#000000' }
      }
    }
  ]

  it.each(hostile)('$what still leaves every ink readable', ({ appearance }) => {
    const palette = resolvePalette(appearance)
    for (const { ink, on, least } of PAIRS) {
      expect(ratio(palette, ink, on), `${ink} on ${on}`).toBeGreaterThanOrEqual(least)
    }
  })
})

describe('reading a stored appearance', () => {
  it('falls back to the default preset rather than to nothing', () => {
    expect(sanitizeAppearance({ themeId: 'a theme that was removed' }).themeId).toBe(DEFAULT_THEME_ID)
  })

  it('drops a colour it cannot parse and keeps the ones it can', () => {
    const read = sanitizeAppearance({
      themeId: 'midnight',
      ground: 'rebeccapurple',
      accent: '#f0f',
      overrides: { line: '#not-a-colour', 'bg-panel': '#123456', 'bg-imaginary': '#123456' }
    })
    expect(read.ground).toBeNull()
    expect(read.accent).toBe('#ff00ff')
    expect(read.overrides).toEqual({ 'bg-panel': '#123456' })
  })

  it('reads a document that is not one as the default', () => {
    expect(sanitizeAppearance('nonsense')).toEqual(DEFAULT_APPEARANCE)
    expect(sanitizeAppearance(null)).toEqual(DEFAULT_APPEARANCE)
    expect(sanitizeAppearance({ overrides: 'not an object' }).overrides).toEqual({})
  })
})

describe('the contrast maths itself', () => {
  // Anchors from the WCAG definition, so a mistake in the luminance curve shows
  // up here rather than as every palette silently passing.
  it('agrees with the two ratios everybody knows', () => {
    expect(contrastRatio(rgb('#000000'), rgb('#ffffff'))).toBeCloseTo(21, 5)
    expect(contrastRatio(rgb('#777777'), rgb('#ffffff'))).toBeCloseTo(4.48, 2)
  })

  it('leaves a colour alone when it already clears the target', () => {
    expect(toHex(ensureContrast(rgb('#ffffff'), rgb('#000000'), 4.5))).toBe('#ffffff')
  })

  it('moves towards white on a dark ground and towards black on a light one', () => {
    expect(contrastRatio(ensureContrast(rgb('#222222'), rgb('#000000'), 4.5), rgb('#000000'))).toBeGreaterThanOrEqual(
      4.5
    )
    expect(contrastRatio(ensureContrast(rgb('#eeeeee'), rgb('#ffffff'), 4.5), rgb('#ffffff'))).toBeGreaterThanOrEqual(
      4.5
    )
  })
})

function ratio(palette: Palette, ink: ThemeToken, on: ThemeToken): number {
  return contrastRatio(rgb(palette[ink]), rgb(palette[on]))
}

function rgb(value: string): Rgb {
  const parsed = parseColor(value)
  if (parsed === null) throw new Error(`${value} is not a colour this palette can be measured in`)
  return parsed
}
