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
  rendezvousToken,
  rendezvousUrl,
  sharedSecret
} from './rendezvous'
import { generateStaticKeyPair, derivePublicKey } from '../../../shared/peer'

const SECRET = new Uint8Array(32).fill(0x2a)

describe('the token', () => {
  it('is 32 bytes as 64 lowercase hex characters, which is the only shape the relay takes', () => {
    expect(rendezvousToken(SECRET, 470_000)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('encodes the epoch as its decimal digits, which the relay’s README does not say', () => {
    // The vector, not the property. `info = epoch` has several readings and the
    // relay cannot arbitrate between them, so the choice is recorded here: if
    // somebody changes it, this fails instead of every team's links quietly
    // going dark.
    expect(rendezvousToken(SECRET, 470_000)).toBe('44d9c65d21de095378e25b960c27b233da0e84721e5e49d663eb02a1313a3aab')
  })

  it('rotates every hour and is stable within one', () => {
    const epoch = epochAt(1_700_000_000_000)
    expect(rendezvousToken(SECRET, epoch)).toBe(rendezvousToken(SECRET, epoch))
    expect(rendezvousToken(SECRET, epoch)).not.toBe(rendezvousToken(SECRET, epoch + 1))
    expect(rendezvousToken(SECRET, epoch)).not.toBe(rendezvousToken(SECRET, epoch - 1))
  })

  it('is different for every pair, so one team’s mesh looks like a set of strangers', () => {
    const a = generateStaticKeyPair()
    const b = generateStaticKeyPair()
    const c = generateStaticKeyPair()
    const epoch = epochAt(Date.now())
    const ab = rendezvousToken(sharedSecret(a.privateKey, base64(b.publicKey)), epoch)
    const ac = rendezvousToken(sharedSecret(a.privateKey, base64(c.publicKey)), epoch)
    expect(ab).not.toBe(ac)
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
    const token = rendezvousToken(SECRET, 470_000)
    const url = rendezvousUrl('wss://relay.example/v1/relay', token)
    expect(url).toBe(`wss://relay.example/v1/relay/${rendezvousId(token)}`)
    // The token is a capability — whoever holds it can claim the pairing — and
    // a URL is the least private thing in an HTTP stack.
    expect(url).not.toContain(token)
  })

  it('does not double a slash a configured URL happened to end with', () => {
    const token = rendezvousToken(SECRET, 1)
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
