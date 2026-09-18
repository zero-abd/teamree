// The launcher's hand-written types, against the launcher.
//
// `bin/teamree-relay.mjs` ships with no build step — it runs from the packaged
// app under whatever Node is there — so its types live in a `.d.mts` written
// beside it by hand. Two files, one truth, kept in step by nobody.
//
// They drifted the first time somebody added an export: three functions and a
// new parameter went into the `.mjs`, the `.d.mts` did not hear about it, and
// `npm run typecheck` at the root stayed green because it cannot see this
// package at all. The release script does run `relay typecheck` and would have
// refused to publish — the gate worked — but the gap between writing the drift
// and being told about it was the whole of a release run, and everything in
// between reported success.
//
// So this is that check, in the suite everybody runs. It needs no tsc and no
// Worker types: it reads what the module actually exports and what the
// declarations actually declare, and insists they are the same set.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as launcher from '../bin/teamree-relay.mjs'

const binDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin')
const declarations = readFileSync(join(binDir, 'teamree-relay.d.mts'), 'utf8')

/**
 * Every name the `.d.mts` declares.
 *
 * `export declare function|const|type` and the `export type { … }` re-export
 * form, because the file uses both and a check that knew only one of them would
 * report half the file as missing.
 */
function declared(source: string): Set<string> {
  const names = new Set<string>()
  for (const [, name] of source.matchAll(/^export declare (?:function|const|let|var)\s+([A-Za-z0-9_$]+)/gm)) {
    if (name !== undefined) names.add(name)
  }
  for (const [, name] of source.matchAll(/^export (?:declare )?(?:type|interface)\s+([A-Za-z0-9_$]+)/gm)) {
    if (name !== undefined) names.add(name)
  }
  return names
}

describe('the launcher and its declarations', () => {
  // If this ever finds nothing, the check has silently stopped checking.
  it('finds both halves to compare', () => {
    expect(Object.keys(launcher).length).toBeGreaterThan(10)
    expect(declared(declarations).size).toBeGreaterThan(10)
  })

  // The direction that bites: a function added to the module and not to the
  // types is the one that makes this package stop compiling, and the one that
  // nothing outside a release run would have said a word about.
  it('declares every value the launcher exports', () => {
    const missing = Object.keys(launcher).filter((name) => !declared(declarations).has(name))
    expect(missing).toEqual([])
  })

  // The other direction is a slower failure and worth catching too: a
  // declaration left behind by a rename is a type somebody can import, and
  // write code against, for a function that is not there any more.
  it('declares nothing the launcher does not export', () => {
    // Types have no runtime counterpart, so they are named here rather than
    // inferred — a type in this file is a deliberate part of its surface.
    const typeOnly = new Set(
      [...declarations.matchAll(/^export (?:declare )?(?:type|interface)\s+([A-Za-z0-9_$]+)/gm)].map(
        (match) => match[1] ?? ''
      )
    )
    const exported = new Set(Object.keys(launcher))
    const orphans = [...declared(declarations)].filter((name) => !typeOnly.has(name) && !exported.has(name))
    expect(orphans).toEqual([])
  })
})
