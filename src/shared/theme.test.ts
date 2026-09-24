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
import { contrastRatio, ensureContrast, opaqueHex, parseColor, toHex, type Rgb } from './color'
import {
  ACCENT_PRESETS,
  BUILT_IN_THEMES,
  DEFAULT_ACCENT,
  DEFAULT_APPEARANCE,
  DEFAULT_THEME_ID,
  isPristine,
  resolvePalette,
  resolveTone,
  sanitizeAppearance,
  THEME_TOKENS,
  themeById,
  themeTone,
  withChoice,
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
  { ink: 'accent-bright', on: 'bg-panel', least: 4.5, why: 'a commit sha, a hunk header, whose worktree a row is' },
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
  { ink: 'term-white', on: 'term-bg', least: 4.5, why: 'output that asked for plain white' },

  // The surfaces that arrived with the update card, the teamwork setup flow and
  // the consent prompt, none of which existed when the rows above were written.
  // Every one of them is a panel or a well rather than a raised card, and on
  // every built-in theme those sit *below* `bg-raised` rather than above it — so
  // none of these was failing when it landed. They are here because this table
  // is a claim about the stylesheets and not a list of the hard cases: an ink
  // measured against one surface and painted on three is an ink the next edit
  // can put somewhere nothing checks.
  { ink: 'fg', on: 'bg-panel', least: 7, why: 'what a push ended up doing, and the heading over it' },
  { ink: 'fg-secondary', on: 'bg-panel', least: 6, why: 'a release’s notes, and what each teamwork step is for' },
  { ink: 'fg-muted', on: 'bg-panel', least: 4.5, why: 'the hints underneath them' },
  { ink: 'success', on: 'bg-panel', least: 4.5, why: 'a teamwork step that is finished' },
  { ink: 'warning', on: 'bg-panel', least: 4.5, why: 'one that is waiting on something else' },
  { ink: 'fg', on: 'bg-input', least: 7, why: 'the keystrokes a teammate is asking to run' },
  { ink: 'fg-secondary', on: 'bg-input', least: 6, why: 'git’s own words while a push streams' },
  { ink: 'fg-muted', on: 'bg-input', least: 4.5, why: 'the seconds counting up beside them' }
]

/** Surfaces that have to be told apart from the ground behind them. */
const ELEVATIONS: readonly ThemeToken[] = ['bg-rail', 'bg-panel', 'bg-raised']

describe.each(BUILT_IN_THEMES.map((theme) => [theme.id, theme.name] as const))('%s (%s)', (id) => {
  const palette = resolvePalette(showing(id))

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

  // The chip's own tint is darker than any surface on a light ground, so it is the accent ink's worst case.
  it('prints accent-bright readably on an accent-soft chip', () => {
    const chip = rgb(opaqueHex(palette['accent-soft'], rgb(palette['bg-raised'])) ?? '')
    expect(contrastRatio(rgb(palette['accent-bright']), chip)).toBeGreaterThanOrEqual(4.5)
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

// On a light ground ANSI black is the colour text is printed in, not a shade of the ground.
describe.each(BUILT_IN_THEMES.filter((theme) => themeTone(theme.id) === 'light').map((theme) => theme.id))(
  'light preset %s',
  (id) => {
    const palette = resolvePalette(showing(id))

    it('sits on a light ground', () => {
      expect(ratio(palette, 'bg-window', 'fg')).toBeGreaterThanOrEqual(11)
      expect(contrastRatio(rgb(palette['bg-window']), rgb('#ffffff'))).toBeLessThan(1.2)
    })

    it('prints ANSI black readably', () => {
      expect(ratio(palette, 'term-black', 'term-bg')).toBeGreaterThanOrEqual(4.5)
    })

    it('keeps the violet accent', () => {
      expect(palette.accent).toBe(DEFAULT_ACCENT)
    })
  }
)

describe('light and dark', () => {
  it('ships a preset called Light', () => {
    expect(themeById('light').name).toBe('Light')
    expect(themeTone('light')).toBe('light')
    expect(themeTone('black')).toBe('dark')
  })

  it('follows the system on a new installation', () => {
    expect(DEFAULT_APPEARANCE.mode).toBe('system')
    expect(resolveTone(DEFAULT_APPEARANCE, 'light')).toBe('light')
    expect(resolveTone(DEFAULT_APPEARANCE, 'dark')).toBe('dark')
  })

  it('keeps the chosen dark preset for when the system goes dark again', () => {
    const appearance: Appearance = { ...DEFAULT_APPEARANCE, themeId: 'midnight', mode: 'system' }
    expect(resolvePalette(appearance, 'dark')['bg-window']).toBe(themeById('midnight').seed.ground)
    expect(resolvePalette(appearance, 'light')['bg-window']).toBe(themeById('light').seed.ground)
  })

  it('ignores the system when told Light or Dark', () => {
    expect(resolveTone({ ...DEFAULT_APPEARANCE, mode: 'light' }, 'dark')).toBe('light')
    expect(resolveTone({ ...DEFAULT_APPEARANCE, mode: 'dark' }, 'light')).toBe('dark')
  })

  it('leaves a window stored before modes existed dark', () => {
    const stored = sanitizeAppearance({ themeId: 'graphite', ground: null, accent: null, overrides: {} })
    expect(resolveTone(stored, 'light')).toBe('dark')
    expect(resolvePalette(stored, 'light')['bg-window']).toBe(themeById('graphite').seed.ground)
  })

  it('edits only the slot being shown', () => {
    const edited = withChoice({ ...DEFAULT_APPEARANCE, themeId: 'midnight' }, 'light', {
      themeId: 'paper',
      ground: null,
      accent: '#5aa9e6',
      overrides: {}
    })
    expect(edited.themeId).toBe('midnight')
    expect(edited.accent).toBeNull()
    expect(resolvePalette(edited, 'light').accent).toBe('#5aa9e6')
    expect(resolvePalette(edited, 'dark').accent).toBe(DEFAULT_ACCENT)
  })

  it('reads the mode and the light slot back, dropping what it cannot use', () => {
    const read = sanitizeAppearance({
      ...DEFAULT_APPEARANCE,
      mode: 'sepia',
      light: { themeId: 'light', ground: 'nope', accent: '#f0f', overrides: { line: '#123456', bogus: '#fff' } }
    })
    expect(read.mode).toBeUndefined()
    expect(read.light).toEqual({ themeId: 'light', ground: null, accent: '#ff00ff', overrides: { line: '#123456' } })
    expect(sanitizeAppearance({ ...DEFAULT_APPEARANCE, mode: 'light' }).mode).toBe('light')
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
    const palette = resolvePalette({ ...DEFAULT_APPEARANCE, accent: '#e070c0' })
    expect(palette.accent).toBe('#e070c0')
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

// Amber is an agent asking, green done, red failed: an accent in one of them makes every
// selected row and focus ring read as that state.
describe('accents', () => {
  const STATES = { asking: '#d6a24a', done: '#57c38a', failed: '#e8615a' }
  const hue = (hex: string): number => {
    const { r, g, b } = parseColor(hex) as Rgb
    const max = Math.max(r, g, b)
    const d = max - Math.min(r, g, b)
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    return (h * 60 + 360) % 360
  }
  const apart = (a: number, b: number): number => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))
  const offered = ACCENT_PRESETS.map((option) => option.value)

  it('offers none within 20° of a state colour', () => {
    for (const { name, value } of ACCENT_PRESETS) {
      const { r, g, b } = parseColor(value) as Rgb
      if (Math.max(r, g, b) - Math.min(r, g, b) < 40) continue
      for (const [state, tone] of Object.entries(STATES)) {
        expect(apart(hue(value), hue(tone)), `${name} vs ${state}`).toBeGreaterThan(20)
      }
    }
    expect(ACCENT_PRESETS.map((option) => option.name)).toEqual(['Violet', 'Sky', 'Teal', 'Orchid', 'Pink', 'Graphite'])
  })

  it('reads a stored amber, lime or rose accent as the nearest one offered', () => {
    const read = (accent: string): string | null => sanitizeAppearance({ ...DEFAULT_APPEARANCE, accent }).accent
    expect(read('#e0a13e')).toBe('#e070c0')
    expect(read('#ef6b87')).toBe('#e070c0')
    expect(read('#8fc65a')).toBe('#3bb8c4')
    expect(read('#3fbfa6')).toBe('#3bb8c4')
    expect(sanitizeAppearance({ light: { themeId: 'light', accent: '#e0a13e' } }).light?.accent).toBe('#e070c0')
  })

  it('moves a custom accent off the asking, done and failed hues', () => {
    for (const tone of [...Object.values(STATES), '#f0b030', '#40c060', '#ff2020']) {
      const accent = sanitizeAppearance({ ...DEFAULT_APPEARANCE, accent: tone }).accent
      expect(offered, tone).toContain(accent)
      expect(resolvePalette({ ...DEFAULT_APPEARANCE, accent: tone }).accent, tone).toBe(accent)
    }
  })

  it('keeps a custom accent clear of them, and a grey whatever its tint', () => {
    for (const tone of ['#ff00ff', '#12a0ff', '#8a8078', '#000000']) {
      expect(sanitizeAppearance({ ...DEFAULT_APPEARANCE, accent: tone }).accent).toBe(tone)
    }
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

/** An appearance that puts this preset on screen, through the slot its tone belongs to. */
function showing(id: string): Appearance {
  if (themeTone(id) === 'dark') return { ...DEFAULT_APPEARANCE, mode: 'dark', themeId: id }
  return { ...DEFAULT_APPEARANCE, mode: 'light', light: { themeId: id, ground: null, accent: null, overrides: {} } }
}

function ratio(palette: Palette, ink: ThemeToken, on: ThemeToken): number {
  return contrastRatio(rgb(palette[ink]), rgb(palette[on]))
}

function rgb(value: string): Rgb {
  const parsed = parseColor(value)
  if (parsed === null) throw new Error(`${value} is not a colour this palette can be measured in`)
  return parsed
}
