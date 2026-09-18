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
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// The release script is plain ESM because it is run by `npm run release` from a
// checkout, before anything has been built. The directive below sits against
// the specifier rather than against the statement because that is the line
// TypeScript reports the missing declarations on.
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

  // The one refusal about the page rather than about the build. A release whose
  // notes nobody wrote looks, on the releases page, exactly like one whose notes
  // somebody wrote — there is no gap in it to notice — so the absence has to be
  // caught here or not at all.
  it('refuses a version nothing describes, and names the file to write', () => {
    const refusals = preflightRefusals(ready({ version: '0.4.0', tag: 'v0.4.0', highlights: null }))
    expect(refusals.join()).toContain('docs/release-notes/0.4.0.md')
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

// The version in package.json is the only source of truth for what is being
// released, and this is the one thing that has to move with it. Checked in the
// suite rather than only at release time so that the bump and the notes land in
// the same change: `npm run release` would refuse a version nothing describes,
// but it would refuse it on a Mac, minutes into a sequence, to somebody who
// thought they were cutting a release.
describe('every version this package has been is described', () => {
  const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string

  it(`has notes for ${version} at ${highlightsPath(version)}`, () => {
    const highlights = readHighlights(version)
    expect(highlights, `write ${highlightsPath(version)}`).not.toBeNull()
    // Long enough to be an account of something. A file holding a heading and
    // nothing under it would satisfy "not null" and tell a downloader nothing.
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

  // The notes are generated from the signature on the bundle that is about to
  // be published, so a release cannot inherit the last one's paragraph.
  it('explains Gatekeeper when the build is ad-hoc signed', () => {
    const notes = releaseNotes({ tag: 'v0.1.0', repo: 'owner/teamree', checksums, kind: 'adhoc' })
    expect(notes).toContain('Nothing here is signed')
    expect(notes).toContain('xattr -dr com.apple.quarantine /Applications/teamree.app')
    expect(notes).toContain(checksums)
  })

  // The defect this pins: the notes told a downloader macOS would say teamree
  // "cannot be opened because the developer cannot be verified". That is the
  // macOS 10.15-14 string. It has not existed since macOS 15, and both
  // `docs/install.md` and `site/README.md` already said so in as many words —
  // site/README.md going as far as "is not used anywhere on the page", which
  // was true of the page and false of the text with the widest readership
  // there is. This body is the GitHub release description *and* what
  // `updateNotice` renders inside the window for somebody still on the old
  // build, so it is the last thing most people read before they double-click.
  it('quotes the dialog macOS 15 and later actually shows, not the one it retired', () => {
    const notes = releaseNotes({ tag: 'v0.1.0', repo: 'owner/teamree', checksums, kind: 'adhoc' })
    expect(notes).not.toContain('cannot be opened because the developer cannot be verified')
    expect(notes).toContain('"teamree" Not Opened')
    expect(notes).toContain('Apple could not verify')
  })

  // The single most expensive sentence to omit. **Move to Trash** is the
  // prominent button in that dialog and it deletes the download; a careful
  // reader reaches for it. `docs/install.md` and the site both carry the
  // warning, and sending somebody to a second document for it is sending them
  // there after they have already pressed something.
  it('tells the reader not to press the button that deletes the download', () => {
    const notes = releaseNotes({ tag: 'v0.1.0', repo: 'owner/teamree', checksums, kind: 'adhoc' })
    expect(notes).toContain('Do not press Move to Trash')
    expect(notes).toContain('press')
    expect(notes).toContain('Done')
  })

  // Control-click > Open was the way through for macOS 10.15-14 and macOS 15
  // removed it. Notes that implied there was a button in the dialog would send
  // a reader hunting for one that is not there.
  it('says there is no way through the dialog itself, so nobody hunts for one', () => {
    const notes = releaseNotes({ tag: 'v0.1.0', repo: 'owner/teamree', checksums, kind: 'adhoc' })
    expect(notes).toContain('There is no "Open Anyway" button in that dialog')
  })

  it('says so, and gives no quarantine command, when the build is signed and notarized', () => {
    const notes = releaseNotes({ tag: 'v0.1.0', repo: 'owner/teamree', checksums, kind: 'developer-id' })
    expect(notes).toContain('Signed and notarized')
    expect(notes).not.toContain('xattr')
  })

  // Above the signing section, because the update card in the window shows this
  // body as text and cuts it at a length: what is at the top is what somebody
  // running the old build reads, and the Gatekeeper paragraph is the same in
  // every release and in docs/install.md besides.
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

  // scripts/verify-quarantine-advice.mjs calls it this way, to read the
  // quarantine command back out of a body it does not care about the rest of.
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

  // The defect this pins: three releases had been published, the website was
  // rendering a live Download for macOS button at this exact URL, and the
  // README — the page anybody arriving at the repository reads first — still
  // opened its Install section with "Coming soon. Packaged macOS builds are not
  // published yet." A front door that says there is nothing to download is a
  // worse failure than a broken link, because nobody goes looking for the file
  // it did not mention.
  //
  // Asserted as the presence of the link rather than the absence of a sentence,
  // because there is one URL that is correct and an unbounded number of ways to
  // say the wrong thing about it.
  it('is the link the README and the install document both hand a reader', () => {
    const url = `releases/latest/download/${STABLE_DMG_NAME}`
    for (const document of ['README.md', 'docs/install.md']) {
      expect(readFileSync(document, 'utf8')).toContain(url)
    }
  })
})
