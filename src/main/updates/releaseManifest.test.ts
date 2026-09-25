// The manifest is what ties a release's zip to a size and a SHA-256; without an exact match the
// app installs nothing and falls back to the disk image.

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReleaseAsset } from './latestRelease'
import { MANIFEST_NAME, parseManifest, promisedArchive, readManifest, type ReleaseManifest } from './releaseManifest'

const SHA = 'a'.repeat(64)
const OTHER_SHA = 'b'.repeat(64)

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: '0.3.0', file: 'teamree-0.3.0.zip', size: 1234, sha256: SHA, ...overrides }
}

function asset(overrides: Partial<ReleaseAsset> = {}): ReleaseAsset {
  return {
    name: 'teamree-0.3.0.zip',
    url: 'https://github.com/owner/project/releases/download/v0.3.0/teamree-0.3.0.zip',
    size: 1234,
    sha256: null,
    ...overrides
  }
}

describe('reading the manifest', () => {
  it('takes version, file, size and sha256', () => {
    expect(parseManifest(JSON.stringify(manifest()))).toEqual({
      version: '0.3.0',
      file: 'teamree-0.3.0.zip',
      size: 1234,
      sha256: SHA
    })
  })

  it('refuses anything that is not exactly that', () => {
    const bad = [
      'not json',
      '[]',
      JSON.stringify(manifest({ version: 'latest' })),
      JSON.stringify(manifest({ file: '../teamree.zip' })),
      JSON.stringify(manifest({ file: 'teamree-0.3.0.dmg' })),
      JSON.stringify(manifest({ file: 'dir/teamree.zip' })),
      JSON.stringify(manifest({ size: 0 })),
      JSON.stringify(manifest({ size: 12.5 })),
      JSON.stringify(manifest({ size: '1234' })),
      JSON.stringify(manifest({ sha256: 'A'.repeat(64) })),
      JSON.stringify(manifest({ sha256: 'a'.repeat(63) })),
      JSON.stringify({ version: '0.3.0', file: 'teamree-0.3.0.zip', size: 1234 })
    ]
    for (const text of bad) expect(parseManifest(text), text).toBeNull()
  })
})

describe('matching the manifest to the release', () => {
  const parsed = parseManifest(JSON.stringify(manifest())) as ReleaseManifest

  it('names the zip asset with the manifest size and hash', () => {
    expect(promisedArchive(parsed, { version: '0.3.0', assets: [asset()] })).toEqual({
      url: asset().url,
      name: 'teamree-0.3.0.zip',
      size: 1234,
      sha256: SHA
    })
  })

  it('accepts GitHub’s own digest when it agrees', () => {
    expect(promisedArchive(parsed, { version: '0.3.0', assets: [asset({ sha256: SHA })] })).not.toBeNull()
  })

  it('refuses a manifest for another version', () => {
    expect(promisedArchive(parsed, { version: '0.3.1', assets: [asset()] })).toBeNull()
  })

  it('refuses when the release has no such file', () => {
    expect(promisedArchive(parsed, { version: '0.3.0', assets: [asset({ name: 'other.zip' })] })).toBeNull()
  })

  it('refuses when GitHub reports a different size or digest', () => {
    expect(promisedArchive(parsed, { version: '0.3.0', assets: [asset({ size: 1235 })] })).toBeNull()
    expect(promisedArchive(parsed, { version: '0.3.0', assets: [asset({ sha256: OTHER_SHA })] })).toBeNull()
  })
})

describe('fetching the manifest', () => {
  let server: Server
  let origin: string
  let body = JSON.stringify(manifest())

  beforeEach(async () => {
    body = JSON.stringify(manifest())
    server = createServer((request, response) => {
      if (request.url === '/moved') response.writeHead(302, { location: `/${MANIFEST_NAME}` }).end()
      else if (request.url === `/${MANIFEST_NAME}`) response.writeHead(200).end(body)
      else response.writeHead(404).end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  const local = (url: string): boolean => new URL(url).origin === origin

  it('follows a redirect the policy allows', async () => {
    expect(await readManifest({ url: `${origin}/moved`, allowed: local })).toMatchObject({ version: '0.3.0' })
  })

  it('refuses a host the policy does not allow', async () => {
    await expect(readManifest({ url: `${origin}/moved`, allowed: () => false })).rejects.toThrow(/refused/)
  })

  it('answers null for a body that is not a manifest, and refuses an oversized one', async () => {
    body = '{"version": 1}'
    expect(await readManifest({ url: `${origin}/${MANIFEST_NAME}`, allowed: local })).toBeNull()
    body = ' '.repeat(64 * 1024)
    await expect(readManifest({ url: `${origin}/${MANIFEST_NAME}`, allowed: local })).rejects.toThrow(/larger/)
  })
})
