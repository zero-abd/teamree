// The claims that are about the shape of this package rather than about what it
// does with a frame.
//
// Three of the relay's promises cannot be driven over a socket, because they are
// promises about files: that `wrangler.jsonc` carries only limits the Worker can
// actually enforce, that `src/core` knows nothing about either host, and that
// nothing is ever stored anywhere. Each of them is true today by somebody having
// been careful, and each is undone by an ordinary-looking edit — a variable
// copied into the deployed config, an import reached for while fixing something
// else, a `storage.put` added because the object had somewhere to put it. So
// they are asserted here, against the files, rather than left to review.

import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const RELAY_ROOT = resolve(import.meta.dirname, '..')

/** Every `RELAY_*` row of README.md's limits table, and which host it applies to. */
function documentedLimits(): Map<string, string> {
  const rows = new Map<string, string>()
  for (const line of readFileSync(join(RELAY_ROOT, 'README.md'), 'utf8').split('\n')) {
    const row = /^\| `(RELAY_[A-Z_]+)` \| [^|]+ \| (both|container) \|/.exec(line)
    if (row !== null) rows.set(row[1] as string, row[2] as string)
  }
  return rows
}

/** The `vars` block of the deployed Worker configuration, comments and all. */
function deployedVars(): string[] {
  const config = readFileSync(join(RELAY_ROOT, 'wrangler.jsonc'), 'utf8')
  const block = /"vars"\s*:\s*\{([^}]*)\}/.exec(config)?.[1]
  expect(block, 'wrangler.jsonc has no vars block').toEqual(expect.any(String))
  return [...(block ?? '').matchAll(/"(RELAY_[A-Z_]+)"\s*:/g)].map((match) => match[1] as string)
}

function sourcesUnder(directory: string): Array<{ path: string; source: string }> {
  return readdirSync(join(RELAY_ROOT, directory))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ path: `${directory}/${name}`, source: readFileSync(join(RELAY_ROOT, directory, name), 'utf8') }))
}

describe('what the deployed Worker is configured with', () => {
  it('carries every limit this host can enforce, and not one it cannot', () => {
    const documented = documentedLimits()
    const both = [...documented].filter(([, where]) => where === 'both').map(([name]) => name)

    // The table in README.md is the promise and this file is the thing an
    // operator edits, so the two are held to each other in both directions. A
    // variable that is in the file and not marked `both` is one the relay reads
    // and has nowhere to apply — which is exactly the quiet non-enforcement the
    // rest of this package refuses. One that is marked `both` and missing from
    // the file is a default nobody can change without knowing it exists.
    expect(documented.size).toBe(18)
    expect([...deployedVars()].sort()).toEqual([...both].sort())
  })

  it('leaves out the three counts a process keeps, rather than reading and ignoring them', () => {
    const deployed = new Set(deployedVars())

    // Named one at a time because these are the three the README singles out:
    // they are counts across a whole process and a Worker has no process to
    // count across. `test/hibernation.test.ts`, "has no connection cap to spend,
    // because a Worker has no process to count across", is the behaviour half.
    expect(deployed.has('RELAY_MAX_CONNECTIONS')).toBe(false)
    expect(deployed.has('RELAY_MAX_CONNECTIONS_PER_ADDRESS')).toBe(false)
    expect(deployed.has('RELAY_MAX_CONNECTIONS_PER_ADDRESS_PER_MINUTE')).toBe(false)
    // And the fourth absence, which is there for a different reason: the runtime
    // owns the send queue and does not show its depth, so there is nothing to
    // compare a bound against.
    expect(deployed.has('RELAY_MAX_BUFFERED_BYTES')).toBe(false)
  })
})

describe('what each host is allowed to know about', () => {
  it('keeps every rule in a core that imports neither host', () => {
    // Not tidiness. It is the reason there are two hosts and one set of rules,
    // and the reason a third would be an adapter rather than a second
    // implementation — and it is what lets `wrangler.jsonc` go without
    // `nodejs_compat`, which is a property of the deployment rather than of this
    // repository. Everything core imports is a sibling file in core.
    for (const { path, source } of sourcesUnder('src/core')) {
      for (const match of source.matchAll(/\bfrom '([^']+)'/g)) {
        const specifier = match[1] as string
        expect(specifier, `${path} imports ${specifier}`).toMatch(/^\.\/[A-Za-z]+\.js$/)
      }
    }
  })

  it('asks the Durable Object runtime for nothing but an alarm', () => {
    // "Nothing is stored anywhere, on either host." The Durable Object has a
    // storage API in reach, and a SQLite backend behind it, so the claim is one
    // line of somebody's restraint away at all times. These are the only two
    // members of it this package names: when the next sweep is, and when to set
    // it for. A pairing exists while both sockets do, and there is nothing to
    // back up, migrate or leak.
    const used = new Set<string>()
    for (const { source } of sourcesUnder('src/workers')) {
      for (const match of source.matchAll(/\bstorage\.([A-Za-z]+)/g)) used.add(match[1] as string)
    }

    expect([...used].sort()).toEqual(['getAlarm', 'setAlarm'])
  })
})
