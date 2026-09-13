// The refusals, which are the only part of releasing that has to be right.
//
// A release script that publishes correctly and refuses incorrectly is a
// nuisance; one that refuses correctly and publishes incorrectly has put a file
// in front of people. So what is tested here is every condition under which
// `scripts/release.mjs` declines — and the two that would be invisible
// afterwards: a tag that names a version the package does not carry, and a
// commit nobody else has.
//
// These are pure functions over a plain object rather than tests that drive git
// and gh, deliberately: the alternative is a suite that cuts releases.
import { describe, expect, it } from 'vitest'
import {
  GATES,
  STABLE_DMG_NAME,
  checksumLine,
  expectedTag,
  isPrerelease,
  parseReleaseArgs,
  planLines,
  preflightRefusals,
  releaseNotes,
  tagAgreement
} from '../../scripts/release.mjs'

const HEAD = '1f0c3b9a7d4e2f6c8b0a1d3e5f7a9c2b4d6e8f01'
const OTHER = '9a8b7c6d5e4f30211f2e3d4c5b6a79880f1e2d3c'

/** A repository in the one state that should publish: clean, pushed, authenticated. */
function ready(overrides: Record<string, unknown> = {}) {
  return {
    tag: 'v0.1.0',
    version: '0.1.0',
    head: HEAD,
    dirty: '',
    relayInstalled: true,
    ghAuthenticated: true,
    repo: 'owner/teamree',
    releaseExists: false,
    localTag: null,
    remoteTag: null,
    remoteHeads: [HEAD, OTHER],
    ...overrides
  }
}

describe('the tag and the version have to agree', () => {
  it('accepts the tag that names the package version', () => {
    expect(tagAgreement('v0.1.0', '0.1.0')).toBeNull()
    expect(expectedTag('0.1.0')).toBe('v0.1.0')
  })

  it('refuses a tag for a different version, naming both', () => {
    const refusal = tagAgreement('v0.2.0', '0.1.0')
    expect(refusal).toContain('v0.2.0')
    expect(refusal).toContain('0.1.0')
  })

  it('refuses something that is not a release tag at all', () => {
    for (const tag of ['0.1.0', 'release-0.1.0', 'v0.1', 'latest', 'v0.1.0.0']) {
      expect(tagAgreement(tag, '0.1.0'), tag).not.toBeNull()
    }
  })

  // A candidate is a release of the version it is a candidate for, so demanding
  // that package.json say `0.2.0-rc.1` would mean shipping a version string no
  // release ever carries.
  it('accepts a pre-release of the version the package carries', () => {
    expect(tagAgreement('v0.2.0-rc.1', '0.2.0')).toBeNull()
    expect(tagAgreement('v0.3.0-rc.1', '0.2.0')).not.toBeNull()
  })

  it('marks a pre-release tag as one, and an ordinary tag not', () => {
    expect(isPrerelease('v0.2.0-rc.1')).toBe(true)
    expect(isPrerelease('v0.2.0')).toBe(false)
  })
})

describe('what stops a release before any of it runs', () => {
  it('lets a clean, pushed, authenticated tree through', () => {
    expect(preflightRefusals(ready())).toEqual([])
  })

  it('refuses a dirty tree, and prints what is dirty', () => {
    const [refusal] = preflightRefusals(ready({ dirty: ' M src/main/index.ts\n?? scratch.txt' }))
    expect(refusal).toContain('not clean')
    expect(refusal).toContain('src/main/index.ts')
    expect(refusal).toContain('scratch.txt')
  })

  it('refuses when the relay is not installed, because the peer tests would skip', () => {
    expect(preflightRefusals(ready({ relayInstalled: false })).join()).toContain('cd relay && npm ci')
  })

  // Checked before the build and on a dry run too: it is the step most likely
  // to fail and the cheapest to ask about.
  it('refuses when gh cannot authenticate', () => {
    expect(preflightRefusals(ready({ ghAuthenticated: false })).join()).toContain('gh auth login')
  })

  // Two different failures, told apart: a signed-in maintainer whose remote is
  // not GitHub was previously sent to `gh auth login`, which would not have
  // helped.
  it('refuses, differently, when no GitHub repository can be worked out', () => {
    const refusals = preflightRefusals(ready({ repo: null }))
    expect(refusals.join()).toContain('GH_REPO=owner/name')
    expect(refusals.join()).not.toContain('gh auth login')
  })

  it('refuses to publish over a release that already exists', () => {
    expect(preflightRefusals(ready({ releaseExists: true })).join()).toContain('already exists')
  })

  it('refuses a local tag that points somewhere other than HEAD', () => {
    const refusals = preflightRefusals(ready({ localTag: OTHER }))
    expect(refusals.join()).toContain(OTHER.slice(0, 7))
  })

  it('accepts a local tag that already points at HEAD', () => {
    expect(preflightRefusals(ready({ localTag: HEAD }))).toEqual([])
  })

  it('will not move a tag that is already on origin', () => {
    expect(preflightRefusals(ready({ remoteTag: OTHER })).join()).toContain('origin')
  })

  // The one that would be found much later: a release tag on a commit that
  // exists in this checkout and nowhere else.
  it('refuses a HEAD that is not on origin', () => {
    expect(preflightRefusals(ready({ remoteHeads: [OTHER] })).join()).toContain('not the tip of any branch on origin')
  })

  it('reports every problem at once rather than one per run', () => {
    const refusals = preflightRefusals(
      ready({ tag: 'v9.9.9', dirty: ' M a.ts', ghAuthenticated: false, repo: null, remoteHeads: [] })
    )
    expect(refusals).toHaveLength(5)
  })
})

describe('the command line', () => {
  it('defaults to a real run with no tag, which the caller fills in from package.json', () => {
    expect(parseReleaseArgs([])).toEqual({ tag: null, dryRun: false, yes: false, error: null })
  })

  it('takes a tag, --dry-run and --yes in any order', () => {
    expect(parseReleaseArgs(['--dry-run', 'v0.1.0'])).toMatchObject({ tag: 'v0.1.0', dryRun: true })
    expect(parseReleaseArgs(['v0.1.0', '--yes'])).toMatchObject({ tag: 'v0.1.0', yes: true })
  })

  it('refuses what it does not understand rather than ignoring it', () => {
    expect(parseReleaseArgs(['--force']).error).toContain('--force')
    expect(parseReleaseArgs(['v0.1.0', 'v0.2.0']).error).toContain('two tags')
  })
})

describe('the gates', () => {
  // Named rather than counted, so that quietly dropping one is a failing test
  // rather than a shorter run nobody notices.
  it('runs every check the release is meant to have passed', () => {
    expect(GATES.map((gate: { name: string }) => gate.name)).toEqual([
      'typecheck',
      'format:check',
      'oxlint',
      'build:cli',
      'relay build',
      'test',
      'build',
      'smoke',
      'package:mac',
      'package:verify'
    ])
  })

  it('builds the relay in the relay, and everything else at the root', () => {
    for (const gate of GATES as Array<{ name: string; cwd?: string }>) {
      expect(gate.cwd, gate.name).toBe(gate.name === 'relay build' ? 'relay' : undefined)
    }
  })
})

describe('the notes the release carries', () => {
  const checksums = checksumLine('a'.repeat(64), 'teamree-0.1.0.dmg')

  it('formats a checksum exactly as `shasum -a 256` prints it, two spaces and all', () => {
    expect(checksums).toBe(`${'a'.repeat(64)}  teamree-0.1.0.dmg`)
  })

  // The notes are generated from the signature on the bundle that is about to
  // be published, so a release cannot inherit the last one's paragraph.
  it('explains Gatekeeper when the build is ad-hoc signed', () => {
    const notes = releaseNotes({ tag: 'v0.1.0', repo: 'owner/teamree', checksums, kind: 'adhoc' })
    expect(notes).toContain('Nothing here is signed')
    expect(notes).toContain('xattr -dr com.apple.quarantine /Applications/teamree.app')
    expect(notes).toContain(checksums)
  })

  it('says so, and gives no quarantine command, when the build is signed and notarized', () => {
    const notes = releaseNotes({ tag: 'v0.1.0', repo: 'owner/teamree', checksums, kind: 'developer-id' })
    expect(notes).toContain('Signed and notarized')
    expect(notes).not.toContain('xattr')
  })

  it('links the install document at the tag being released, not at a branch', () => {
    const notes = releaseNotes({ tag: 'v0.1.0', repo: 'owner/teamree', checksums, kind: 'adhoc' })
    expect(notes).toContain('https://github.com/owner/teamree/blob/v0.1.0/docs/install.md')
  })
})

describe('what it says before it does anything', () => {
  const plan = (dryRun: boolean, kind = 'adhoc') =>
    planLines({
      tag: 'v0.1.0',
      repo: 'owner/teamree',
      head: HEAD,
      branch: 'main',
      dmg: 'teamree-0.1.0.dmg',
      size: 201_761_957,
      hash: 'b'.repeat(64),
      kind,
      dryRun
    }).join('\n')

  it('names the repository, tag, commit, file and checksum', () => {
    const lines = plan(false)
    expect(lines).toContain('owner/teamree')
    expect(lines).toContain('v0.1.0')
    expect(lines).toContain(HEAD)
    expect(lines).toContain('teamree-0.1.0.dmg')
    expect(lines).toContain('b'.repeat(64))
    expect(lines).toContain('192.4 MiB')
  })

  it('says plainly that a dry run creates nothing', () => {
    expect(plan(true)).toContain('DRY RUN')
    expect(plan(false)).toContain('About to publish')
  })

  it('warns, on the plan itself, that an unsigned build is refused by a downloader', () => {
    expect(plan(false, 'adhoc')).toContain('will refuse it')
    expect(plan(false, 'developer-id')).not.toContain('will refuse it')
  })
})

// The link on the download button points at this name and nothing else, so the
// property that matters is not what it is called but that what it is called
// cannot go stale. `releases/latest/download/<name>` finds the newest release
// and then looks for that exact filename inside it, which is why a name with a
// version in it breaks on the day the next version ships.
describe('the name the download button can keep pointing at', () => {
  it('carries no version, so a newer release cannot orphan the link', () => {
    expect(STABLE_DMG_NAME).not.toMatch(/\d+\.\d+\.\d+/)
    expect(STABLE_DMG_NAME.endsWith('.dmg')).toBe(true)
  })

  it('is a second name for one file, so both lines carry the same hash', () => {
    const hash = 'ccf09c74af6ba75a032fee58b11dc578ece77dd3ec38401328fe34a8131bf8d2'
    const sums = `${checksumLine(hash, 'teamree-0.1.0.dmg')}\n${checksumLine(hash, STABLE_DMG_NAME)}\n`

    const lines = sums.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines.every((line) => line.startsWith(hash))).toBe(true)
    expect(lines[1]).toContain(STABLE_DMG_NAME)
  })
})
