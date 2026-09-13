// The rendezvous scheme, pinned.
//
// Two peers that disagree about any byte of this never meet, and they never
// find out why — they simply sit on different rendezvous forever. So the parts
// `relay/README.md` leaves to the client are fixed here with vectors rather
// than with round-trips, because a round-trip test agrees with itself.

import { describe, expect, it } from 'vitest'
import {
  EPOCH_SECONDS,
  epochAt,
  epochEndsAt,
  rendezvousId,
  rendezvousInfo,
  rendezvousToken,
  rendezvousUrl,
  sessionPrologue,
  sharedSecret
} from './rendezvous'
import { generateStaticKeyPair, derivePublicKey } from '../../../shared/peer'

const SECRET = new Uint8Array(32).fill(0x2a)
const PROJECT = 'a'.repeat(64)
const OTHER_PROJECT = 'b'.repeat(64)

describe('the token', () => {
  it('is 32 bytes as 64 lowercase hex characters, which is the only shape the relay takes', () => {
    expect(rendezvousToken(SECRET, PROJECT, 470_000)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('derives from a versioned, unambiguous info the README leaves unspecified', () => {
    // `info = epoch` has several readings, the relay cannot arbitrate between
    // them, and two peers who disagree never meet and are never told why. The
    // structure is pinned here — a version tag, a fixed-width project key and
    // decimal digits, newline-separated, so no two inputs can collide — and so
    // is the vector, so a change to any of it fails loudly rather than quietly
    // stranding every team on the spelling they had before.
    expect(rendezvousInfo(PROJECT, 470_000)).toBe(`teamree/rendezvous/v2\n${PROJECT}\n470000`)
    expect(rendezvousToken(SECRET, PROJECT, 470_000)).toBe(
      '4f520b12ed81b61f5ba336360e85ce243e357e614032a7b4fc4062efa4413b45'
    )
  })

  it('is different for the same pair in a different repository', () => {
    // The divergence from the README that matters. Its scheme is pairwise, so
    // two people who share three repositories would hold one session of one
    // shape with nothing in the transcript saying which project any of it is
    // for, and every per-project rule would have to be re-derived by hand at
    // every point of use.
    expect(rendezvousToken(SECRET, PROJECT, 470_000)).not.toBe(rendezvousToken(SECRET, OTHER_PROJECT, 470_000))
  })

  it('refuses a project key that is not 32 bytes of hex, rather than hashing a typo', () => {
    expect(() => rendezvousInfo('not-a-key', 1)).toThrow()
    expect(() => rendezvousInfo(PROJECT.toUpperCase(), 1)).toThrow()
  })

  it('rotates every hour and is stable within one', () => {
    const epoch = epochAt(1_700_000_000_000)
    expect(rendezvousToken(SECRET, PROJECT, epoch)).toBe(rendezvousToken(SECRET, PROJECT, epoch))
    expect(rendezvousToken(SECRET, PROJECT, epoch)).not.toBe(rendezvousToken(SECRET, PROJECT, epoch + 1))
    expect(rendezvousToken(SECRET, PROJECT, epoch)).not.toBe(rendezvousToken(SECRET, PROJECT, epoch - 1))
  })

  it('is different for every pair, so one team’s mesh looks like a set of strangers', () => {
    const a = generateStaticKeyPair()
    const b = generateStaticKeyPair()
    const c = generateStaticKeyPair()
    const epoch = epochAt(Date.now())
    const ab = rendezvousToken(sharedSecret(a.privateKey, base64(b.publicKey)), PROJECT, epoch)
    const ac = rendezvousToken(sharedSecret(a.privateKey, base64(c.publicKey)), PROJECT, epoch)
    expect(ab).not.toBe(ac)
  })
})

describe('the prologue', () => {
  it('binds the project and the pairing into the transcript, and is never empty', () => {
    // `IK` authenticates two static keys and says nothing about the subject.
    // The prologue is the only place a fact can go that both sides must already
    // agree on and an attacker cannot influence — and an empty one, which is
    // what the peer library defaults to, is a transcript that says nothing.
    const prologue = sessionPrologue(PROJECT, rendezvousToken(SECRET, PROJECT, 470_000))
    expect(prologue).toHaveLength(32)
    expect(prologue.some((byte) => byte !== 0)).toBe(true)
  })

  it('differs for the same pairing in a different project', () => {
    const token = rendezvousToken(SECRET, PROJECT, 470_000)
    expect(sessionPrologue(PROJECT, token)).not.toEqual(sessionPrologue(OTHER_PROJECT, token))
  })

  it('differs each hour, because the token it binds does', () => {
    expect(sessionPrologue(PROJECT, rendezvousToken(SECRET, PROJECT, 470_000))).not.toEqual(
      sessionPrologue(PROJECT, rendezvousToken(SECRET, PROJECT, 470_001))
    )
  })

  it('refuses a project key it cannot recognise, rather than binding a typo', () => {
    expect(() => sessionPrologue('nope', 'a'.repeat(64))).toThrow()
  })
})

describe('the shared secret', () => {
  it('is the same 32 bytes from either side of the pair', () => {
    const a = generateStaticKeyPair()
    const b = generateStaticKeyPair()
    expect(sharedSecret(a.privateKey, base64(b.publicKey))).toEqual(sharedSecret(b.privateKey, base64(a.publicKey)))
  })

  it('agrees with the public key the peer library derives from the same scalar', () => {
    const pair = generateStaticKeyPair()
    expect(base64(derivePublicKey(pair.privateKey))).toBe(base64(pair.publicKey))
  })
})

describe('the URL', () => {
  it('carries the token’s hash and never the token', () => {
    const token = rendezvousToken(SECRET, PROJECT, 470_000)
    const url = rendezvousUrl('wss://relay.example/v1/relay', token)
    expect(url).toBe(`wss://relay.example/v1/relay/${rendezvousId(token)}`)
    // The token is a capability — whoever holds it can claim the pairing — and
    // a URL is the least private thing in an HTTP stack.
    expect(url).not.toContain(token)
  })

  it('does not double a slash a configured URL happened to end with', () => {
    const token = rendezvousToken(SECRET, PROJECT, 1)
    expect(rendezvousUrl('wss://relay.example/v1/relay/', token)).toBe(
      `wss://relay.example/v1/relay/${rendezvousId(token)}`
    )
  })
})

describe('the epoch', () => {
  it('ends on the hour, so a parked peer knows when its token stops working', () => {
    const now = 1_700_000_000_000
    const ends = epochEndsAt(now)
    expect(ends).toBeGreaterThan(now)
    expect(ends - now).toBeLessThanOrEqual(EPOCH_SECONDS * 1000)
    expect(epochAt(ends)).toBe(epochAt(now) + 1)
  })
})

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}
