// Colour arithmetic for the theme layer: parse, mix and measure, with the WCAG
// relative-luminance maths `ensureContrast` needs. sRGB throughout: the tokens
// are read back by `getComputedStyle`, and `color-mix` in another space could not be checked here.

export type Rgb = { r: number; g: number; b: number }

/**
 * Reads `#rgb`, `#rrggbb` and `#rrggbbaa`, null for anything else so a bad token
 * is rejected alone. Alpha is dropped: translucency is built with `withAlpha` from an opaque base.
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

/** A translucent form of one colour; translucent because it sits over more than one surface. */
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
 * The same colour, stepped away from `background` (towards white on a dark
 * ground, black on a light one) until it clears `target`; stepping keeps the author's hue.
 */
export function ensureContrast(color: Rgb, background: Rgb, target: number): Rgb {
  // Measured on the rounded form, the colour actually painted: a candidate that
  // passes at fractional precision and fails as six hex digits fails on screen.
  const ground = roundColor(background)
  if (contrastRatio(roundColor(color), ground) >= target) return roundColor(color)

  const towards: Rgb = relativeLuminance(ground) < 0.5 ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 }
  // Two hundred steps is finer than the eight bits the result rounds to, so the first passing step is nearest.
  for (let step = 1; step <= 200; step += 1) {
    const candidate = roundColor(mix(color, towards, step / 200))
    if (contrastRatio(candidate, ground) >= target) return candidate
  }
  // Unreachable for any target under 21.
  return towards
}

/**
 * One palette value as an opaque hex: translucent tokens are composited over `over`
 * for swatches and `<input type="color">`. Null for anything but hex or `rgb(r g b / p%)`.
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
