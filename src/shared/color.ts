// The colour arithmetic the theme layer is built on: parse, mix, and — the
// reason this file exists at all — measure.
//
// A theme people can edit is a theme people can break, and the break that
// matters is not an ugly colour, it is a colour nobody can read. So every
// palette this app produces is passed through `ensureContrast` before it
// reaches the screen, and that needs the same relative-luminance maths WCAG
// defines. It lives here, apart from the palettes, because the tests that
// guard the built-in themes measure the shipped values with exactly the
// function that produced them.
//
// sRGB throughout. The app's colours are hex tokens read back by
// `getComputedStyle`, and CSS `color-mix` in any other space would give answers
// this file cannot check.

export type Rgb = { r: number; g: number; b: number }

/**
 * Reads `#rgb`, `#rrggbb` and `#rrggbbaa`, and nothing else.
 *
 * Returns null rather than a guess for anything it does not understand, which
 * is what lets a hand-edited colour be rejected one token at a time instead of
 * taking the whole theme down with it. Alpha is dropped: every token this
 * parses is an opaque surface or an opaque ink, and the two places the app
 * wants translucency build it with `withAlpha` from an opaque base.
 */
export function parseColor(text: string): Rgb | null {
  const value = text.trim()
  if (!value.startsWith('#')) return null
  const digits = value.slice(1)
  if (!/^[0-9a-fA-F]+$/.test(digits)) return null

  if (digits.length === 3) {
    const [r, g, b] = [...digits].map((digit) => Number.parseInt(digit + digit, 16))
    return { r: r as number, g: g as number, b: b as number }
  }
  if (digits.length === 6 || digits.length === 8) {
    return {
      r: Number.parseInt(digits.slice(0, 2), 16),
      g: Number.parseInt(digits.slice(2, 4), 16),
      b: Number.parseInt(digits.slice(4, 6), 16)
    }
  }
  return null
}

export function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((channel) => clampChannel(channel).toString(16).padStart(2, '0')).join('')}`
}

/** `amount` is how much of `b` ends up in the result, 0 to 1. */
export function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  const t = Math.min(Math.max(amount, 0), 1)
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t
  }
}

/**
 * A translucent form of one colour, spelled the way the stylesheets spell it.
 *
 * Translucent rather than pre-mixed because these sit over more than one
 * surface — a hover highlight lands on the rail, on a panel and on a raised
 * card — and a pre-mixed value would be right on exactly one of them.
 */
export function withAlpha(color: Rgb, alpha: number): string {
  const { r, g, b } = roundColor(color)
  return `rgb(${r} ${g} ${b} / ${Math.round(Math.min(Math.max(alpha, 0), 1) * 100)}%)`
}

/** WCAG relative luminance. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const [lr, lg, lb] = [r, g, b].map((channel) => {
    const srgb = clampChannel(channel) / 255
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * (lr as number) + 0.7152 * (lg as number) + 0.0722 * (lb as number)
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return ((lighter as number) + 0.05) / ((darker as number) + 0.05)
}

/**
 * The same colour, moved just far enough away from `background` to be read.
 *
 * This is the promise the whole theme layer rests on: whatever a preset
 * declares and whatever a person then types into the editor, the value that
 * reaches the screen clears its target against the surface it sits on. It
 * walks away from the background — towards white on a dark ground, towards
 * black on a light one — in small steps, so a colour that already passes comes
 * back untouched and one that nearly passes keeps almost all of its hue.
 *
 * Stepping rather than solving because the answer has to be a colour somebody
 * would have chosen: the closest passing point along a line to white keeps the
 * author's hue, while computing a luminance and rebuilding a colour from it
 * would not.
 */
export function ensureContrast(color: Rgb, background: Rgb, target: number): Rgb {
  // Measured on the rounded form throughout, because that is the colour that
  // will actually be painted: a candidate that clears the target at fractional
  // precision and falls under it once written as six hex digits is a palette
  // that passes its own test and fails on screen.
  const ground = roundColor(background)
  if (contrastRatio(roundColor(color), ground) >= target) return roundColor(color)

  const towards: Rgb = relativeLuminance(ground) < 0.5 ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 }
  // Two hundred steps is a quarter of a percent each: finer than the eight bits
  // the result is rounded to, so the first passing step is the nearest one.
  for (let step = 1; step <= 200; step += 1) {
    const candidate = roundColor(mix(color, towards, step / 200))
    if (contrastRatio(candidate, ground) >= target) return candidate
  }
  // Unreachable for any target under 21, and the honest answer when a caller
  // asks for more contrast than the extreme of the axis can give.
  return towards
}

/**
 * One palette value as an opaque hex, whatever form it is stored in.
 *
 * The hover tint, the press tint, the accent wash and the scrim are stored
 * translucent on purpose — they land on more than one surface, and a
 * pre-mixed value would be right on exactly one of them. But a swatch has to
 * be a colour, and so does an `<input type="color">`, so those are composited
 * over the surface they are usually seen on before they are shown.
 *
 * Returns null for anything that is neither a hex nor an `rgb(r g b / p%)`,
 * which is the only other form this app's palettes ever take.
 */
export function opaqueHex(value: string, over: Rgb): string | null {
  const hex = parseColor(value)
  if (hex !== null) return toHex(hex)

  const parts = /^rgb\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*\/\s*([\d.]+)%)?\s*\)$/.exec(value.trim())
  if (parts === null) return null
  const [, r, g, b, alpha] = parts
  const colour: Rgb = { r: Number(r), g: Number(g), b: Number(b) }
  return toHex(mix(over, colour, alpha === undefined ? 1 : Number(alpha) / 100))
}

/** Rounds to the eight bits a hex token actually carries. */
export function roundColor({ r, g, b }: Rgb): Rgb {
  return { r: clampChannel(r), g: clampChannel(g), b: clampChannel(b) }
}

function clampChannel(channel: number): number {
  return Math.min(255, Math.max(0, Math.round(channel)))
}
