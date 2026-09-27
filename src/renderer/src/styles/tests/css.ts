// Reading the stylesheets for the per-sheet tests: every rule, declaration and custom property by name.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import { expect } from 'vitest'
import { parseColor, type Rgb } from '@shared/color'
import { DEFAULT_APPEARANCE, resolvePalette, themeTone, type Appearance } from '@shared/theme'

export const STYLES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

export const sheets = readdirSync(STYLES)
  .filter((name) => name.endsWith('.css'))
  .sort()

export const LIGHT_SCHEME = '(prefers-color-scheme: light)'

export function parse(sheet: string): postcss.Root {
  return postcss.parse(readFileSync(path.join(STYLES, sheet), 'utf8'), { from: sheet })
}

/** The one rule with exactly this selector in the named sheet, or nothing. */
export function findRule(sheet: string, selector: string): postcss.Rule | undefined {
  let found: postcss.Rule | undefined
  parse(sheet).walkRules((rule) => {
    if (rule.selector === selector) found = rule
  })
  return found
}

/** The rule whose selector list includes `selector`, alone or among others. */
export function ruleListing(sheet: string, selector: string): postcss.Rule | undefined {
  let found: postcss.Rule | undefined
  parse(sheet).walkRules((rule) => {
    if (rule.selectors.includes(selector)) found = rule
  })
  return found
}

/** Like `findRule`, but a missing rule is a failed test rather than a silent pass. */
export function ruleFor(sheet: string, selector: string): postcss.Rule {
  const rule = findRule(sheet, selector)
  expect(rule, `${sheet} should have a rule for ${selector}`).toBeTruthy()
  return rule as postcss.Rule
}

export function declarationOf(rule: postcss.Rule, prop: string): string | undefined {
  let value: string | undefined
  rule.walkDecls(prop, (decl) => {
    value = decl.value
  })
  return value
}

/** Every custom property `:root` declares in one stylesheet, at the top level or inside one `@media`. */
export function customProperties(sheet: string, media?: string): Map<string, string> {
  const found = new Map<string, string>()
  parse(sheet).walkRules(':root', (rule) => {
    const parent = rule.parent
    const within = parent?.type === 'atrule' ? (parent as postcss.AtRule).params : undefined
    if (within !== media) return
    rule.walkDecls(/^--/, (decl) => {
      found.set(decl.prop, decl.value.trim())
    })
  })
  return found
}

/** The `from` step of a named `@keyframes` in one stylesheet. */
export function keyframeFrom(sheet: string, name: string): postcss.Rule {
  let found: postcss.Rule | undefined
  parse(sheet).walkAtRules('keyframes', (rule) => {
    if (rule.params !== name) return
    rule.walkRules('from', (step) => {
      found = step
    })
  })
  expect(found, `${sheet} should have @keyframes ${name} with a from step`).toBeTruthy()
  return found as postcss.Rule
}

/** The `z-index` one selector is given, across every stylesheet. */
export function zIndexOf(selector: string): number {
  const found: number[] = []
  for (const sheet of sheets) {
    parse(sheet).walkRules(selector, (rule) => {
      rule.walkDecls('z-index', (decl) => {
        found.push(Number(decl.value))
      })
    })
  }
  // No z-index, or two, would make the comparison pass quietly.
  expect(found, `${selector} should declare exactly one z-index`).toHaveLength(1)
  return found[0] ?? Number.NaN
}

/** Every opacity a sheet gives rules listing `selector`. */
export function opacitiesOf(sheet: string, selector: string): string[] {
  const opacities: string[] = []
  parse(sheet).walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return
    rule.walkDecls('opacity', (decl) => {
      opacities.push(decl.value)
    })
  })
  return opacities
}

/** A built-in theme's palette, in the tone it is made for. */
export function paletteOf(id: string): Record<string, string> {
  const appearance: Appearance =
    themeTone(id) === 'dark'
      ? { ...DEFAULT_APPEARANCE, mode: 'dark', themeId: id }
      : { ...DEFAULT_APPEARANCE, mode: 'light', light: { themeId: id, ground: null, accent: null, overrides: {} } }
  return resolvePalette(appearance)
}

export function rgbOf(colour: string | undefined): Rgb {
  return parseColor(colour ?? '') as Rgb
}
