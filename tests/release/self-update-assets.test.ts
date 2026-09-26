// What a release publishes for the app to replace itself: the zip, and teamree-mac.json naming
// it. The manifest written here is read back by the app's own parser, so the two cannot drift.
import { describe, expect, it } from 'vitest'
import { parseManifest, promisedArchive } from '../../src/main/updates/releaseManifest'
import {
  MANIFEST_NAME,
  planLines,
  releaseAssets,
  releaseManifest,
  zipRefusal
  // @ts-expect-error -- untyped .mjs, deliberately outside the TypeScript build.
} from '../../scripts/release.mjs'

const SHA = 'c'.repeat(64)

describe('the manifest', () => {
  it('is named the way the app looks for it', () => {
    expect(MANIFEST_NAME).toBe('teamree-mac.json')
  })

  it('reads back through the app, and matches the release it is uploaded with', () => {
    const text = releaseManifest({ tag: 'v0.3.0', file: 'teamree-0.3.0.zip', size: 4096, sha256: SHA })
    const parsed = parseManifest(text)
    expect(parsed).toEqual({ version: '0.3.0', file: 'teamree-0.3.0.zip', size: 4096, sha256: SHA })

    const base = 'https://github.com/zero-abd/teamree/releases/download/v0.3.0'
    const assets = [{ name: 'teamree-0.3.0.zip', url: `${base}/teamree-0.3.0.zip`, size: 4096, sha256: SHA }]
    expect(promisedArchive(parsed!, { version: '0.3.0', assets })).not.toBeNull()
  })
})

describe('the zip', () => {
  it('passes with one app at the version, whose signature verifies', () => {
    expect(zipRefusal({ entries: ['teamree.app'], version: '0.3.0', verifies: true }, '0.3.0')).toBeNull()
  })

  it('is refused with anything else in it, another version, or a signature that no longer verifies', () => {
    expect(zipRefusal({ entries: ['teamree.app', 'x'], version: '0.3.0', verifies: true }, '0.3.0')).toMatch(/one app/)
    expect(zipRefusal({ entries: ['teamree.app'], version: '0.2.0', verifies: true }, '0.3.0')).toMatch(/0\.2\.0/)
    expect(zipRefusal({ entries: ['teamree.app'], version: '0.3.0', verifies: false }, '0.3.0')).toMatch(/signature/)
  })
})

describe('what is uploaded', () => {
  it('is the two images, the zip, the manifest, its signature and the checksums', () => {
    expect(
      releaseAssets({
        dmg: 'dist/teamree-0.3.0.dmg',
        stableDmg: 'dist/teamree-mac-universal.dmg',
        zip: 'dist/teamree-0.3.0.zip',
        manifest: 'dist/teamree-mac.json',
        signature: 'dist/teamree-mac.json.sig',
        sums: 'dist/SHA256SUMS.txt'
      })
    ).toEqual([
      'dist/teamree-0.3.0.dmg',
      'dist/teamree-mac-universal.dmg',
      'dist/teamree-0.3.0.zip',
      'dist/teamree-mac.json',
      'dist/teamree-mac.json.sig',
      'dist/SHA256SUMS.txt'
    ])
  })

  it('is named in the plan', () => {
    const plan = planLines({
      tag: 'v0.3.0',
      repo: 'owner/teamree',
      head: 'a'.repeat(40),
      branch: 'main',
      dmg: 'teamree-0.3.0.dmg',
      size: 1024,
      hash: SHA,
      kind: 'adhoc',
      dryRun: true,
      zip: 'teamree-0.3.0.zip'
    }).join('\n')
    expect(plan).toContain('teamree-0.3.0.zip')
    expect(plan).toContain('teamree-mac.json.sig')
  })
})
