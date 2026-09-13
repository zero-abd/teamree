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
})

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
