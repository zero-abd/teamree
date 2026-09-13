// What the app is willing to believe about a release.
//
// Every test here is about the response being somebody else's data. The stub
// answers with real `Response` objects rather than plain objects, so the byte
// budget, the status check and the body reader are all the ones that run in the
// app rather than shapes that resemble them.

import { describe, expect, it } from 'vitest'
import { isReleaseDownload, plainText, readLatestRelease, MAX_NOTES_CHARS } from './latestRelease'

const REPOSITORY = 'owner/project'

/** A release as GitHub sends one, with only the fields this app reads. */
function release(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: 'v0.2.0',
    body: 'Faster panes.',
    draft: false,
    prerelease: false,
    published_at: '2025-03-04T10:00:00Z',
    assets: [
      {
        name: 'teamree-mac-universal.dmg',
        browser_download_url: `https://github.com/${REPOSITORY}/releases/download/v0.2.0/teamree-mac-universal.dmg`
      }
    ],
    ...overrides
  }
}

/** A fetch that answers with this body, and records what was asked for. */
function answering(body: unknown, init: ResponseInit = {}): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const fetchImpl = (async (input: unknown) => {
    urls.push(String(input))
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
      ...init
    })
  }) as unknown as typeof fetch
  return { fetchImpl, urls }
}

async function read(body: unknown, channel: 'stable' | 'prerelease' = 'stable', init: ResponseInit = {}) {
  const { fetchImpl, urls } = answering(body, init)
  const found = await readLatestRelease({ channel, repository: REPOSITORY, version: '0.1.0', fetchImpl })
  return { found, urls }
}

describe('reading the latest release', () => {
  it('asks the endpoint that already excludes drafts and candidates', async () => {
    const { found, urls } = await read(release())
    expect(urls[0]).toBe(`https://api.github.com/repos/${REPOSITORY}/releases/latest`)
    expect(found).toMatchObject({ version: '0.2.0', tag: 'v0.2.0', notes: 'Faster panes.' })
    expect(found?.downloadUrl).toContain('teamree-mac-universal.dmg')
  })

  it('builds the release page out of the tag rather than trusting a link in the answer', async () => {
    const { found } = await read(release({ html_url: 'https://example.invalid/phishing' }))
    expect(found?.releaseUrl).toBe(`https://github.com/${REPOSITORY}/releases/tag/v0.2.0`)
  })

  it('reads the newest of the list on the pre-release channel, by precedence and not by order', async () => {
    const { found, urls } = await read(
      [
        release({ tag_name: 'v0.3.0-rc.1', prerelease: true }),
        release({ tag_name: 'v0.9.0', draft: true }),
        release({ tag_name: 'v0.3.0-rc.2', prerelease: true }),
        release({ tag_name: 'v0.2.0' })
      ],
      'prerelease'
    )
    expect(urls[0]).toContain('/releases?per_page=')
    expect(found?.tag).toBe('v0.3.0-rc.2')
  })

  it('reports the status when GitHub refuses, without a body to read', async () => {
    await expect(read('{}', 'stable', { status: 403 })).rejects.toThrow(/403/)
  })
})

describe('what it refuses to believe', () => {
  it('drops a release whose tag is not one of this project’s', async () => {
    // The traversal case names `etc/hosts` rather than the file secret
    // scanners are trained to look for: the assertion is about the `../`, and
    // the target is arbitrary, so there is no reason to spend a permanently
    // red security check on the spelling of a string this test never resolves.
    for (const tag of ['latest', 'v0.2', '../../../etc/hosts', 'v0.2.0?x=1']) {
      const { found } = await read(release({ tag_name: tag }))
      expect(found, tag).toBeNull()
    }
  })

  it('drops a draft, and a candidate that arrived on the stable channel', async () => {
    expect((await read(release({ draft: true }))).found).toBeNull()
    expect((await read(release({ prerelease: true }))).found).toBeNull()
  })

  it('treats a candidate tag as a candidate whether or not the flag was set', async () => {
    const { found } = await read([release({ tag_name: 'v0.3.0-rc.1', prerelease: false })], 'prerelease')
    expect(found?.prerelease).toBe(true)
  })

  // The field that ends up in somebody's browser. A string comparison against
  // "https://github.com" is passed by `https://github.com.example.invalid/`.
  it('refuses a download link that does not lead into this repository', async () => {
    for (const url of [
      'https://github.com.example.invalid/owner/project/releases/download/v0.2.0/x.dmg',
      'http://github.com/owner/project/releases/download/v0.2.0/x.dmg',
      'https://github.com/someone-else/project/releases/download/v0.2.0/x.dmg',
      'javascript:alert(1)',
      'not a url at all'
    ]) {
      const { found } = await read(release({ assets: [{ name: 'x.dmg', browser_download_url: url }] }))
      expect(found?.downloadUrl, url).toBeNull()
      // And the release itself still stands: there is a newer version, and the
      // page it lives on is a link this app composed.
      expect(found?.releaseUrl, url).toBe(`https://github.com/${REPOSITORY}/releases/tag/v0.2.0`)
    }
  })

  it('survives a body that is not the shape the API documents', async () => {
    expect((await read({ nothing: 'useful' })).found).toBeNull()
    expect((await read([{ tag_name: 42 }], 'prerelease')).found).toBeNull()
    // Not JSON at all is a failed check rather than "no release", because the
    // two are different facts and only one of them is worth remembering.
    await expect(read('not json at all')).rejects.toThrow()
  })

  it('abandons a body too large to be a release', async () => {
    const enormous = { tag_name: 'v0.2.0', body: 'x'.repeat(400_000) }
    await expect(read(enormous)).rejects.toThrow(/larger than/)
  })
})

describe('release notes, before anything shows them', () => {
  it('keeps the words and loses the control characters', () => {
    expect(plainText('Line one\r\nLine two\u001b[31m red')).toBe('Line one\nLine two[31m red')
  })
  // Markup stays markup: it is not rendered anywhere, and taking it out would
  // quietly rewrite what a maintainer wrote. The card puts this in a text node.
  it('leaves markup exactly as written, because nothing renders it', () => {
    const body = '<img src=x onerror="alert(1)"> and <b>bold</b>'
    expect(plainText(body)).toBe(body)
  })

  it('has nothing to say about a release with an empty body', () => {
    expect(plainText('')).toBeNull()
    expect(plainText('   \n  ')).toBeNull()
  })

  it('cuts notes longer than a person would read, and says it did', () => {
    const long = plainText('y'.repeat(MAX_NOTES_CHARS + 500))
    expect(long).toHaveLength(MAX_NOTES_CHARS + 1)
    expect(long?.endsWith('…')).toBe(true)
  })
})

describe('what counts as a release download', () => {
  it('is an https address in this repository’s releases and nothing else', () => {
    expect(isReleaseDownload(`https://github.com/${REPOSITORY}/releases/tag/v1.0.0`, REPOSITORY)).toBe(true)
    expect(isReleaseDownload(`https://github.com/${REPOSITORY}/issues/1`, REPOSITORY)).toBe(false)
    expect(isReleaseDownload(`https://gist.github.com/${REPOSITORY}/releases/x`, REPOSITORY)).toBe(false)
  })
})
