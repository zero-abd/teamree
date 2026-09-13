// Every stylesheet has to parse.
//
// This exists because one did not, and nothing noticed. A rule lost its body
// during a merge — the opening brace ended up with the next block's comment
// after it instead of its own declarations — and typecheck, lint, the
// formatter and eight hundred tests all passed, because not one of them reads
// CSS. The renderer build was the first thing to object, which is to say the
// break was invisible until somebody tried to run the app.
//
// A stylesheet is the one kind of source in this repo with no compiler in
// front of it, so it gets this instead.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE, resolvePalette, THEME_TOKENS } from '@shared/theme'

const here = path.dirname(fileURLToPath(import.meta.url))
const sheets = readdirSync(here)
  .filter((name) => name.endsWith('.css'))
  .sort()

describe('stylesheets', () => {
  // If this ever finds nothing, the check has silently stopped checking.
  it('finds the stylesheets to check', () => {
    expect(sheets.length).toBeGreaterThan(5)
  })

  it.each(sheets)('%s parses', (name) => {
    const css = readFileSync(path.join(here, name), 'utf8')
    expect(() => postcss.parse(css, { from: name })).not.toThrow()
  })

  // The specific shape of the break that got through: a rule whose body was
  // swallowed, leaving a selector that declares nothing.
  it.each(sheets)('%s has no rule with an empty body', (name) => {
    const css = readFileSync(path.join(here, name), 'utf8')
    const empty: string[] = []
    postcss.parse(css, { from: name }).walkRules((rule) => {
      if (rule.nodes.length === 0) empty.push(rule.selector)
    })
    expect(empty).toEqual([])
  })

  // Errors raised by a dialog are notices, and a notice under the modal scrim
  // is painted and then covered: the dialog stays open, the button goes live
  // again, and nothing appears. The two numbers live in two files, so the
  // relationship is asserted here rather than a literal in either of them.
  it('stacks the notices above the modal layer, so no dialog can hide its own error', () => {
    expect(zIndexOf('.notices')).toBeGreaterThan(zIndexOf('.modal-layer'))
  })

  // The palette is written twice on purpose — once as literals here, so the
  // first frame is painted before any script runs, and once as a derivation in
  // src/shared/theme.ts, which is what a theme switch and the colour editor
  // actually produce. Two copies of one thing drift, so this is the seam that
  // is not allowed to: a colour changed in one file and not the other would
  // otherwise show up as a window that changes shade a tick after it opens.
  describe('tokens.css against the default theme', () => {
    const declared = customProperties('tokens.css')
    const resolved = resolvePalette(DEFAULT_APPEARANCE)

    it.each(THEME_TOKENS)('--%s is the value the default theme resolves to', (token) => {
      expect(declared.get(`--${token}`)).toBe(resolved[token])
    })

    // The other direction: a token the theme layer knows about and the
    // stylesheet does not is a colour nothing can be styled in, and one the
    // stylesheet declares and the theme layer does not is a colour a theme
    // switch would leave behind at its old value.
    it('declares every themeable token and no colour outside them', () => {
      const themeable = new Set(THEME_TOKENS.map((token) => `--${token}`))
      const colours = [...declared].filter(([, value]) => /^(#|rgb\()/.test(value)).map(([name]) => name)
      expect(colours.filter((name) => !themeable.has(name))).toEqual([])
      expect([...themeable].filter((name) => !declared.has(name))).toEqual([])
    })
  })
})

/** Every custom property `:root` declares in one stylesheet, in order. */
function customProperties(name: string): Map<string, string> {
  const found = new Map<string, string>()
  postcss.parse(readFileSync(path.join(here, name), 'utf8'), { from: name }).walkRules(':root', (rule) => {
    rule.walkDecls(/^--/, (decl) => {
      found.set(decl.prop, decl.value.trim())
    })
  })
  return found
}

/** The `z-index` one selector is given, across every stylesheet. */
function zIndexOf(selector: string): number {
  const found: number[] = []
  for (const name of sheets) {
    postcss.parse(readFileSync(path.join(here, name), 'utf8'), { from: name }).walkRules(selector, (rule) => {
      rule.walkDecls('z-index', (decl) => {
        found.push(Number(decl.value))
      })
    })
  }
  // A selector with no z-index, or with two, makes the comparison meaningless
  // rather than false, and a comparison against nothing would pass quietly.
  expect(found, `${selector} should declare exactly one z-index`).toHaveLength(1)
  return found[0] ?? Number.NaN
}
