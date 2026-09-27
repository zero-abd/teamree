// The palette as data: a theme is a seed (ground, surface, ink, accent, hues)
// expanded into every token by one derivation, then a WCAG legibility pass.
// `tokens.css` declares the same set so the app renders before any script runs.

import { contrastRatio, ensureContrast, mix, opaqueHex, parseColor, toHex, withAlpha, type Rgb } from './color'

/**
 * Every themeable custom property, without its `--` prefix, in `tokens.css`
 * declaration order; `stylesheets.test.ts` holds the two lists to each other.
 */
export const THEME_TOKENS = [
  'bg-window',
  'bg-pane',
  'bg-rail',
  'bg-tabstrip',
  'bg-panel',
  'bg-raised',
  'bg-input',
  'bg-hover',
  'bg-press',
  'bg-selected',
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
  'term-bright-white',
  'bg-tabstrip-active',
  'bg-elevated',
  'bg-sunken',
  'bg-worktree',
  'bg-code',
  'line-subtle',
  'fg-faint',
  'accent-hover',
  'accent-press',
  'working',
  'stopped'
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

/** Everything a theme actually decides. The rest is arithmetic. */
export type ThemeSeed = {
  ground: string
  /** Not painted anywhere: the direction the elevation ramp travels from the ground. */
  surface: string
  /** The brightest text. Everything dimmer is mixed back towards the ground. */
  ink: string
  accent: string
  hues: Hues
  /** What the dimmest text must clear against the lightest surface it sits on; 4.5 (AA) is the floor. */
  mutedContrast: number
  /** Multiplies the hairline ramp, so a theme can draw its lines harder. */
  lineWeight: number
  /** What secondary text must clear against a raised card; 6.5 when absent. */
  secondaryContrast?: number
  /** How much accent a terminal selection mixes into the ground; 0.34 when absent. */
  selection?: number
}

export type BuiltInTheme = {
  id: string
  name: string
  seed: ThemeSeed
  /** Literal values laid over the derived ones while the preset's own ground is on screen. */
  tokens?: Readonly<Partial<Record<ThemeToken, string>>>
}

// One set of hues for every preset: they are meanings (red failed, green merged)
// before they are colours, and each is lifted per theme to clear its surfaces.
const HUES: Hues = {
  red: '#e8615a',
  green: '#57c38a',
  yellow: '#d6a24a',
  blue: '#5aa9e6',
  magenta: '#a98bf0',
  cyan: '#4fb6b2'
}

/** The accent the older presets start from, and the wordmark's dot. */
export const DEFAULT_ACCENT = '#8b8cf7'

const STUDIO_ACCENT = '#6d5bf2'

/** The accents offered as one press in the editor, each clear of the asking, done and failed hues. */
export const ACCENT_PRESETS: readonly { name: string; value: string }[] = [
  { name: 'Studio Violet', value: STUDIO_ACCENT },
  { name: 'Violet', value: DEFAULT_ACCENT },
  { name: 'Sky', value: '#5aa9e6' },
  { name: 'Teal', value: '#3bb8c4' },
  { name: 'Orchid', value: '#b584f5' },
  { name: 'Pink', value: '#e070c0' },
  { name: 'Graphite', value: '#9aa1ad' }
]

// Lime, Amber and Rose were offered once; Lime is too far from green for the hue test to catch.
const RETIRED_ACCENTS: readonly string[] = ['#8fc65a', '#e0a13e', '#ef6b87']
const STATE_HUES = [HUES.yellow, HUES.green, HUES.red].map((tone) => hueOf(parseColor(tone) as Rgb) as number)
const STATE_HUE_BAND = 20

/** The accent as stored, unless it would read as asking, done or failed: then the nearest preset by hue. */
export function allowedAccent(value: string): string {
  const parsed = parseColor(value)
  if (parsed === null) return value
  const hex = toHex(parsed)
  const hue = hueOf(parsed)
  if (hue === null) return hex
  if (!RETIRED_ACCENTS.includes(hex) && STATE_HUES.every((state) => hueApart(hue, state) > STATE_HUE_BAND)) return hex
  let nearest = DEFAULT_ACCENT
  let best = Infinity
  for (const { value: preset } of ACCENT_PRESETS) {
    const presetHue = hueOf(parseColor(preset) as Rgb)
    if (presetHue === null || hueApart(hue, presetHue) >= best) continue
    best = hueApart(hue, presetHue)
    nearest = preset
  }
  return nearest
}

/** Degrees round the colour wheel, or null for a grey, whose hue nobody reads. */
function hueOf({ r, g, b }: Rgb): number | null {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const lightness = (max + min) / 510
  const saturation = max === min ? 0 : (max - min) / 255 / (1 - Math.abs(2 * lightness - 1))
  if (saturation < 0.25) return null
  const d = max - min
  const sector = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (sector * 60 + 360) % 360
}

function hueApart(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return Math.min(d, 360 - d)
}

export const BUILT_IN_THEMES: readonly BuiltInTheme[] = [
  {
    id: 'studio',
    name: 'Studio',
    seed: {
      ground: '#0b0d12',
      surface: '#eef1ff',
      ink: '#f1f3f8',
      accent: STUDIO_ACCENT,
      hues: {
        red: '#ef6a73',
        green: '#48c78e',
        yellow: '#e8a84c',
        blue: '#58a6e7',
        magenta: '#b68cff',
        cyan: '#48b8c7'
      },
      mutedContrast: 4.5,
      lineWeight: 1,
      secondaryContrast: 5.5
    },
    // Drawn, not derived. bg-tabstrip and bg-panel sit one step above the drawing to clear the step rule.
    tokens: {
      'bg-window': '#0b0d12',
      'bg-pane': '#0b0d12',
      'bg-rail': '#11141b',
      'bg-tabstrip': '#111419',
      'bg-panel': '#11141b',
      'bg-raised': '#171b24',
      'bg-input': '#0d1016',
      'bg-hover': 'rgb(236 239 255 / 6%)',
      'bg-press': 'rgb(236 239 255 / 10%)',
      'bg-selected': 'rgb(116 103 255 / 15%)',
      scrim: 'rgb(2 3 7 / 74%)',
      line: '#272c38',
      'line-strong': '#3b4251',
      fg: '#f1f3f8',
      'fg-secondary': '#aeb4c0',
      'fg-muted': '#7f8795',
      accent: STUDIO_ACCENT,
      'accent-bright': '#958bff',
      'accent-soft': 'rgb(116 103 255 / 15%)',
      'accent-line': 'rgb(149 139 255 / 58%)',
      'on-accent': '#ffffff',
      success: '#48c78e',
      warning: '#e8a84c',
      danger: '#ef6a73',
      info: '#58a6e7',
      'term-bg': '#0b0d12',
      'term-fg': '#dfe3eb',
      'term-cursor': '#958bff',
      'term-selection': '#302b69',
      'term-black': '#303642',
      'term-red': '#ef6a73',
      'term-green': '#48c78e',
      'term-yellow': '#e8a84c',
      'term-blue': '#58a6e7',
      'term-magenta': '#b68cff',
      'term-cyan': '#48b8c7',
      'term-white': '#c5cad4',
      'term-bright-black': '#737b89',
      'term-bright-red': '#f38d94',
      'term-bright-green': '#75d7ad',
      'term-bright-yellow': '#efbf78',
      'term-bright-blue': '#80bced',
      'term-bright-magenta': '#c9aaff',
      'term-bright-cyan': '#76ccd6',
      'term-bright-white': '#f1f3f8',
      'bg-tabstrip-active': '#141821',
      'bg-elevated': '#1c202a',
      'bg-sunken': '#080a0f',
      'bg-worktree': '#151923',
      'bg-code': '#0a0c11',
      'line-subtle': '#1b202a',
      'fg-faint': '#5e6674',
      'accent-hover': '#6754e8',
      'accent-press': '#5f4bd2',
      working: '#49a8f2',
      stopped: '#7f8795'
    }
  },
  {
    id: 'studio-light',
    name: 'Studio Light',
    seed: {
      ground: '#f4f5f8',
      surface: '#1f2637',
      ink: '#171a22',
      accent: '#5848df',
      hues: {
        red: '#bd3848',
        green: '#177a50',
        yellow: '#9b5f08',
        blue: '#17689e',
        magenta: '#744db0',
        cyan: '#14747e'
      },
      mutedContrast: 4.5,
      lineWeight: 1,
      secondaryContrast: 5.5
    },
    tokens: {
      'bg-window': '#f4f5f8',
      'bg-pane': '#ffffff',
      'bg-rail': '#eef0f4',
      'bg-tabstrip': '#f7f8fa',
      'bg-panel': '#f3f4f7',
      'bg-raised': '#ffffff',
      'bg-input': '#ffffff',
      'bg-hover': 'rgb(31 38 55 / 5%)',
      'bg-press': 'rgb(31 38 55 / 9%)',
      'bg-selected': 'rgb(85 70 230 / 11%)',
      scrim: 'rgb(16 20 30 / 40%)',
      line: '#d9dde5',
      'line-strong': '#b8bec9',
      fg: '#171a22',
      'fg-secondary': '#505866',
      'fg-muted': '#626b79',
      accent: '#5848df',
      'accent-bright': '#4c3bd5',
      'accent-soft': 'rgb(88 72 223 / 11%)',
      'accent-line': 'rgb(76 59 213 / 42%)',
      'on-accent': '#ffffff',
      success: '#177a50',
      warning: '#9b5f08',
      danger: '#bd3848',
      info: '#17689e',
      'term-bg': '#ffffff',
      'term-fg': '#20242d',
      'term-cursor': '#5848df',
      'term-selection': '#dcd8ff',
      'term-black': '#2b303a',
      'term-red': '#bd3848',
      'term-green': '#177a50',
      'term-yellow': '#9b5f08',
      'term-blue': '#17689e',
      'term-magenta': '#744db0',
      'term-cyan': '#14747e',
      'term-white': '#6b7280',
      // Lifted from the drawn #737b89, which measures 4.4:1 on white.
      'term-bright-black': '#707785',
      'term-bright-red': '#9e2c3a',
      'term-bright-green': '#11633f',
      'term-bright-yellow': '#7b4b06',
      'term-bright-blue': '#11557f',
      'term-bright-magenta': '#5d3d8d',
      'term-bright-cyan': '#105d65',
      'term-bright-white': '#171a22',
      'bg-tabstrip-active': '#ffffff',
      'bg-elevated': '#ffffff',
      'bg-sunken': '#e9ebf0',
      'bg-worktree': '#f8f9fb',
      'bg-code': '#fafbfc',
      'line-subtle': '#e8eaf0',
      'fg-faint': '#8b93a1',
      'accent-hover': '#4f3ed5',
      'accent-press': '#4232bd',
      working: '#176da8',
      stopped: '#626b79'
    }
  },
  {
    id: 'charcoal',
    name: 'Charcoal',
    seed: {
      ground: '#101114',
      surface: '#eef1f8',
      ink: '#e4e7ee',
      accent: DEFAULT_ACCENT,
      hues: HUES,
      mutedContrast: 4.5,
      lineWeight: 1,
      secondaryContrast: 5.5,
      selection: 0.3
    },
    // Measured steps rather than one ramp: the tab strip sits above the rail, the panel between.
    tokens: {
      'bg-rail': '#1a1b20',
      'bg-tabstrip': '#24252a',
      'bg-panel': '#1d1e24',
      'bg-raised': '#292a30',
      'bg-input': '#121318',
      'bg-hover': 'rgb(238 241 248 / 7%)',
      'bg-press': 'rgb(238 241 248 / 12%)',
      scrim: 'rgb(0 0 0 / 62%)',
      line: '#42434b',
      'line-strong': '#595b65',
      'fg-secondary': '#a0a2a7',
      'fg-muted': '#96979b'
    }
  },
  {
    id: 'black',
    name: 'Absolute Black',
    seed: {
      ground: '#000000',
      // Barely cool: on pure black a neutral grey ramp reads faintly green
      // beside terminal output.
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
    seed: {
      ground: '#131315',
      surface: '#ffffff',
      ink: '#e9e9ec',
      accent: DEFAULT_ACCENT,
      hues: HUES,
      mutedContrast: 4.5,
      lineWeight: 1.1
    }
  },
  {
    id: 'light',
    name: 'Light',
    seed: {
      ground: '#ffffff',
      surface: '#1c2233',
      ink: '#15171c',
      accent: DEFAULT_ACCENT,
      hues: HUES,
      mutedContrast: 4.5,
      lineWeight: 1
    }
  },
  {
    id: 'paper',
    name: 'Paper',
    seed: {
      ground: '#f7f5f0',
      surface: '#3a2e1c',
      ink: '#1f1c17',
      accent: DEFAULT_ACCENT,
      hues: HUES,
      mutedContrast: 4.5,
      lineWeight: 1
    }
  }
]

export const DEFAULT_THEME_ID = 'studio'
export const DEFAULT_LIGHT_THEME_ID = 'studio-light'

export function themeById(id: string): BuiltInTheme {
  return BUILT_IN_THEMES.find((theme) => theme.id === id) ?? (BUILT_IN_THEMES[0] as BuiltInTheme)
}

export type Tone = 'light' | 'dark'
export type AppearanceMode = 'system' | Tone
export const APPEARANCE_MODES: readonly AppearanceMode[] = ['system', 'light', 'dark']

/** Whether a preset is painted on a light ground or a dark one. */
export function themeTone(themeId: string): Tone {
  return isDark(parseColor(themeById(themeId).seed.ground) ?? black()) ? 'dark' : 'light'
}

/** Whether a resolved palette is light or dark, read off its ground. */
export function paletteTone(palette: Palette): Tone {
  return isDark(parseColor(palette['bg-window']) ?? black()) ? 'dark' : 'light'
}

/**
 * One slot's choice: a preset, then a ground and accent, then literal per-token
 * edits; each layer overrides the one above.
 */
export type ThemeChoice = {
  themeId: string
  /** Replaces the preset's ground, and with it the whole elevation ramp. */
  ground: string | null
  accent: string | null
  /**
   * Literal values for named tokens, applied after everything is derived. Keyed by
   * plain string, not `ThemeToken`: this crosses the wire and comes back off disk,
   * so a token from another build must still parse; unknown keys are dropped.
   */
  overrides: Readonly<Record<string, string>>
}

/** As stored and as it travels: the dark slot at the top level, the light slot beside it. */
export type Appearance = ThemeChoice & {
  /** Absent in files written before modes existed; those windows were dark and stay dark. */
  mode?: AppearanceMode
  /** Absent until edited: the Light preset as shipped. */
  light?: ThemeChoice
}

export const DEFAULT_APPEARANCE: Appearance = {
  themeId: DEFAULT_THEME_ID,
  ground: null,
  accent: null,
  overrides: {},
  mode: 'system'
}

const DEFAULT_LIGHT_CHOICE: ThemeChoice = { themeId: DEFAULT_LIGHT_THEME_ID, ground: null, accent: null, overrides: {} }

/** The tone on screen; `system` is what the OS is showing. */
export function resolveTone(appearance: Appearance, system: Tone): Tone {
  const mode = appearance.mode ?? 'dark'
  return mode === 'system' ? system : mode
}

/** The slot the window is painted from, and the one the editor changes. */
export function activeChoice(appearance: Appearance, system: Tone): ThemeChoice {
  return choiceFor(appearance, resolveTone(appearance, system))
}

/** The same appearance with one slot replaced. */
export function withChoice(appearance: Appearance, tone: Tone, choice: ThemeChoice): Appearance {
  if (tone === 'light') return { ...appearance, light: choice }
  return {
    ...appearance,
    themeId: choice.themeId,
    ground: choice.ground,
    accent: choice.accent,
    overrides: choice.overrides
  }
}

function choiceFor(appearance: Appearance, tone: Tone): ThemeChoice {
  if (tone === 'light') return appearance.light ?? DEFAULT_LIGHT_CHOICE
  const { themeId, ground, accent, overrides } = appearance
  return { themeId, ground, accent, overrides }
}

/** True when nothing has been changed away from the preset. */
export function isPristine(appearance: ThemeChoice): boolean {
  return appearance.ground === null && appearance.accent === null && Object.keys(appearance.overrides).length === 0
}

/**
 * Whatever was stored, as an appearance this app will accept. Never throws and
 * never refuses a whole document over one bad field: bad values fall back or drop.
 */
export function sanitizeAppearance(raw: unknown): Appearance {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_APPEARANCE
  const record = raw as Record<string, unknown>
  const appearance: Appearance = sanitizeChoice(record, DEFAULT_THEME_ID)
  if ((APPEARANCE_MODES as readonly unknown[]).includes(record.mode)) appearance.mode = record.mode as AppearanceMode
  if (typeof record.light === 'object' && record.light !== null) {
    appearance.light = sanitizeChoice(record.light as Record<string, unknown>, DEFAULT_LIGHT_THEME_ID)
  }
  return appearance
}

function sanitizeChoice(record: Record<string, unknown>, fallbackThemeId: string): ThemeChoice {
  const themeId =
    typeof record.themeId === 'string' && BUILT_IN_THEMES.some((theme) => theme.id === record.themeId)
      ? record.themeId
      : fallbackThemeId

  const overrides: Record<string, string> = {}
  if (typeof record.overrides === 'object' && record.overrides !== null) {
    for (const [key, value] of Object.entries(record.overrides as Record<string, unknown>)) {
      if (!isThemeToken(key) || typeof value !== 'string') continue
      const parsed = parseColor(value)
      if (parsed !== null) overrides[key] = toHex(parsed)
    }
  }

  const accent = hexOrNull(record.accent)
  return {
    themeId,
    ground: hexOrNull(record.ground),
    accent: accent === null ? null : allowedAccent(accent),
    overrides
  }
}

export function isThemeToken(name: string): name is ThemeToken {
  return (THEME_TOKENS as readonly string[]).includes(name)
}

function hexOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const parsed = parseColor(value)
  return parsed === null ? null : toHex(parsed)
}

/** The whole pipeline: the slot on screen, its preset, then the two choices, then the literal edits. */
export function resolvePalette(appearance: Appearance, system: Tone = 'dark'): Palette {
  const clean = activeChoice(sanitizeAppearance(appearance), system)
  const preset = themeById(clean.themeId)
  const base = preset.seed
  const seed: ThemeSeed = { ...base, ground: clean.ground ?? base.ground, accent: clean.accent ?? base.accent }
  const built = buildPalette(seed)
  const literal = clean.ground === null ? drawn(preset, clean.accent !== null) : {}
  const edited = applyOverrides({ ...built, ...literal }, clean.overrides)
  // A role nobody set follows its surface as edited, so an older preset's raised card and its menus stay one.
  const followed = { ...edited }
  for (const token of Object.keys(FOLLOWERS) as FollowerToken[]) {
    if (literal[token] === undefined && clean.overrides[token] === undefined) followed[token] = FOLLOWERS[token](edited)
  }
  return guard(followed, seed)
}

// Everything a drawn preset derives from its accent, dropped when another accent is chosen.
const ACCENT_ROLES: readonly ThemeToken[] = [
  'accent',
  'accent-bright',
  'accent-soft',
  'accent-line',
  'accent-hover',
  'accent-press',
  'on-accent',
  'bg-selected',
  'term-cursor',
  'term-selection'
]

function drawn(preset: BuiltInTheme, ownAccent: boolean): Partial<Record<ThemeToken, string>> {
  const tokens = { ...preset.tokens }
  if (ownAccent) for (const token of ACCENT_ROLES) delete tokens[token]
  return tokens
}

type FollowerToken =
  | 'bg-tabstrip-active'
  | 'bg-elevated'
  | 'bg-sunken'
  | 'bg-worktree'
  | 'bg-code'
  | 'line-subtle'
  | 'fg-faint'
  | 'accent-hover'
  | 'accent-press'
  | 'working'
  | 'stopped'

// The roles added with Studio, for a preset that does not draw them: each from a role it already has.
const FOLLOWERS: Record<FollowerToken, (palette: Omit<Palette, FollowerToken>) => string> = {
  'bg-tabstrip-active': (palette) => palette['bg-raised'],
  'bg-elevated': (palette) => palette['bg-raised'],
  'bg-sunken': (palette) => palette['bg-input'],
  'bg-worktree': (palette) => palette['bg-raised'],
  'bg-code': (palette) => palette['bg-input'],
  'line-subtle': (palette) => blend(palette['bg-raised'], palette.line, 0.5),
  'fg-faint': (palette) => blend(palette['fg-muted'], palette['bg-window'], 0.3),
  'accent-hover': (palette) => blend(palette.accent, '#000000', 0.06),
  'accent-press': (palette) => blend(palette.accent, '#000000', 0.13),
  working: (palette) => palette.info,
  stopped: (palette) => palette['fg-muted']
}

function blend(a: string, b: string, amount: number): string {
  const [x, y] = [parseColor(a), parseColor(b)]
  return x === null || y === null ? a : toHex(mix(x, y, amount))
}

// How far each surface climbs from the ground towards the surface colour. Tuned
// against `#000000`: the smallest steps that still separate a panel on true black.
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

  // Fields are cut into the surface, so they travel the other way; on a ground at
  // the end of its axis the field is read from its border, which every input has.
  const input = mix(ground, darkGround ? black() : white(), 0.4)

  const ink = ensureContrast(parseColor(seed.ink) ?? white(), ground, 11)
  // Measured against the lightest surface each lands on (a raised card), not the
  // ground: a palette tuned to the window would fail exactly where dialogs are.
  const secondary = ensureContrast(mix(ink, ground, 0.3), raised, secondaryFloor(seed))
  const muted = ensureContrast(mix(ink, ground, 0.5), raised, seed.mutedContrast)

  const accent = parseColor(seed.accent) ?? (parseColor(DEFAULT_ACCENT) as Rgb)
  // The accent as an ink (branch names, active combo rows): readable, not merely visible.
  const accentBright = ensureContrast(mix(accent, darkGround ? white() : black(), 0.16), raised, 4.5)
  // Label on a filled accent button, tinted rather than flat black or white so
  // the button reads as part of the window rather than a sticker.
  const onAccent = ensureContrast(
    contrastRatio(accent, black()) >= contrastRatio(accent, white())
      ? mix(accent, black(), 0.9)
      : mix(accent, white(), 0.92),
    accent,
    4.5
  )

  const hue = (value: string, against: Rgb): Rgb =>
    ensureContrast(parseColor(value) ?? ink, against, Math.max(seed.mutedContrast, 4.5))

  // The terminal shares the window's ground, so pane and chrome are one surface.
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

  const base: Omit<Palette, FollowerToken> = {
    'bg-window': toHex(ground),
    'bg-pane': toHex(ground),
    'bg-rail': toHex(rail),
    'bg-tabstrip': toHex(rail),
    'bg-panel': toHex(panel),
    'bg-raised': toHex(raised),
    'bg-input': toHex(input),
    'bg-hover': withAlpha(surface, 0.05),
    'bg-press': withAlpha(surface, 0.09),
    'bg-selected': withAlpha(accent, 0.16),
    scrim: darkGround ? withAlpha(mix(ground, black(), 0.5), 0.66) : withAlpha(mix(surface, black(), 0.5), 0.22),
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
    // The four meanings, measured against the raised surface: a chip on a dialog is the worst case.
    success: toHex(hue(seed.hues.green, raised)),
    warning: toHex(hue(seed.hues.yellow, raised)),
    danger: toHex(hue(seed.hues.red, raised)),
    info: toHex(hue(seed.hues.blue, raised)),
    'term-bg': toHex(termBg),
    'term-fg': toHex(ink),
    'term-cursor': toHex(accentBright),
    // Solid, not translucent: the search addon parses this itself and understands
    // nothing but `#rrggbb`; alpha would quietly fall back to another theme's colour.
    'term-selection': toHex(mix(termBg, accent, seed.selection ?? 0.34)),
    // On a light ground black is ink, not a shade of the ground.
    'term-black': toHex(darkGround ? mix(termBg, surface, 0.14) : mix(ink, ground, 0.08)),
    'term-red': toHex(red),
    'term-green': toHex(green),
    'term-yellow': toHex(yellow),
    'term-blue': toHex(blue),
    'term-magenta': toHex(magenta),
    'term-cyan': toHex(cyan),
    'term-white': toHex(mix(ink, ground, darkGround ? 0.18 : 0.4)),
    // Most coding agents print their reasoning in dim grey, so it is held to the body-text floor.
    'term-bright-black': toHex(ensureContrast(mix(termBg, surface, 0.42), termBg, Math.max(seed.mutedContrast, 4.5))),
    'term-bright-red': toHex(bright(red)),
    'term-bright-green': toHex(bright(green)),
    'term-bright-yellow': toHex(bright(yellow)),
    'term-bright-blue': toHex(bright(blue)),
    'term-bright-magenta': toHex(bright(magenta)),
    'term-bright-cyan': toHex(bright(cyan)),
    'term-bright-white': toHex(ink)
  }
  const followers = Object.fromEntries(
    (Object.keys(FOLLOWERS) as FollowerToken[]).map((token) => [token, FOLLOWERS[token](base)])
  ) as Record<FollowerToken, string>
  return { ...base, ...followers }
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

// Every foreground lifted off the lightest surface it is painted on until it
// clears, overrides included, which is why the editor needs no validation.
// Pairs are listed, not inferred: which surface an ink lands on is a stylesheet fact.
function guard(palette: Palette, seed: ThemeSeed): Palette {
  const floor = Math.max(seed.mutedContrast, 4.5)
  const pairs: readonly [ThemeToken, ThemeToken, number][] = [
    ['fg', 'bg-raised', 7],
    ['fg-secondary', 'bg-raised', Math.max(floor, secondaryFloor(seed))],
    ['fg-muted', 'bg-raised', floor],
    ['accent-bright', 'bg-raised', 4.5],
    ['on-accent', 'accent', 4.5],
    ['success', 'bg-raised', floor],
    ['warning', 'bg-raised', floor],
    ['danger', 'bg-raised', floor],
    ['info', 'bg-raised', floor],
    ['working', 'bg-raised', floor],
    ['stopped', 'bg-raised', floor],
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

  const termBg = parseColor(palette['term-bg'])
  const extra: [ThemeToken, ThemeToken, number][] =
    termBg !== null && !isDark(termBg) ? [['term-black', 'term-bg', floor]] : []

  const next: Palette = { ...palette }
  for (const [ink, surface, target] of [...pairs, ...extra]) {
    const foreground = parseColor(next[ink])
    const background = parseColor(next[surface])
    if (foreground === null || background === null) continue
    next[ink] = toHex(ensureContrast(foreground, background, target))
  }
  // A chip's tint is darker than any surface on a light ground: the accent ink's worst case.
  const raised = parseColor(next['bg-raised'])
  const chip = raised === null ? null : parseColor(opaqueHex(next['accent-soft'], raised) ?? '')
  const accentInk = parseColor(next['accent-bright'])
  if (chip !== null && accentInk !== null) next['accent-bright'] = toHex(ensureContrast(accentInk, chip, 4.5))
  return next
}

function secondaryFloor(seed: ThemeSeed): number {
  return Math.max(seed.mutedContrast, seed.secondaryContrast ?? 6.5)
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
