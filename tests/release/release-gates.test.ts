// Every condition under which `scripts/release.mjs` refuses, as pure functions over a plain object
// rather than a suite that drives git and gh and cuts releases.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// Plain ESM run before any build; the directive sits on the specifier, where TypeScript reports it.
import {
  GATES,
  STABLE_DMG_NAME,
  checksumLine,
  expectedTag,
  highlightsPath,
  isPrerelease,
  parseReleaseArgs,
  planLines,
  preflightRefusals,
  readHighlights,
  releaseNotes,
  tagAgreement
  // @ts-expect-error -- untyped .mjs, deliberately outside the TypeScript build.
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
    highlights: '## What changed since 0.0.9\n\nSomething somebody would want to know.',
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

  // A candidate releases its base version; package.json never carries `-rc.1`.
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

  // A release with no notes looks complete on the page, so the absence is caught here or not at all.
  it('refuses a version nothing describes, and names the file to write', () => {
    const refusals = preflightRefusals(ready({ version: '0.4.0', tag: 'v0.4.0', highlights: null }))
    expect(refusals.join()).toContain('docs/release-notes/0.4.0.md')
  })

  it('refuses when the relay is not installed, because the peer tests would skip', () => {
    expect(preflightRefusals(ready({ relayInstalled: false })).join()).toContain('cd relay && npm ci')
  })

  // Checked before the build and on a dry run too.
  it('refuses when gh cannot authenticate', () => {
    expect(preflightRefusals(ready({ ghAuthenticated: false })).join()).toContain('gh auth login')
  })

  // Two failures told apart: a non-GitHub remote is not a `gh auth login` problem.
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

  // A tag on a commit that exists only in this checkout.
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
  // Named, not counted, so dropping one fails.
  it('runs every check the release is meant to have passed', () => {
    expect(GATES.map((gate: { name: string }) => gate.name)).toEqual([
      'typecheck',
      'relay typecheck',
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

  it("runs the relay's own gates in the relay, and everything else at the root", () => {
    const inTheRelay = ['relay build', 'relay typecheck']
    for (const gate of GATES as Array<{ name: string; cwd?: string }>) {
      expect(gate.cwd, gate.name).toBe(inTheRelay.includes(gate.name) ? 'relay' : undefined)
    }
  })
})

// The version's notes must land with the bump, not be discovered minutes into a release on a Mac.
describe('every version this package has been is described', () => {
  const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string

  it(`has notes for ${version} at ${highlightsPath(version)}`, () => {
    const highlights = readHighlights(version)
    expect(highlights, `write ${highlightsPath(version)}`).not.toBeNull()
    // Long enough to describe something; a bare heading would pass "not null".
    expect((highlights as string).length).toBeGreaterThan(200)
  })

  it('is read per version, so a candidate uses the notes of the version it is for', () => {
    expect(highlightsPath('0.2.0')).toBe('docs/release-notes/0.2.0.md')
    expect(readHighlights('0.0.0-never-released')).toBeNull()
  })
})

describe('the notes the release carries', () => {
  const checksums = checksumLine('a'.repeat(64), 'teamree-0.1.0.dmg')

  it('formats a checksum exactly as `shasum -a 256` prints it, two spaces and all', () => {
    expect(checksums).toBe(`${'a'.repeat(64)}  teamree-0.1.0.dmg`)
  })

  // Generated from the bundle's signature, so a release cannot inherit the last one's paragraph.
  it('explains Gatekeeper when the build is ad-hoc signed', () => {
    const notes = releaseNotes({ tag: 'v0.1.0', repo: 'owner/teamree', checksums, kind: 'adhoc' })
    expect(notes).toContain('Nothing here is signed')
    expect(notes).toContain('xattr -dr com.apple.quarantine /Applications/teamree.app')
    expect(notes).toContain(checksums)
  })

  // The notes quoted the macOS 10.15-14 dialog, gone since macOS 15. This body is also what the
  // in-window update card shows, so it is the last thing most people read before double-clicking.
  it('quotes the dialog macOS 15 and later actually shows, not the one it retired', () => {
    const notes = releaseNotes({ tag: 'v0.1.0', repo: 'owner/teamree', checksums, kind: 'adhoc' })
    expect(notes).not.toContain('cannot be opened because the developer cannot be verified')
    expect(notes).toContain('"teamree" Not Opened')
    expect(notes).toContain('Apple could not verify')
  })

  // Move to Trash is the prominent button and deletes the download; the warning must be in the body.
  it('tells the reader not to press the button that deletes the download', () => {
    const notes = releaseNotes({ tag: 'v0.1.0', repo: 'owner/teamree', checksums, kind: 'adhoc' })
    expect(notes).toContain('Do not press Move to Trash')
    expect(notes).toContain('press')
    expect(notes).toContain('Done')
  })

  // Control-click > Open was removed in macOS 15.
  it('says there is no way through the dialog itself, so nobody hunts for one', () => {
    const notes = releaseNotes({ tag: 'v0.1.0', repo: 'owner/teamree', checksums, kind: 'adhoc' })
    expect(notes).toContain('There is no "Open Anyway" button in that dialog')
  })

  it('says so, and gives no quarantine command, when the build is signed and notarized', () => {
    const notes = releaseNotes({ tag: 'v0.1.0', repo: 'owner/teamree', checksums, kind: 'developer-id' })
    expect(notes).toContain('Signed and notarized')
    expect(notes).not.toContain('xattr')
  })

  // Above the signing section: the update card cuts the body at a length.
  it('puts what changed at the top, before the paragraph every release shares', () => {
    const notes = releaseNotes({
      tag: 'v0.2.0',
      repo: 'owner/teamree',
      checksums,
      kind: 'adhoc',
      highlights: '## What changed since 0.1.2\n\nA teammate cannot type into your pane unasked.'
    })
    expect(notes).toContain('A teammate cannot type into your pane unasked.')
    expect(notes.indexOf('What changed since 0.1.2')).toBeLessThan(notes.indexOf('Nothing here is signed'))
  })

  // How verify-quarantine-advice.mjs reads the command back out of the body.
  it('is still a whole set of notes when no highlights are handed to it', () => {
    const notes = releaseNotes({ tag: 'v0.1.0', repo: 'owner/teamree', checksums, kind: 'adhoc' })
    expect(notes).toContain('xattr -dr com.apple.quarantine /Applications/teamree.app')
    expect(notes).toContain(checksums)
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

// The download link's name must not go stale: `releases/latest/download/<name>` needs a version-free name.
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

  // The README said "Coming soon" three releases after the button went live. Asserted as the link's
  // presence, since there are unbounded wrong sentences and one right URL.
  it('is the link the README and the install document both hand a reader', () => {
    const url = `releases/latest/download/${STABLE_DMG_NAME}`
    for (const document of ['README.md', 'docs/install.md']) {
      expect(readFileSync(document, 'utf8')).toContain(url)
    }
  })
})
