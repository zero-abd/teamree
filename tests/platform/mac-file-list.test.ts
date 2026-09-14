// What goes into the macOS package, and the one edit that quietly ruins it.
//
// `files` in `electron-builder.yml` is the list of everything the main process
// loads at run time. The obvious way to add a macOS-only exclusion to it is a
// `files` list under `mac:`, and on electron-builder 26.15.3 that does not
// extend the top-level list and does not replace it either: the platform block
// becomes a second, *primary* matcher carrying only the platform's patterns,
// and a matcher holding nothing but exclusions has `**/*` prepended to it. Both
// matchers then run, so everything the real list selects is still packaged —
// with the entire checkout alongside it. It was measured here as a 263 MB
// package becoming 1.4 GB, with README.md, docs/, examples/, relay/ and src/
// inside the asar.
//
// electron-builder.yml says all of that at length, in the comment against the
// list, and a comment is not a check. This is the check: the reasoning is
// recorded there, the refusal is here, and a `files:` under `mac:` fails in a
// second rather than after a fifteen-minute universal build that succeeds.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const CONFIG = readFileSync(join(REPO_ROOT, 'electron-builder.yml'), 'utf8')

/**
 * The body of one top-level block.
 *
 * Read with a regex rather than a YAML parser because the only parser here
 * belongs to electron-builder, and reaching into a transitive dependency to
 * check a file the project owns is a test that breaks on somebody else's
 * release. A block ends at the next line starting a top-level key; a comment at
 * column 0 is not one, which is how the file is actually written.
 */
function block(name: string): string {
  const found = new RegExp(`\\n${name}:\\n([\\s\\S]*?)(?=\\n[a-z])`).exec(CONFIG)
  expect(found, `electron-builder.yml has no ${name}: block`).not.toBeNull()
  // The `?? ''` is for the type-checker and nothing else: a successful match of
  // this pattern always carries group 1, but `noUncheckedIndexedAccess` cannot
  // know that, and the `expect` above has already thrown if there was no match.
  return (found as RegExpExecArray)[1] ?? ''
}

describe('what the macOS package is built from', () => {
  it('names everything the main process loads at run time, in one list', () => {
    const files = block('files')
    for (const entry of [
      'out/main/**/*',
      'out/preload/**/*',
      'out/renderer/**/*',
      'package.json',
      'node_modules/**/*'
    ]) {
      expect(files, `${entry} is not in the top-level files list`).toContain(entry)
    }
  })

  // The one this file exists for.
  it('has no files list under mac:, which would package the whole checkout', () => {
    const mac = block('mac')
    const platformFiles = /^\s{2}files:/m.exec(mac)
    expect(
      platformFiles,
      'electron-builder.yml has a `files:` under `mac:`. On electron-builder 26 that does not ' +
        'narrow the top-level list — it adds a second matcher that copies the entire project ' +
        'directory into the package. Put the pattern in the top-level `files` instead, or prune ' +
        'it in scripts/afterpack.mjs, which knows the platform it is packing for.'
    ).toBeNull()
  })

  // The same trap, said about the two exclusions most likely to be moved: they
  // read like macOS concerns and are deliberately global.
  it('keeps the foreign-prebuild exclusions in the list that works', () => {
    expect(block('files')).toContain('!node_modules/node-pty/prebuilds/{win32-*,linux-*}')
  })
})
