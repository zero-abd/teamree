// Whether an installed app can stand a relay up on its own.
//
// It could not, and that was a usability failure somebody hit for real: the
// instructions said `cd relay && npm install && npm run deploy`, which is true
// only inside a clone of this repository, and a person who installed the `.dmg`
// has none. What they got was npm's `ENOENT: ... relay/package.json`, which
// names npm's problem rather than theirs.
//
// The fix is that the app carries the relay's deployable project and the one
// command that writes it somewhere and deploys it. That claim lives in
// `electron-builder.yml`, and nothing but packaging proves it — which is a
// fifteen-minute universal build, so `scripts/verify-package.mjs` checks the
// built app and this checks the instruction that produces it. Deleting a line
// from that list fails here in a second rather than shipping a `.dmg` whose
// README describes a command that is not in it.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TEMPLATE_DIRS, TEMPLATE_FILES } from '../../relay/bin/teamree-relay.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const CONFIG = readFileSync(join(REPO_ROOT, 'electron-builder.yml'), 'utf8')

/** The `extraResources` entries, as the pairs electron-builder will copy. */
function extraResources(): { from: string; to: string }[] {
  const block = /\nextraResources:\n([\s\S]*?)\n[a-z]/.exec(CONFIG)
  expect(block, 'electron-builder.yml has no extraResources block').not.toBeNull()
  const pairs = []
  // The `?? ''` is for the type-checker and nothing else: a successful match of
  // this pattern always carries group 1, but `noUncheckedIndexedAccess` cannot
  // know that, and the `expect` above has already thrown if there was no match.
  for (const match of ((block as RegExpExecArray)[1] ?? '').matchAll(/- from: (\S+)\n\s+to: (\S+)/g)) {
    pairs.push({ from: match[1] as string, to: match[2] as string })
  }
  return pairs
}

describe('the relay an installed app ships', () => {
  const shipped = extraResources().filter((entry) => entry.from.startsWith('relay/'))

  it('carries the command and every source the Worker is built from', () => {
    const copied = shipped.map((entry) => entry.from)
    for (const path of ['relay/teamree-relay', 'relay/bin/teamree-relay.mjs']) {
      expect(copied, `${path} is not shipped, so the one command in relay/README.md is not in the app`).toContain(path)
    }
    for (const path of [...TEMPLATE_FILES, ...TEMPLATE_DIRS]) {
      expect(copied, `the deploy command copies ${path}, which is not shipped`).toContain(`relay/${path}`)
    }
  })

  it('puts it at the same place inside the app as it is in a clone', () => {
    // `bin/teamree-relay.mjs` finds the sources it copies one directory up from
    // itself. That is the same answer in a checkout and in the app only while
    // the layout is preserved, so a `to:` that flattened anything would leave a
    // command that runs and then cannot find what it is meant to write.
    for (const entry of shipped) expect(entry.to).toBe(entry.from)
  })

  it('ships nothing that would make the artifact heavy or the project confusing', () => {
    const copied = shipped.map((entry) => entry.from)
    // node_modules is tens of thousands of files; dist and package.json belong
    // to the container host, which this command does not deploy.
    for (const path of ['relay/node_modules', 'relay/dist', 'relay/package.json', 'relay/src/node']) {
      expect(copied).not.toContain(path)
    }
    expect(copied.some((path) => path.startsWith('relay/src/node'))).toBe(false)
  })

  it('is committed executable, because the app is not repaired after it is packaged', () => {
    const launcher = join(REPO_ROOT, 'relay', 'teamree-relay')
    expect(existsSync(launcher)).toBe(true)
    expect(statSync(launcher).mode & 0o111, `${launcher} is not executable`).toBeGreaterThan(0)
  })
})
