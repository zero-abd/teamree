// The palette, as data rather than as a stylesheet.
//
// Every colour the window paints comes from here. `tokens.css` still declares
// the whole set — so the app renders correctly before any script runs, and so a
// stylesheet author has one file to read — but at startup the renderer resolves
// the stored appearance through this module and writes the result onto the root
// element, which is what makes a theme switchable and editable at all.
//
// Two decisions shape the file.
//
// The first is that a theme is a seed, not a table. Four grounds and a handful
// of hues expand into forty-odd tokens by one set of rules, so a preset and a
// palette somebody built themselves by typing a hex code go through exactly the
// same derivation — there is no path where a custom ground gets a worse
// elevation ramp than a shipped one, because there is only one ramp.
//
// The second is that the derivation ends in a legibility pass. Every ink is
// pushed away from the surface it sits on until it clears its WCAG target, so
// the answer to "what if somebody sets the foreground to the background" is
// that the app stays readable and their colour comes back lifted. That pass is
// what makes an editable theme safe to ship, and `theme.test.ts` measures it on
// every built-in and on deliberately hostile input.

import { contrastRatio, ensureContrast, mix, parseColor, toHex, withAlpha, type Rgb } from './color'

/**
 * Every themeable custom property, without its `--` prefix.
 *
 * The order is the order they are declared in `tokens.css`, and
 * `stylesheets.test.ts` holds the two lists to each other: a token in one and
 * not the other is a colour that either cannot be themed or cannot be styled.
 */
export const THEME_TOKENS = [
  'bg-window',
  'bg-rail',
  'bg-panel',
  'bg-raised',
  'bg-input',
  'bg-hover',
  'bg-press',
  'scrim',
  'line',
  'line-strong',
  'fg',
  'fg-secondary',
  'fg-muted',
  'accent',
  'accent-bright',
  'accent-soft',
  'accent-line',
  'on-accent',
  'success',
  'warning',
  'danger',
  'info',
  'term-bg',
  'term-fg',
  'term-cursor',
  'term-selection',
  'term-black',
  'term-red',
  'term-green',
  'term-yellow',
  'term-blue',
  'term-magenta',
  'term-cyan',
  'term-white',
  'term-bright-black',
  'term-bright-red',
  'term-bright-green',
  'term-bright-yellow',
  'term-bright-blue',
  'term-bright-magenta',
  'term-bright-cyan',
  'term-bright-white'
] as const

export type ThemeToken = (typeof THEME_TOKENS)[number]

/** A fully resolved palette: one value per token, ready to write onto the DOM. */
export type Palette = Record<ThemeToken, string>

/** The six hues both the interface and the terminal draw from. */
export type Hues = {
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
}

/**
 * Everything a theme actually decides. The rest is arithmetic.
 *
 * `surface` is not a colour anything is painted in — it is the direction the
 * elevation ramp travels. A neutral grey climbs to grey; a pale blue climbs to
 * the cool cast the app had before absolute black became the default, which is
 * how that palette survives here as a preset rather than as a second
 * hand-written table.
 */
export type ThemeSeed = {
  ground: string
  surface: string
  /** The brightest text. Everything dimmer is mixed back towards the ground. */
  ink: string
  accent: string
  hues: Hues
  /**
   * What the dimmest text must clear against the lightest surface it sits on.
   *
   * 4.5 is AA for body text and the floor everywhere. A theme can ask for more,
   * which is the whole of what makes the high-contrast preset different: same
   * ground, same hues, inks and hairlines that refuse to recede.
   */
  mutedContrast: number
  /** Multiplies the hairline ramp, so a theme can draw its lines harder. */
  lineWeight: number
}

export type BuiltInTheme = {
  id: string
  name: string
  /** One line, shown beside the name in the picker. */
  blurb: string
  seed: ThemeSeed
}

/**
 * The hues, shared by every preset.
 *
 * One set rather than one per theme because these are meanings before they are
 * colours — red is a test that failed and a file in conflict, green is a clean
 * merge — and a palette that restated them per theme would be four chances for
 * "failed" to stop looking like failure. Each is lifted per theme to clear its
 * target against that theme's surfaces, which is the only adjustment it needs.
 */
const HUES: Hues = {
  red: '#e8615a',
  green: '#57c38a',
  yellow: '#d6a24a',
  blue: '#5aa9e6',
  magenta: '#a98bf0',
  cyan: '#4fb6b2'
}

/** The accent every preset starts from, and the wordmark's dot. */
export const DEFAULT_ACCENT = '#8b8cf7'

/**
 * The accents offered as one press in the editor.
 *
 * Six, not a wheel: the point of the row is that somebody who wants a different
 * colour gets one without thinking about hex, and any of these lands on a
 * palette that has been measured. The field beside them is for everybody else.
 */
export const ACCENT_PRESETS: readonly { name: string; value: string }[] = [
  { name: 'Indigo', value: DEFAULT_ACCENT },
  { name: 'Sky', value: '#5aa9e6' },
  { name: 'Teal', value: '#3fbfa6' },
  { name: 'Lime', value: '#8fc65a' },
  { name: 'Amber', value: '#e0a13e' },
  { name: 'Rose', value: '#ef6b87' }
]

export const BUILT_IN_THEMES: readonly BuiltInTheme[] = [
  {
    id: 'black',
    name: 'Absolute Black',
    blurb: 'A true #000 ground. Panes float on nothing; only the chrome is lit.',
    seed: {
      ground: '#000000',
      // Barely cool. On a pure black ground a neutral grey ramp reads faintly
      // green beside the terminal's own output, and a hint of blue in the
      // elevations is what keeps the chrome looking deliberate rather than
      // washed.
      surface: '#eef1f8',
      ink: '#e4e7ee',
      accent: DEFAULT_ACCENT,
      hues: HUES,
      mutedContrast: 4.5,
      lineWeight: 1
    }
  },
  {
    id: 'black-hc',
    name: 'Black, high contrast',
    blurb: 'The same ground with nothing dim on it: every ink clears 7:1, every line is drawn to be seen.',
    seed: {
      ground: '#000000',
      surface: '#ffffff',
      ink: '#ffffff',
      accent: DEFAULT_ACCENT,
      hues: HUES,
      mutedContrast: 7,
      lineWeight: 1.9
    }
  },
  {
    id: 'midnight',
    name: 'Midnight',
    blurb: 'The blue-black this app shipped with, kept so nobody loses the window they know.',
    seed: {
      ground: '#0a0c10',
      surface: '#99b7f5',
      ink: '#dfe5ee',
      accent: DEFAULT_ACCENT,
      hues: HUES,
      mutedContrast: 4.5,
      lineWeight: 1
    }
  },
  {
    id: 'graphite',
    name: 'Graphite',
    blurb: 'Neutral grey with no cast at all, and more light in the surfaces for rooms that have some.',
    seed: {
      ground: '#131315',
      surface: '#ffffff',
      ink: '#e9e9ec',
      accent: DEFAULT_ACCENT,
      hues: HUES,
      mutedContrast: 4.5,
      lineWeight: 1.1
    }
  }
]

export const DEFAULT_THEME_ID = 'black'

export function themeById(id: string): BuiltInTheme {
  return BUILT_IN_THEMES.find((theme) => theme.id === id) ?? (BUILT_IN_THEMES[0] as BuiltInTheme)
}

/**
 * A person's appearance choice, as it is stored and as it travels.
 *
 * Three layers, coarse to fine: a preset, the two decisions worth making
 * without opening anything — the ground it sits on and the accent it points
 * with — and then literal per-token edits for anybody who wants them. Each
 * layer only ever overrides the one above it, so "reset the accent" is dropping
 * one field rather than rebuilding a palette.
 */
export type Appearance = {
  themeId: string
  /** Replaces the preset's ground, and with it the whole elevation ramp. */
  ground: string | null
  accent: string | null
  /**
   * Literal values for named tokens, applied after everything is derived.
   *
   * Keyed by token name as a plain string rather than by `ThemeToken`, because
   * this shape crosses the wire and comes back off disk: a file written by a
   * build that had a token this one does not is a file this one still has to
   * read. Keys that are not tokens are dropped by `sanitizeAppearance` and
   * ignored by the derivation, so an unknown one costs nothing.
   */
  overrides: Readonly<Record<string, string>>
}

export const DEFAULT_APPEARANCE: Appearance = {
  themeId: DEFAULT_THEME_ID,
  ground: null,
  accent: null,
  overrides: {}
}

/** True when nothing has been changed away from the preset. */
export function isPristine(appearance: Appearance): boolean {
  return appearance.ground === null && appearance.accent === null && Object.keys(appearance.overrides).length === 0
}

/**
 * Whatever was stored, as an appearance this app will accept.
 *
 * Never throws, and never refuses a whole document over one bad field: an
 * unknown preset falls back to the default, an unparseable colour is dropped,
 * and a token nobody has heard of is left out. A colour file is hand-edited
 * more often than anybody admits, and the cost of being strict here is an app
 * that opens with no theme at all.
 */
export function sanitizeAppearance(raw: unknown): Appearance {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_APPEARANCE
  const record = raw as Record<string, unknown>

  const themeId =
    typeof record.themeId === 'string' && BUILT_IN_THEMES.some((theme) => theme.id === record.themeId)
      ? record.themeId
      : DEFAULT_THEME_ID

  const overrides: Record<string, string> = {}
  if (typeof record.overrides === 'object' && record.overrides !== null) {
    for (const [key, value] of Object.entries(record.overrides as Record<string, unknown>)) {
      if (!isThemeToken(key) || typeof value !== 'string') continue
      const parsed = parseColor(value)
      if (parsed !== null) overrides[key] = toHex(parsed)
    }
  }

  return { themeId, ground: hexOrNull(record.ground), accent: hexOrNull(record.accent), overrides }
}

export function isThemeToken(name: string): name is ThemeToken {
  return (THEME_TOKENS as readonly string[]).includes(name)
}

function hexOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const parsed = parseColor(value)
  return parsed === null ? null : toHex(parsed)
}

/** The whole pipeline: preset, then the two choices, then the literal edits. */
export function resolvePalette(appearance: Appearance): Palette {
  const clean = sanitizeAppearance(appearance)
  const base = themeById(clean.themeId).seed
  const seed: ThemeSeed = { ...base, ground: clean.ground ?? base.ground, accent: clean.accent ?? base.accent }
  return guard(applyOverrides(buildPalette(seed), clean.overrides), seed)
}

/**
 * How far each surface climbs from the ground towards the theme's surface
 * colour.
 *
 * Tuned against `#000000` rather than against a near-black, because that is the
 * hard case and the default. These are the smallest steps that still separate a
 * panel from the window behind it on true black; on a ground that is already
 * lit they land proportionally gentler, which is what the eye expects.
 */
const RAMP = {
  rail: 0.045,
  panel: 0.055,
  raised: 0.095,
  line: 0.12,
  lineStrong: 0.21
} as const

export function buildPalette(seed: ThemeSeed): Palette {
  const ground = parseColor(seed.ground) ?? black()
  const surface = parseColor(seed.surface) ?? white()
  const darkGround = isDark(ground)

  const step = (amount: number): Rgb => mix(ground, surface, amount)
  const rail = step(RAMP.rail)
  const panel = step(RAMP.panel)
  const raised = step(RAMP.raised)
  const line = step(RAMP.line * seed.lineWeight)
  const lineStrong = step(RAMP.lineStrong * seed.lineWeight)

  // Fields are cut into the surface rather than raised off it, so they travel
  // the other way. On a ground already at the end of its axis there is nowhere
  // to go, and the field is read from its border instead — which is why every
  // input in the stylesheets has one.
  const input = mix(ground, darkGround ? black() : white(), 0.4)

  const ink = ensureContrast(parseColor(seed.ink) ?? white(), ground, 11)
  // Measured against the lightest surface each lands on, not against the
  // ground: text on a raised card has the least contrast to work with, and a
  // palette tuned to the window behind it would fail exactly where the dialogs
  // are.
  const secondary = ensureContrast(mix(ink, ground, 0.3), raised, Math.max(seed.mutedContrast, 6.5))
  const muted = ensureContrast(mix(ink, ground, 0.5), raised, seed.mutedContrast)

  const accent = parseColor(seed.accent) ?? (parseColor(DEFAULT_ACCENT) as Rgb)
  // The accent as an ink, which is a different job from the accent as a fill: a
  // branch name in the status rail and the active row of a combo box are both
  // drawn in this, so it has to be readable rather than merely visible.
  const accentBright = ensureContrast(mix(accent, darkGround ? white() : black(), 0.16), raised, 4.5)
  // Label on a filled accent button. Tinted rather than flat black or flat
  // white: the primary button is the one saturated shape on screen, and pure
  // black text on a mid-tone fill is the thing that makes a button look like a
  // sticker instead of like part of the window.
  const onAccent = ensureContrast(
    contrastRatio(accent, black()) >= contrastRatio(accent, white())
      ? mix(accent, black(), 0.9)
      : mix(accent, white(), 0.92),
    accent,
    4.5
  )

  const hue = (value: string, against: Rgb): Rgb =>
    ensureContrast(parseColor(value) ?? ink, against, Math.max(seed.mutedContrast, 4.5))

  // The terminal shares the window's ground, so a pane and the chrome around it
  // are one surface rather than two shades of dark that never quite agree.
  const termBg = ground
  const termHue = (value: string): Rgb => hue(value, termBg)
  const bright = (value: Rgb): Rgb =>
    ensureContrast(mix(value, darkGround ? white() : black(), 0.22), termBg, Math.max(seed.mutedContrast, 4.5))

  const red = termHue(seed.hues.red)
  const green = termHue(seed.hues.green)
  const yellow = termHue(seed.hues.yellow)
  const blue = termHue(seed.hues.blue)
  const magenta = termHue(seed.hues.magenta)
  const cyan = termHue(seed.hues.cyan)

  return {
    'bg-window': toHex(ground),
    'bg-rail': toHex(rail),
    'bg-panel': toHex(panel),
    'bg-raised': toHex(raised),
    'bg-input': toHex(input),
    'bg-hover': withAlpha(surface, 0.05),
    'bg-press': withAlpha(surface, 0.09),
    scrim: withAlpha(mix(ground, black(), 0.5), 0.66),
    line: toHex(line),
    'line-strong': toHex(lineStrong),
    fg: toHex(ink),
    'fg-secondary': toHex(secondary),
    'fg-muted': toHex(muted),
    accent: toHex(accent),
    'accent-bright': toHex(accentBright),
    'accent-soft': withAlpha(accent, 0.16),
    'accent-line': withAlpha(accent, 0.55),
    'on-accent': toHex(onAccent),
    // The four meanings, measured against the raised surface for the same
    // reason the inks are: a chip on a dialog is the worst case.
    success: toHex(hue(seed.hues.green, raised)),
    warning: toHex(hue(seed.hues.yellow, raised)),
    danger: toHex(hue(seed.hues.red, raised)),
    info: toHex(hue(seed.hues.blue, raised)),
    'term-bg': toHex(termBg),
    'term-fg': toHex(ink),
    'term-cursor': toHex(accentBright),
    // Solid, not translucent: the search addon parses this itself and
    // understands nothing but `#rrggbb`, so a selection carrying alpha would
    // quietly fall back to a colour from another theme.
    'term-selection': toHex(mix(termBg, accent, 0.34)),
    'term-black': toHex(mix(termBg, surface, 0.14)),
    'term-red': toHex(red),
    'term-green': toHex(green),
    'term-yellow': toHex(yellow),
    'term-blue': toHex(blue),
    'term-magenta': toHex(magenta),
    'term-cyan': toHex(cyan),
    'term-white': toHex(mix(ink, ground, 0.18)),
    // Dim grey is what most coding agents print their reasoning in, so this one
    // is held to the body-text floor rather than left as decoration.
    'term-bright-black': toHex(ensureContrast(mix(termBg, surface, 0.42), termBg, Math.max(seed.mutedContrast, 4.5))),
    'term-bright-red': toHex(bright(red)),
    'term-bright-green': toHex(bright(green)),
    'term-bright-yellow': toHex(bright(yellow)),
    'term-bright-blue': toHex(bright(blue)),
    'term-bright-magenta': toHex(bright(magenta)),
    'term-bright-cyan': toHex(bright(cyan)),
    'term-bright-white': toHex(ink)
  }
}

/** The editor's own values, laid over the derived ones. */
function applyOverrides(palette: Palette, overrides: Appearance['overrides']): Palette {
  const next: Palette = { ...palette }
  for (const [token, value] of Object.entries(overrides)) {
    if (!isThemeToken(token)) continue
    const parsed = parseColor(value)
    if (parsed !== null) next[token] = toHex(parsed)
  }
  return next
}

/**
 * Every foreground in the palette, measured against the surface it is painted
 * on and lifted until it clears.
 *
 * An override is somebody's taste and is taken at its word, right up to the
 * point where it would make something unreadable; past that it is lifted off
 * its surface exactly as a preset's colour would be. This is why the editor
 * needs no validation of its own, and why there is no way to type yourself out
 * of the window you are typing in.
 *
 * The pairs are listed rather than inferred, because which background an ink
 * lands on is a fact about the stylesheets and nothing in a colour can tell you
 * it. Each names the worst case: the lightest surface the ink appears on.
 */
function guard(palette: Palette, seed: ThemeSeed): Palette {
  const floor = Math.max(seed.mutedContrast, 4.5)
  const pairs: readonly [ThemeToken, ThemeToken, number][] = [
    ['fg', 'bg-raised', 7],
    ['fg-secondary', 'bg-raised', Math.max(floor, 6.5)],
    ['fg-muted', 'bg-raised', floor],
    ['accent-bright', 'bg-raised', 4.5],
    ['on-accent', 'accent', 4.5],
    ['success', 'bg-raised', floor],
    ['warning', 'bg-raised', floor],
    ['danger', 'bg-raised', floor],
    ['info', 'bg-raised', floor],
    ['term-fg', 'term-bg', 7],
    ['term-red', 'term-bg', floor],
    ['term-green', 'term-bg', floor],
    ['term-yellow', 'term-bg', floor],
    ['term-blue', 'term-bg', floor],
    ['term-magenta', 'term-bg', floor],
    ['term-cyan', 'term-bg', floor],
    ['term-white', 'term-bg', floor],
    ['term-bright-black', 'term-bg', floor],
    ['term-bright-red', 'term-bg', floor],
    ['term-bright-green', 'term-bg', floor],
    ['term-bright-yellow', 'term-bg', floor],
    ['term-bright-blue', 'term-bg', floor],
    ['term-bright-magenta', 'term-bg', floor],
    ['term-bright-cyan', 'term-bg', floor],
    ['term-bright-white', 'term-bg', 7]
  ]

  const next: Palette = { ...palette }
  for (const [ink, surface, target] of pairs) {
    const foreground = parseColor(next[ink])
    const background = parseColor(next[surface])
    if (foreground === null || background === null) continue
    next[ink] = toHex(ensureContrast(foreground, background, target))
  }
  return next
}

function isDark(color: Rgb): boolean {
  return contrastRatio(color, white()) > contrastRatio(color, black())
}

function white(): Rgb {
  return { r: 255, g: 255, b: 255 }
}

function black(): Rgb {
  return { r: 0, g: 0, b: 0 }
}
