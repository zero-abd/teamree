// Verification against something other than ourselves.
//
// `noiseVectors.json` is the subset of the Noise project's published test
// vectors that uses this library's cipher suite — every non-PSK
// `*_25519_ChaChaPoly_SHA256` entry from the `cacophony` vector file, which is
// the corpus the Noise specification's own wiki points implementations at and
// which several unrelated implementations are validated against. The vectors fix
// both sides' static and ephemeral keys, so a passing run means our bytes match
// theirs exactly: the same protocol-name padding, the same pre-message hash
// order, the same HKDF, the same little-endian ChaChaPoly nonce, the same
// transcript hash, and the same two transport keys out of Split().
//
// Only `IK` is exported by this library. The other patterns are here as data
// because they drive the same engine through token orders `IK` never reaches —
// every pre-message combination, one-way and three-message handshakes, and the
// deferred variants where a static-key DH lands a message later than usual.
// A break in the shared machinery shows up in thirty-eight places instead of one.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  type CipherState,
  decryptWithAd,
  encryptWithAd,
  handshakeHash,
  type HandshakePattern,
  type HandshakeState,
  initializeHandshake,
  readMessage,
  type TransportKeys,
  writeMessage
} from './noise'
import { derivePublicKey, type RandomSource } from './primitives'

type Vector = {
  protocol_name: string
  init_prologue: string
  init_static?: string
  init_ephemeral: string
  init_remote_static?: string
  resp_prologue: string
  resp_static?: string
  resp_ephemeral: string
  resp_remote_static?: string
  handshake_hash: string
  messages: { payload: string; ciphertext: string }[]
}

const CORPUS = JSON.parse(readFileSync(new URL('./noiseVectors.json', import.meta.url), 'utf8')) as {
  source: string
  vectors: Vector[]
}

const bytes = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, 'hex'))
const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex')

const EMPTY = new Uint8Array(0)

/**
 * Every handshake pattern the corpus covers, transcribed from the Noise
 * specification (sections 7.5 and 7.6). Wrong transcription cannot pass
 * silently: the vector for that pattern stops matching.
 */
const PATTERNS: Record<string, Omit<HandshakePattern, 'name'>> = {
  // One-way patterns (spec 7.4).
  N: { initiatorPreMessage: [], responderPreMessage: ['s'], messages: [['e', 'es']] },
  K: { initiatorPreMessage: ['s'], responderPreMessage: ['s'], messages: [['e', 'es', 'ss']] },
  X: { initiatorPreMessage: [], responderPreMessage: ['s'], messages: [['e', 'es', 's', 'ss']] },

  // Interactive fundamental patterns (spec 7.5).
  NN: { initiatorPreMessage: [], responderPreMessage: [], messages: [['e'], ['e', 'ee']] },
  NK: {
    initiatorPreMessage: [],
    responderPreMessage: ['s'],
    messages: [
      ['e', 'es'],
      ['e', 'ee']
    ]
  },
  NX: { initiatorPreMessage: [], responderPreMessage: [], messages: [['e'], ['e', 'ee', 's', 'es']] },
  KN: { initiatorPreMessage: ['s'], responderPreMessage: [], messages: [['e'], ['e', 'ee', 'se']] },
  KK: {
    initiatorPreMessage: ['s'],
    responderPreMessage: ['s'],
    messages: [
      ['e', 'es', 'ss'],
      ['e', 'ee', 'se']
    ]
  },
  KX: { initiatorPreMessage: ['s'], responderPreMessage: [], messages: [['e'], ['e', 'ee', 'se', 's', 'es']] },
  XN: { initiatorPreMessage: [], responderPreMessage: [], messages: [['e'], ['e', 'ee'], ['s', 'se']] },
  XK: {
    initiatorPreMessage: [],
    responderPreMessage: ['s'],
    messages: [
      ['e', 'es'],
      ['e', 'ee'],
      ['s', 'se']
    ]
  },
  XX: { initiatorPreMessage: [], responderPreMessage: [], messages: [['e'], ['e', 'ee', 's', 'es'], ['s', 'se']] },
  IN: {
    initiatorPreMessage: [],
    responderPreMessage: [],
    messages: [
      ['e', 's'],
      ['e', 'ee', 'se']
    ]
  },
  IK: {
    initiatorPreMessage: [],
    responderPreMessage: ['s'],
    messages: [
      ['e', 'es', 's', 'ss'],
      ['e', 'ee', 'se']
    ]
  },
  IX: {
    initiatorPreMessage: [],
    responderPreMessage: [],
    messages: [
      ['e', 's'],
      ['e', 'ee', 'se', 's', 'es']
    ]
  },

  // Deferred patterns (spec 7.6): the same tokens, one message later.
  NK1: { initiatorPreMessage: [], responderPreMessage: ['s'], messages: [['e'], ['e', 'ee', 'es']] },
  NX1: { initiatorPreMessage: [], responderPreMessage: [], messages: [['e'], ['e', 'ee', 's'], ['es']] },
  X1N: { initiatorPreMessage: [], responderPreMessage: [], messages: [['e'], ['e', 'ee'], ['s'], ['se']] },
  X1K: {
    initiatorPreMessage: [],
    responderPreMessage: ['s'],
    messages: [['e', 'es'], ['e', 'ee'], ['s'], ['se']]
  },
  XK1: { initiatorPreMessage: [], responderPreMessage: ['s'], messages: [['e'], ['e', 'ee', 'es'], ['s', 'se']] },
  X1K1: {
    initiatorPreMessage: [],
    responderPreMessage: ['s'],
    messages: [['e'], ['e', 'ee', 'es'], ['s'], ['se']]
  },
  X1X: {
    initiatorPreMessage: [],
    responderPreMessage: [],
    messages: [['e'], ['e', 'ee', 's', 'es'], ['s'], ['se']]
  },
  XX1: { initiatorPreMessage: [], responderPreMessage: [], messages: [['e'], ['e', 'ee', 's'], ['es', 's', 'se']] },
  X1X1: {
    initiatorPreMessage: [],
    responderPreMessage: [],
    messages: [['e'], ['e', 'ee', 's'], ['es', 's'], ['se']]
  },
  K1N: { initiatorPreMessage: ['s'], responderPreMessage: [], messages: [['e'], ['e', 'ee'], ['se']] },
  K1K: {
    initiatorPreMessage: ['s'],
    responderPreMessage: ['s'],
    messages: [['e', 'es'], ['e', 'ee'], ['se']]
  },
  KK1: { initiatorPreMessage: ['s'], responderPreMessage: ['s'], messages: [['e'], ['e', 'ee', 'se', 'es']] },
  K1K1: { initiatorPreMessage: ['s'], responderPreMessage: ['s'], messages: [['e'], ['e', 'ee', 'es'], ['se']] },
  K1X: { initiatorPreMessage: ['s'], responderPreMessage: [], messages: [['e'], ['e', 'ee', 's', 'es'], ['se']] },
  KX1: { initiatorPreMessage: ['s'], responderPreMessage: [], messages: [['e'], ['e', 'ee', 'se', 's'], ['es']] },
  K1X1: { initiatorPreMessage: ['s'], responderPreMessage: [], messages: [['e'], ['e', 'ee', 's'], ['se', 'es']] },
  I1N: { initiatorPreMessage: [], responderPreMessage: [], messages: [['e', 's'], ['e', 'ee'], ['se']] },
  I1K: {
    initiatorPreMessage: [],
    responderPreMessage: ['s'],
    messages: [['e', 'es', 's'], ['e', 'ee'], ['se']]
  },
  IK1: {
    initiatorPreMessage: [],
    responderPreMessage: ['s'],
    messages: [
      ['e', 's'],
      ['e', 'ee', 'se', 'es']
    ]
  },
  I1K1: { initiatorPreMessage: [], responderPreMessage: ['s'], messages: [['e', 's'], ['e', 'ee', 'es'], ['se']] },
  I1X: { initiatorPreMessage: [], responderPreMessage: [], messages: [['e', 's'], ['e', 'ee', 's', 'es'], ['se']] },
  IX1: { initiatorPreMessage: [], responderPreMessage: [], messages: [['e', 's'], ['e', 'ee', 'se', 's'], ['es']] },
  I1X1: {
    initiatorPreMessage: [],
    responderPreMessage: [],
    messages: [
      ['e', 's'],
      ['e', 'ee', 's'],
      ['se', 'es']
    ]
  }
}

/** Patterns with no responder-to-initiator direction: only the first transport key is used. */
const ONE_WAY = new Set(['N', 'K', 'X'])

function patternNameOf(vector: Vector): string {
  const name = vector.protocol_name.split('_')[1]
  if (!name) throw new Error('unreadable protocol name in the vector file')
  return name
}

/** Hands out the vector's fixed ephemeral, and complains if a pattern wants a second. */
function pinnedRandom(ephemeral: string): RandomSource {
  let issued = 0
  return () => {
    issued += 1
    if (issued > 1) throw new Error('this pattern needs more ephemerals than the vector supplies')
    return bytes(ephemeral)
  }
}

function handshakeFor(vector: Vector, pattern: HandshakePattern, initiator: boolean): HandshakeState {
  const privateKey = initiator ? vector.init_static : vector.resp_static
  const remote = initiator ? vector.init_remote_static : vector.resp_remote_static
  return initializeHandshake({
    pattern,
    initiator,
    prologue: bytes(initiator ? vector.init_prologue : vector.resp_prologue),
    staticKeyPair: privateKey ? { privateKey: bytes(privateKey), publicKey: derivePublicKey(bytes(privateKey)) } : null,
    remoteStaticPublicKey: remote ? bytes(remote) : null,
    random: pinnedRandom(initiator ? vector.init_ephemeral : vector.resp_ephemeral)
  })
}

describe(`Noise test vectors from ${CORPUS.source}`, () => {
  it('covers every pattern the corpus contains for this cipher suite', () => {
    const missing = CORPUS.vectors.map(patternNameOf).filter((name) => !PATTERNS[name])
    expect(missing).toEqual([])
    expect(CORPUS.vectors.length).toBeGreaterThanOrEqual(38)
  })

  for (const vector of CORPUS.vectors) {
    it(`reproduces ${vector.protocol_name} byte for byte on both sides`, () => {
      const name = patternNameOf(vector)
      const shape = PATTERNS[name]
      if (!shape) throw new Error('pattern missing from the table')
      const pattern: HandshakePattern = { name, ...shape }

      const initiator = handshakeFor(vector, pattern, true)
      const responder = handshakeFor(vector, pattern, false)
      const oneWay = ONE_WAY.has(name)

      let transport: { initiator: TransportKeys; responder: TransportKeys } | null = null

      vector.messages.forEach((message, index) => {
        const payload = bytes(message.payload)
        const fromInitiator = oneWay || index % 2 === 0

        if (!transport) {
          const sender = fromInitiator ? initiator : responder
          const receiver = fromInitiator ? responder : initiator
          const written = writeMessage(sender, payload)
          expect(hex(written.bytes)).toBe(message.ciphertext)

          const read = readMessage(receiver, bytes(message.ciphertext))
          expect(hex(read.bytes)).toBe(message.payload)

          if (written.transport && read.transport) {
            transport = fromInitiator
              ? { initiator: written.transport, responder: read.transport }
              : { initiator: read.transport, responder: written.transport }

            // Both sides must land on the same pair of keys and the same
            // transcript hash, or the channel binding means nothing.
            expect(hex(handshakeHash(initiator))).toBe(vector.handshake_hash)
            expect(hex(handshakeHash(responder))).toBe(vector.handshake_hash)
          }
          return
        }

        const keys: { send: CipherState; receive: CipherState } = fromInitiator
          ? {
              send: transport.initiator.initiatorToResponder,
              receive: transport.responder.initiatorToResponder
            }
          : {
              send: transport.responder.responderToInitiator,
              receive: transport.initiator.responderToInitiator
            }

        const ciphertext = encryptWithAd(keys.send, EMPTY, payload)
        expect(hex(ciphertext)).toBe(message.ciphertext)
        expect(hex(decryptWithAd(keys.receive, EMPTY, bytes(message.ciphertext)))).toBe(message.payload)
      })

      expect(transport).not.toBeNull()
    })
  }
})
