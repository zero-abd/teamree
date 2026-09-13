// The primitives, each checked against something that is not this file.
//
// X25519 comes from RFC 7748's own test vectors, so a mistake in how we wrap
// raw scalars in DER cannot pass. HKDF is checked against Node's built-in
// implementation, which is the price of having written it out by hand for
// legibility in `primitives.ts`.

import { hkdfSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PeerErrorCode } from './errors'
import {
  concat,
  DH_LEN,
  derivePublicKey,
  dh,
  equalBytes,
  generateKeyPair,
  hash,
  hkdf,
  MAX_MESSAGE_LEN,
  MAX_NONCE,
  systemRandom,
  wipe
} from './primitives'

const bytes = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'hex'))
const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex')

// RFC 7748, section 6.1.
const RFC7748 = {
  alicePrivate: '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a',
  alicePublic: '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a',
  bobPrivate: '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb',
  bobPublic: 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f',
  shared: '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742'
}

// RFC 7748, section 5.2: a single scalar multiplication with a non-base point.
const RFC7748_SCALARMULT = {
  scalar: 'a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4',
  point: 'e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c',
  output: 'c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552'
}

function throwCode(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return (error as { code?: string }).code ?? 'not-a-peer-error'
  }
  throw new Error('expected the call to throw, and it returned')
}

describe('X25519 against RFC 7748', () => {
  it('derives the published public keys from the published private keys', () => {
    expect(hex(derivePublicKey(bytes(RFC7748.alicePrivate)))).toBe(RFC7748.alicePublic)
    expect(hex(derivePublicKey(bytes(RFC7748.bobPrivate)))).toBe(RFC7748.bobPublic)
  })

  it('computes the published shared secret from either direction', () => {
    expect(hex(dh(bytes(RFC7748.alicePrivate), bytes(RFC7748.bobPublic)))).toBe(RFC7748.shared)
    expect(hex(dh(bytes(RFC7748.bobPrivate), bytes(RFC7748.alicePublic)))).toBe(RFC7748.shared)
  })

  it('matches the published scalar multiplication for a non-base point', () => {
    expect(hex(dh(bytes(RFC7748_SCALARMULT.scalar), bytes(RFC7748_SCALARMULT.point)))).toBe(RFC7748_SCALARMULT.output)
  })

  it('refuses a low-order public key rather than returning an all-zero secret', () => {
    // The all-zero u-coordinate is the clearest of the small-order points: a
    // relay that substituted it would otherwise fix the shared secret for both
    // sides at zero.
    expect(throwCode(() => dh(bytes(RFC7748.alicePrivate), new Uint8Array(DH_LEN)))).toBe(PeerErrorCode.InvalidKey)
    expect(throwCode(() => dh(bytes(RFC7748.alicePrivate), new Uint8Array(DH_LEN).fill(0)))).toBe(
      PeerErrorCode.InvalidKey
    )
  })

  it('refuses key material of the wrong length instead of padding or truncating it', () => {
    expect(throwCode(() => derivePublicKey(new Uint8Array(31)))).toBe(PeerErrorCode.InvalidKey)
    expect(throwCode(() => derivePublicKey(new Uint8Array(33)))).toBe(PeerErrorCode.InvalidKey)
    expect(throwCode(() => dh(bytes(RFC7748.alicePrivate), new Uint8Array(31)))).toBe(PeerErrorCode.InvalidKey)
  })

  it('generates usable keypairs from an injected randomness source', () => {
    const fixed = (): Uint8Array => bytes(RFC7748.alicePrivate)
    const pair = generateKeyPair(fixed)
    expect(hex(pair.publicKey)).toBe(RFC7748.alicePublic)
    // And the real source produces keys that actually agree with each other.
    const a = generateKeyPair(systemRandom)
    const b = generateKeyPair(systemRandom)
    expect(hex(dh(a.privateKey, b.publicKey))).toBe(hex(dh(b.privateKey, a.publicKey)))
  })

  it('refuses a randomness source that returns the wrong number of bytes', () => {
    expect(throwCode(() => generateKeyPair(() => new Uint8Array(16)))).toBe(PeerErrorCode.InvalidKey)
  })
})

describe("Noise's HKDF against Node's", () => {
  it('produces the same two outputs as the platform implementation', () => {
    for (const seed of ['', 'a', 'the quick brown fox', 'x'.repeat(200)]) {
      const chainingKey = hash(new TextEncoder().encode(`ck:${seed}`))
      const material = new TextEncoder().encode(seed)
      const [first, second] = hkdf(chainingKey, material)
      const platform = new Uint8Array(hkdfSync('sha256', material, chainingKey, new Uint8Array(0), 64))
      expect(hex(concat(first, second))).toBe(hex(platform))
    }
  })

  it('depends on both the chaining key and the input, not just one of them', () => {
    const ck = hash(new TextEncoder().encode('ck'))
    const other = hash(new TextEncoder().encode('other'))
    const input = new TextEncoder().encode('input')
    expect(hex(hkdf(ck, input)[0])).not.toBe(hex(hkdf(other, input)[0]))
    expect(hex(hkdf(ck, input)[0])).not.toBe(hex(hkdf(ck, new Uint8Array(0))[0]))
    expect(hex(hkdf(ck, input)[0])).not.toBe(hex(hkdf(ck, input)[1]))
  })
})

describe('the small helpers', () => {
  it('pins the constants the wire format depends on', () => {
    expect(DH_LEN).toBe(32)
    expect(MAX_MESSAGE_LEN).toBe(65535)
    expect(MAX_NONCE).toBe(18446744073709551615n)
  })

  it('joins byte runs in order', () => {
    expect(hex(concat(bytes('0011'), new Uint8Array(0), bytes('2233')))).toBe('00112233')
    expect(concat()).toHaveLength(0)
  })

  it('compares bytes without tripping over differing lengths', () => {
    expect(equalBytes(bytes('0011'), bytes('0011'))).toBe(true)
    expect(equalBytes(bytes('0011'), bytes('0012'))).toBe(false)
    expect(equalBytes(bytes('0011'), bytes('001122'))).toBe(false)
    expect(equalBytes(new Uint8Array(0), new Uint8Array(0))).toBe(true)
  })

  it('erases in place, and tolerates having nothing to erase', () => {
    const secret = bytes('deadbeef')
    wipe(secret)
    expect(hex(secret)).toBe('00000000')
    expect(() => wipe(null)).not.toThrow()
  })
})
