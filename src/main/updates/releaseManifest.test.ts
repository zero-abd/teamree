// The manifest ties a release's zip to a size and a SHA-256, and is trusted only when the owner's
// key signed it. Throwaway keys throughout; the real private key never appears in a test.

import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReleaseAsset } from './latestRelease'
import {
  MANIFEST_NAME,
  SIGNATURE_NAME,
  UntrustedRelease,
  parseManifest,
  promisedArchive,
  trustedManifest,
  type ReleaseManifest
} from './releaseManifest'

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

describe('trusting the manifest', () => {
  const owner = generateKeyPairSync('ed25519')
  const stranger = generateKeyPairSync('ed25519')
  const pem = (key: KeyObject): string => key.export({ type: 'spki', format: 'pem' }).toString()
  const KEYS = [pem(owner.publicKey)]
  const sign = (bytes: string, key: KeyObject = owner.privateKey): string =>
    cryptoSign(null, Buffer.from(bytes), key).toString('base64')

  let server: Server
  let origin: string
  let files: Map<string, string>
  let requested: string[]

  beforeEach(async () => {
    const body = JSON.stringify(manifest())
    files = new Map([
      [MANIFEST_NAME, body],
      [SIGNATURE_NAME, `${sign(body)}\n`]
    ])
    requested = []
    server = createServer((request, response) => {
      const name = (request.url ?? '').slice(1)
      requested.push(name)
      const file = files.get(name)
      if (file === undefined) response.writeHead(404).end()
      else response.writeHead(200).end(file)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  const local = (url: string): boolean => new URL(url).origin === origin
  const release = (tag = 'v0.3.0', names = [MANIFEST_NAME, SIGNATURE_NAME, 'teamree-0.3.0.zip']) => ({
    tag,
    assets: names.map((name) => asset({ name, url: `${origin}/${name}` }))
  })
  const trust = (
    options: { tag?: string; names?: string[]; current?: string; keys?: readonly string[] } = {}
  ): Promise<ReleaseManifest> =>
    trustedManifest(release(options.tag, options.names), {
      current: options.current ?? '0.2.0',
      keys: options.keys ?? KEYS,
      allowed: local
    })

  it('accepts a manifest the owner signed, for a newer version under its own tag', async () => {
    await expect(trust()).resolves.toMatchObject({ version: '0.3.0', sha256: SHA })
  })

  it('accepts any trusted key, so a rotation can carry the old and the new', async () => {
    await expect(trust({ keys: [pem(stranger.publicKey), ...KEYS] })).resolves.toMatchObject({ version: '0.3.0' })
  })

  it('refuses a manifest changed after it was signed', async () => {
    files.set(MANIFEST_NAME, JSON.stringify(manifest({ sha256: OTHER_SHA })))
    await expect(trust()).rejects.toThrow(UntrustedRelease)
  })

  it('refuses a signature from a key the app does not trust', async () => {
    files.set(SIGNATURE_NAME, sign(files.get(MANIFEST_NAME) as string, stranger.privateKey))
    await expect(trust()).rejects.toThrow(UntrustedRelease)
  })

  it('refuses a release with no signature, or a signature that is not one', async () => {
    await expect(trust({ names: [MANIFEST_NAME, 'teamree-0.3.0.zip'] })).rejects.toThrow(UntrustedRelease)
    files.set(SIGNATURE_NAME, 'not a signature')
    await expect(trust()).rejects.toThrow(UntrustedRelease)
  })

  it('refuses a signed manifest for a version that is not newer than this one', async () => {
    await expect(trust({ current: '0.3.0' })).rejects.toThrow(/not newer/)
    await expect(trust({ current: '0.4.0' })).rejects.toThrow(UntrustedRelease)
  })

  it('refuses a signed manifest published under another tag', async () => {
    await expect(trust({ tag: 'v0.4.0' })).rejects.toThrow(/v0\.4\.0/)
  })

  it('never fetches the zip, whatever it refuses', async () => {
    files.set(SIGNATURE_NAME, sign('{}'))
    await expect(trust()).rejects.toThrow(UntrustedRelease)
    expect(requested).not.toContain('teamree-0.3.0.zip')
  })

  it('refuses a host the policy does not allow, and an oversized manifest', async () => {
    await expect(trustedManifest(release(), { current: '0.2.0', keys: KEYS, allowed: () => false })).rejects.toThrow(
      /refused/
    )
    files.set(MANIFEST_NAME, ' '.repeat(64 * 1024))
    await expect(trust()).rejects.toThrow(/larger/)
  })
})
