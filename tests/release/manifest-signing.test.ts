// The release signs teamree-mac.json with the owner's ed25519 key and refuses to run without the right one.
// Every key here is generated for the test; the owner's key and home folder are never touched.
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TRUSTED_RELEASE_KEYS } from '../../src/main/updates/releaseKeys'
import { signatureVerifies } from '../../src/main/updates/releaseManifest'
import {
  SIGNATURE_NAME,
  SIGNING_KEY_ENV,
  loadSigningKey,
  preflightRefusals,
  releaseManifest,
  signManifest,
  trustedPublicKeys
  // @ts-expect-error -- untyped .mjs, deliberately outside the TypeScript build.
} from '../../scripts/release.mjs'

const owner = generateKeyPairSync('ed25519')
const stranger = generateKeyPairSync('ed25519')
const publicPem = (key: KeyObject): string => key.export({ type: 'spki', format: 'pem' }).toString()
const privatePem = (key: KeyObject): string => key.export({ type: 'pkcs8', format: 'pem' }).toString()
const TRUSTED = [publicPem(owner.publicKey)]

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'teamree-signing-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** Writes a key where the release looks by default, under the test's own stand-in home. */
function keyFile(key: KeyObject, mode = 0o600): string {
  const folder = join(home, '.config', 'teamree')
  mkdirSync(folder, { recursive: true })
  const path = join(folder, 'release-signing-key.pem')
  writeFileSync(path, privatePem(key))
  chmodSync(path, mode)
  return path
}

describe('the signing key', () => {
  it('is read from the default path when it matches the key the app trusts', () => {
    keyFile(owner.privateKey)
    const loaded = loadSigningKey({ env: {}, home, trusted: TRUSTED, dryRun: false })
    expect(loaded.refusal).toBeUndefined()
    expect(loaded.throwaway).toBe(false)
  })

  it('is read from the variable, as a path or as the key itself', () => {
    const path = keyFile(owner.privateKey)
    const elsewhere = mkdtempSync(join(tmpdir(), 'teamree-signing-empty-'))
    try {
      for (const value of [path, privatePem(owner.privateKey)]) {
        const loaded = loadSigningKey({ env: { [SIGNING_KEY_ENV]: value }, home: elsewhere, trusted: TRUSTED })
        expect(loaded.refusal).toBeUndefined()
      }
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('refuses a real release without one', () => {
    expect(loadSigningKey({ env: {}, home, trusted: TRUSTED, dryRun: false }).refusal).toMatch(/no release signing key/)
  })

  it('lets a dry run go on with a throwaway key, and says so', () => {
    const loaded = loadSigningKey({ env: {}, home, trusted: TRUSTED, dryRun: true })
    expect(loaded.refusal).toBeUndefined()
    expect(loaded.throwaway).toBe(true)
  })

  it('refuses a key whose public half the app does not trust, dry run or not', () => {
    keyFile(stranger.privateKey)
    for (const dryRun of [false, true]) {
      expect(loadSigningKey({ env: {}, home, trusted: TRUSTED, dryRun }).refusal).toMatch(/does not match/)
    }
  })

  it('refuses a key file anybody but its owner can read', () => {
    keyFile(owner.privateKey, 0o644)
    expect(loadSigningKey({ env: {}, home, trusted: TRUSTED, dryRun: false }).refusal).toMatch(/644/)
  })

  it('refuses something that is not an ed25519 key', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 })
    keyFile(rsa.privateKey)
    expect(loadSigningKey({ env: {}, home, trusted: TRUSTED, dryRun: false }).refusal).toMatch(/ed25519/)
  })

  it('stops the release before any gate runs', () => {
    const refusals = preflightRefusals({
      tag: 'v0.1.0',
      version: '0.1.0',
      head: 'a'.repeat(40),
      dirty: '',
      highlights: 'notes',
      relayInstalled: true,
      ghAuthenticated: true,
      repo: 'owner/teamree',
      releaseExists: false,
      localTag: null,
      remoteTag: null,
      remoteHeads: ['a'.repeat(40)],
      signing: 'no release signing key'
    })
    expect(refusals).toEqual(['no release signing key'])
  })
})

describe('the signature', () => {
  it('is over the exact manifest bytes, and the app accepts it', () => {
    expect(SIGNATURE_NAME).toBe('teamree-mac.json.sig')
    const manifest = releaseManifest({ tag: 'v0.3.0', file: 'teamree-0.3.0.zip', size: 4096, sha256: 'c'.repeat(64) })
    const signature = signManifest(Buffer.from(manifest), owner.privateKey)
    expect(signatureVerifies(Buffer.from(manifest), signature, TRUSTED)).toBe(true)
    expect(signatureVerifies(Buffer.from(`${manifest} `), signature, TRUSTED)).toBe(false)
  })

  it('is checked against the keys the app embeds, read from the same file', () => {
    const normalize = (pem: string): string => pem.trim()
    expect(trustedPublicKeys().map(normalize)).toEqual(TRUSTED_RELEASE_KEYS.map(normalize))
    expect(TRUSTED_RELEASE_KEYS.length).toBeGreaterThan(0)
  })
})
