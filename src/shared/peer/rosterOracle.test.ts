// What a stranger can learn by dialling a responder it has never been
// introduced to.
//
// An attacker needs nothing but the responder's static public key, which the
// rendezvous hands it anyway. IK seals the initiator's `s` token under `es`
// alone, and `es` is a DH between the attacker's own ephemeral and that public
// key — so it can put *any* static key in that slot without holding the private
// half. It cannot go further: `ss` needs the private half, so the payload it
// appends is junk and the handshake is doomed either way.
//
// The question these tests answer is whether the two doomed handshakes are
// doomed in the same way. If refusing an off-roster key is cheaper than failing
// on an on-roster one, the difference is a roster-membership oracle: point it at
// a relay endpoint and a suspected public key and it says whether that person is
// on that host's team. That is the one property the rendezvous design exists to
// protect, and the relay operator is on the path by construction.
//
// The assertions here are about work done, not wall-clock time — a timing
// threshold in a test suite measures the machine it runs on — but work done is
// what the clock was measuring.

import { describe, expect, it, vi } from 'vitest'
import { isPeerError } from './errors'
import { encryptAndHash, initializeSymmetric, mixHash, mixKey } from './noise'
import { concat, dh, generateKeyPair, hash, type KeyPair } from './primitives'
import { createResponderSession, generateStaticKeyPair, PROTOCOL_NAME, rosterOf } from './session'

function seededRandom(seed: string): (length: number) => Uint8Array {
  let counter = 0
  return (length) => {
    const out = new Uint8Array(length)
    let offset = 0
    while (offset < out.length) {
      const block = hash(new TextEncoder().encode(`${seed}:${counter++}`))
      out.set(block.subarray(0, Math.min(block.length, out.length - offset)), offset)
      offset += block.length
    }
    return out
  }
}

const bob = generateStaticKeyPair(seededRandom('oracle-bob')) // the host being probed
const alice = generateStaticKeyPair(seededRandom('oracle-alice')) // on bob's roster
const stranger = generateStaticKeyPair(seededRandom('oracle-stranger')) // not on it

/**
 * A first message claiming `claimed` as its static key, built by somebody who
 * knows only bob's public key. Everything up to and including the `s` token is
 * genuine; the payload slot is 16 bytes of noise, because computing the real
 * one would need the private half of the key being claimed.
 */
function forgeFirstMessage(claimed: Uint8Array, seed: string): Uint8Array {
  const random = seededRandom(seed)
  const symmetric = initializeSymmetric(PROTOCOL_NAME)
  mixHash(symmetric, new Uint8Array(0)) // prologue
  mixHash(symmetric, bob.publicKey) // the responder pre-message static
  const ephemeral = generateKeyPair(random)
  mixHash(symmetric, ephemeral.publicKey)
  mixKey(symmetric, dh(ephemeral.privateKey, bob.publicKey)) // es
  return concat(ephemeral.publicKey, encryptAndHash(symmetric, claimed), random(16))
}

function responderFor(roster: KeyPair[]): ReturnType<typeof createResponderSession> {
  return createResponderSession({
    staticPrivateKey: bob.privateKey,
    isAuthorisedPeer: rosterOf(roster.map((member) => member.publicKey)),
    random: seededRandom('oracle-responder')
  })
}

function refusalFor(claimed: Uint8Array, seed: string): string {
  try {
    responderFor([alice]).readHandshakeMessage(forgeFirstMessage(claimed, seed))
  } catch (error) {
    if (isPeerError(error)) return error.code
    throw error
  }
  throw new Error('the responder accepted a message nobody could have written')
}

describe('a stranger probing the roster with a static key it does not own', () => {
  it('is refused with the same error whether the key it claimed is on the roster or not', () => {
    expect(refusalFor(alice.publicKey, 'probe')).toBe(refusalFor(stranger.publicKey, 'probe'))
  })

  it('is refused for the reason that is actually true: the message did not authenticate', () => {
    // Not `unknown_peer`. The responder never gets far enough to have an
    // opinion about the roster, because nothing in the message was written by
    // the key it names.
    expect(refusalFor(alice.publicKey, 'probe')).toBe('decryption_failed')
  })

  it('never reaches the roster at all, so no roster lookup can be timed', () => {
    const asked: string[] = []
    const responder = createResponderSession({
      staticPrivateKey: bob.privateKey,
      isAuthorisedPeer: (candidate) => {
        asked.push(Buffer.from(candidate).toString('hex'))
        return true
      },
      random: seededRandom('oracle-responder')
    })
    expect(() => responder.readHandshakeMessage(forgeFirstMessage(alice.publicKey, 'probe'))).toThrow()
    expect(asked).toEqual([])
  })

  it('costs the responder the same Diffie-Hellman and AEAD work either way', async () => {
    // The timing channel was one X25519 and one AEAD opening: an on-roster
    // claim went on to `ss` and the payload, an off-roster one was cut short.
    // Counting the primitives is the deterministic form of that measurement.
    const counts = { dh: 0, aeadDecrypt: 0, aeadEncrypt: 0 }
    vi.doMock('./primitives', async () => {
      const actual = await vi.importActual<typeof import('./primitives')>('./primitives')
      return {
        ...actual,
        dh: (privateKey: Uint8Array, publicKey: Uint8Array) => {
          counts.dh += 1
          return actual.dh(privateKey, publicKey)
        },
        aeadDecrypt: (k: Uint8Array, n: bigint, ad: Uint8Array, ciphertext: Uint8Array) => {
          counts.aeadDecrypt += 1
          return actual.aeadDecrypt(k, n, ad, ciphertext)
        },
        aeadEncrypt: (k: Uint8Array, n: bigint, ad: Uint8Array, plaintext: Uint8Array) => {
          counts.aeadEncrypt += 1
          return actual.aeadEncrypt(k, n, ad, plaintext)
        }
      }
    })
    vi.resetModules()
    const counted = await import('./session')

    const spend = (claimed: Uint8Array): typeof counts => {
      const responder = counted.createResponderSession({
        staticPrivateKey: bob.privateKey,
        isAuthorisedPeer: counted.rosterOf([alice.publicKey]),
        random: seededRandom('oracle-responder')
      })
      const message = forgeFirstMessage(claimed, 'probe')
      counts.dh = 0
      counts.aeadDecrypt = 0
      counts.aeadEncrypt = 0
      expect(() => responder.readHandshakeMessage(message)).toThrow()
      return { ...counts }
    }

    const onRoster = spend(alice.publicKey)
    const offRoster = spend(stranger.publicKey)
    expect(onRoster).toEqual(offRoster)
    // And it is the whole of message one's work, not an early exit that
    // happens to be symmetric: es and ss, the static and the payload.
    expect(onRoster).toEqual({ dh: 2, aeadDecrypt: 2, aeadEncrypt: 0 })

    vi.doUnmock('./primitives')
    vi.resetModules()
  })
})
