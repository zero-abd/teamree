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
  DEFAULT_LIGHT_THEME_ID,
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
  { ink: 'fg-secondary', on: 'bg-raised', least: 5.5, why: 'field labels, notice bodies, rail links' },
  { ink: 'fg-muted', on: 'bg-raised', least: 4.5, why: 'hints, counts, branch names, timestamps' },
  { ink: 'accent-bright', on: 'bg-raised', least: 4.5, why: 'the active combo row and the status bar branch' },
  { ink: 'accent-bright', on: 'bg-panel', least: 4.5, why: 'a commit sha, a hunk header, whose worktree a row is' },
  { ink: 'on-accent', on: 'accent', least: 4.5, why: 'the label on a primary button' },
  { ink: 'success', on: 'bg-raised', least: 4.5, why: 'a clean merge, a pane that finished' },
  { ink: 'warning', on: 'bg-raised', least: 4.5, why: 'what a discard is about to cost' },
  { ink: 'danger', on: 'bg-raised', least: 4.5, why: 'conflicts, failures, the destructive button' },
  { ink: 'info', on: 'bg-raised', least: 4.5, why: 'notices that are not errors' },
  { ink: 'working', on: 'bg-raised', least: 4.5, why: 'a working agent’s dot and its pane foot' },
  { ink: 'stopped', on: 'bg-raised', least: 4.5, why: 'an ended or restored pane' },
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
  { ink: 'fg-secondary', on: 'bg-panel', least: 5.5, why: 'a release’s notes, and what each teamwork step is for' },
  { ink: 'fg-muted', on: 'bg-panel', least: 4.5, why: 'the hints underneath them' },
  { ink: 'success', on: 'bg-panel', least: 4.5, why: 'a teamwork step that is finished' },
  { ink: 'warning', on: 'bg-panel', least: 4.5, why: 'one that is waiting on something else' },
  { ink: 'fg', on: 'bg-input', least: 7, why: 'the keystrokes a teammate is asking to run' },
  { ink: 'fg-secondary', on: 'bg-input', least: 5.5, why: 'git’s own words while a push streams' },
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
  // A light window's panes are white on a grey window, so a surface need only part from one of the two.
  it.each(ELEVATIONS)('%s is visibly off the window or the pane', (surface) => {
    expect(Math.max(ratio(palette, surface, 'bg-window'), ratio(palette, surface, 'bg-pane'))).toBeGreaterThan(1.05)
  })

  // The chip's own tint is darker than any surface on a light ground, so it is the accent ink's worst case.
  it('prints accent-bright readably on an accent-soft chip', () => {
    const chip = rgb(opaqueHex(palette['accent-soft'], rgb(palette['bg-raised'])) ?? '')
    expect(contrastRatio(rgb(palette['accent-bright']), chip)).toBeGreaterThanOrEqual(4.5)
  })

  // A pull request's checks are drawn straight on the sidebar, the Changes panel and the board; the press tint cost red AA.
  it.each(['bg-rail', 'bg-panel', 'bg-window'] as const)('prints check marks readably on %s', (ground) => {
    for (const ink of ['success', 'danger', 'fg-secondary'] as const) {
      expect(ratio(palette, ink, ground), ink).toBeGreaterThanOrEqual(4.5)
    }
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
  it('paints the terminal on the same ground as the pane', () => {
    expect(palette['term-bg']).toBe(palette['bg-pane'])
    if (themeTone(id) === 'dark') expect(palette['bg-pane']).toBe(palette['bg-window'])
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

    it('keeps its own accent', () => {
      expect(palette.accent).toBe(themeById(id).seed.accent)
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
    expect(resolvePalette(appearance, 'light')['bg-window']).toBe(themeById(DEFAULT_LIGHT_THEME_ID).seed.ground)
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

  it('keeps the project bar buttons choice, and leaves them shown when it is absent or not a yes or no', () => {
    expect(DEFAULT_APPEARANCE.projectButtons).toBeUndefined()
    expect(sanitizeAppearance({ ...DEFAULT_APPEARANCE, projectButtons: false }).projectButtons).toBe(false)
    expect(sanitizeAppearance({ ...DEFAULT_APPEARANCE, projectButtons: true }).projectButtons).toBe(true)
    expect(sanitizeAppearance({ ...DEFAULT_APPEARANCE, projectButtons: 'no' }).projectButtons).toBeUndefined()
  })
})

describe('Charcoal', () => {
  // Chosen from two measured options; every value here is the option's own.
  const OPTION: Partial<Palette> = {
    'bg-window': '#101114',
    'term-bg': '#101114',
    'bg-pane': '#101114',
    'bg-rail': '#1a1b20',
    'bg-tabstrip': '#24252a',
    'bg-panel': '#1d1e24',
    'bg-raised': '#292a30',
    'bg-input': '#121318',
    line: '#42434b',
    'line-strong': '#595b65',
    'bg-hover': 'rgb(238 241 248 / 7%)',
    'bg-press': 'rgb(238 241 248 / 12%)',
    'bg-selected': 'rgb(139 140 247 / 16%)',
    scrim: 'rgb(0 0 0 / 62%)',
    fg: '#e4e7ee',
    'fg-secondary': '#a0a2a7',
    'fg-muted': '#96979b',
    accent: '#8b8cf7'
  }

  const CHARCOAL: Appearance = { ...DEFAULT_APPEARANCE, mode: 'dark', themeId: 'charcoal' }

  it('is painted in the lifted option exactly', () => {
    const palette = resolvePalette(CHARCOAL)
    expect(Object.fromEntries(Object.keys(OPTION).map((token) => [token, palette[token as ThemeToken]]))).toEqual(
      OPTION
    )
  })

  // The option's selection is 30% accent over the ground; the search addon reads only solid hex.
  it('selects terminal text in the option’s 30% accent, flattened onto the ground', () => {
    expect(resolvePalette(CHARCOAL)['term-selection']).toBe('#353658')
  })

  it('steps each surface off its neighbour by at least 6 in every channel', () => {
    const palette = resolvePalette(CHARCOAL)
    const steps: [ThemeToken, ThemeToken][] = [
      ['bg-window', 'bg-rail'],
      ['bg-rail', 'bg-tabstrip'],
      ['bg-tabstrip', 'bg-pane'],
      ['bg-pane', 'bg-panel'],
      ['bg-panel', 'bg-raised']
    ]
    for (const [a, b] of steps) {
      const [x, y] = [rgb(palette[a]), rgb(palette[b])]
      expect(
        Math.min(Math.abs(x.r - y.r), Math.abs(x.g - y.g), Math.abs(x.b - y.b)),
        `${a} to ${b}`
      ).toBeGreaterThanOrEqual(6)
    }
  })

  it('keeps its measured steps only on its own ground', () => {
    const palette = resolvePalette({ ...CHARCOAL, ground: '#202020' })
    expect(palette['bg-rail']).not.toBe(OPTION['bg-rail'])
    expect(ratio(palette, 'bg-rail', 'bg-window')).toBeGreaterThan(1.05)
  })

  it('leaves Absolute Black absolute, #000000', () => {
    expect(themeById('black').seed.ground).toBe('#000000')
    expect(resolvePalette({ ...DEFAULT_APPEARANCE, mode: 'dark', themeId: 'black' })['bg-window']).toBe('#000000')
  })

  // The roles added with Studio follow the surfaces an older preset already has, so its look does not move.
  it('draws the newer roles from its own surfaces', () => {
    const palette = resolvePalette(CHARCOAL)
    expect(palette['bg-tabstrip-active']).toBe(palette['bg-raised'])
    expect(palette['bg-elevated']).toBe(palette['bg-raised'])
    expect(palette['bg-worktree']).toBe(palette['bg-raised'])
    expect(palette['bg-sunken']).toBe(palette['bg-input'])
    expect(palette['bg-code']).toBe(palette['bg-input'])
    expect(palette.working).toBe(palette.info)
    expect(palette.stopped).toBe(palette['fg-muted'])
  })

  it('lets a follower track an edit to the surface it follows, unless it is edited itself', () => {
    const raised = resolvePalette({ ...CHARCOAL, overrides: { 'bg-raised': '#333338' } })
    expect(raised['bg-elevated']).toBe('#333338')
    const both = resolvePalette({ ...CHARCOAL, overrides: { 'bg-raised': '#333338', 'bg-elevated': '#444449' } })
    expect(both['bg-elevated']).toBe('#444449')
  })
})

describe('the default, Studio', () => {
  // The design's own values; bg-tabstrip and bg-panel sit a step higher than drawn, to clear the step rule.
  const STUDIO: Partial<Palette> = {
    'bg-window': '#0b0d12',
    'bg-pane': '#0b0d12',
    'bg-rail': '#11141b',
    'bg-tabstrip': '#111419',
    'bg-tabstrip-active': '#141821',
    'bg-panel': '#11141b',
    'bg-raised': '#171b24',
    'bg-worktree': '#151923',
    'bg-elevated': '#1c202a',
    'bg-sunken': '#080a0f',
    'bg-code': '#0a0c11',
    'bg-input': '#0d1016',
    'bg-hover': 'rgb(236 239 255 / 6%)',
    'bg-press': 'rgb(236 239 255 / 10%)',
    'bg-selected': 'rgb(116 103 255 / 15%)',
    scrim: 'rgb(2 3 7 / 74%)',
    line: '#272c38',
    'line-strong': '#3b4251',
    'line-subtle': '#1b202a',
    fg: '#f1f3f8',
    'fg-secondary': '#aeb4c0',
    'fg-muted': '#7f8795',
    'fg-faint': '#5e6674',
    accent: '#6d5bf2',
    'accent-bright': '#958bff',
    'accent-hover': '#6754e8',
    'accent-press': '#5f4bd2',
    'on-accent': '#ffffff',
    success: '#48c78e',
    warning: '#e8a84c',
    danger: '#ef6a73',
    info: '#58a6e7',
    working: '#49a8f2',
    stopped: '#7f8795',
    'term-bg': '#0b0d12',
    'term-fg': '#dfe3eb',
    'term-selection': '#302b69'
  }
  const STUDIO_LIGHT: Partial<Palette> = {
    'bg-window': '#f4f5f8',
    'bg-pane': '#ffffff',
    'bg-rail': '#eef0f4',
    'bg-tabstrip': '#f7f8fa',
    'bg-tabstrip-active': '#ffffff',
    'bg-panel': '#f3f4f7',
    'bg-raised': '#ffffff',
    'bg-elevated': '#ffffff',
    'bg-sunken': '#e9ebf0',
    line: '#d9dde5',
    'line-strong': '#b8bec9',
    fg: '#171a22',
    'fg-secondary': '#505866',
    'fg-muted': '#626b79',
    accent: '#5848df',
    'accent-bright': '#4c3bd5',
    'on-accent': '#ffffff',
    success: '#177a50',
    warning: '#9b5f08',
    danger: '#bd3848',
    working: '#176da8',
    'term-bg': '#ffffff',
    'term-fg': '#20242d'
  }
  const pick = (palette: Palette, wanted: Partial<Palette>): Partial<Palette> =>
    Object.fromEntries(Object.keys(wanted).map((token) => [token, palette[token as ThemeToken]]))

  it('opens a new installation on Studio in the dark and Studio Light in the light', () => {
    expect(DEFAULT_THEME_ID).toBe('studio')
    expect(DEFAULT_LIGHT_THEME_ID).toBe('studio-light')
    expect(themeTone(DEFAULT_THEME_ID)).toBe('dark')
    expect(themeTone(DEFAULT_LIGHT_THEME_ID)).toBe('light')
  })

  it('is painted in the design’s values', () => {
    expect(pick(resolvePalette({ ...DEFAULT_APPEARANCE, mode: 'dark' }), STUDIO)).toEqual(STUDIO)
    expect(pick(resolvePalette({ ...DEFAULT_APPEARANCE, mode: 'light' }), STUDIO_LIGHT)).toEqual(STUDIO_LIGHT)
  })

  it('draws working in its own blue, never the accent', () => {
    for (const tone of ['dark', 'light'] as const) {
      const palette = resolvePalette({ ...DEFAULT_APPEARANCE, mode: tone })
      expect(palette.working).not.toBe(palette.accent)
      expect(palette.working).not.toBe(palette['accent-bright'])
    }
  })

  it('steps each borderless surface off the pane by at least 6 in every channel', () => {
    const palette = resolvePalette({ ...DEFAULT_APPEARANCE, mode: 'dark' })
    const steps: [ThemeToken, ThemeToken][] = [
      ['bg-pane', 'bg-rail'],
      ['bg-pane', 'bg-tabstrip'],
      ['bg-pane', 'bg-panel'],
      ['bg-panel', 'bg-raised']
    ]
    for (const [a, b] of steps) {
      const [x, y] = [rgb(palette[a]), rgb(palette[b])]
      expect(
        Math.min(Math.abs(x.r - y.r), Math.abs(x.g - y.g), Math.abs(x.b - y.b)),
        `${a} to ${b}`
      ).toBeGreaterThanOrEqual(6)
    }
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
    // Every accent role follows it, not only the fill.
    expect(palette['accent-hover']).not.toBe('#6754e8')
    expect(palette['bg-selected']).toBe('rgb(224 112 192 / 16%)')
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
    expect(ACCENT_PRESETS.map((option) => option.name)).toEqual([
      'Studio Violet',
      'Violet',
      'Sky',
      'Teal',
      'Orchid',
      'Pink',
      'Graphite'
    ])
    expect(ACCENT_PRESETS[0]?.value).toBe('#6d5bf2')
    expect(ACCENT_PRESETS[1]?.value).toBe(DEFAULT_ACCENT)
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
