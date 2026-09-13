// What this session must refuse, and what it must not leak.
//
// `noiseVectors.test.ts` proves the handshake computes the right bytes. This
// file proves the object around it fails in the right direction: an unknown
// peer, a replay, a reorder, a truncation, a flipped bit, an over-long frame and
// a call made at the wrong moment must each end in a typed error with the
// session unusable afterwards, and none of them may put key material anywhere a
// human or a log file could read it.

import { readFileSync } from 'node:fs'
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { isPeerError, PeerError, PeerErrorCode } from './errors'
import { decryptWithAd, encryptWithAd, initializeKey } from './noise'
import { DH_LEN, derivePublicKey, hash, MAX_NONCE } from './primitives'
import {
  createInitiatorSession,
  createResponderSession,
  generateStaticKeyPair,
  MAX_PLAINTEXT_LEN,
  type PeerSession,
  PROTOCOL_NAME,
  rosterOf
} from './session'

/**
 * Deterministic randomness so a failing test is the same failing test tomorrow.
 * Counter-hashed rather than a fixed buffer, so successive calls differ the way
 * real ephemerals do.
 */
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

const alice = generateStaticKeyPair(seededRandom('alice-static'))
const bob = generateStaticKeyPair(seededRandom('bob-static'))
const mallory = generateStaticKeyPair(seededRandom('mallory-static'))

const text = (value: string): Uint8Array => new TextEncoder().encode(value)
const read = (value: Uint8Array): string => new TextDecoder().decode(value)

type PairOptions = {
  initiatorStatic?: Uint8Array
  responderStatic?: Uint8Array
  initiatorBelievesResponderIs?: Uint8Array
  roster?: Uint8Array[]
  initiatorPrologue?: Uint8Array
  responderPrologue?: Uint8Array
  seed?: string
}

function pair(options: PairOptions = {}): { initiator: PeerSession; responder: PeerSession } {
  const initiatorStatic = options.initiatorStatic ?? alice.privateKey
  const responderStatic = options.responderStatic ?? bob.privateKey
  const seed = options.seed ?? 'pair'
  return {
    initiator: createInitiatorSession({
      staticPrivateKey: initiatorStatic,
      remoteStaticPublicKey: options.initiatorBelievesResponderIs ?? derivePublicKey(responderStatic),
      prologue: options.initiatorPrologue,
      random: seededRandom(`${seed}:initiator`)
    }),
    responder: createResponderSession({
      staticPrivateKey: responderStatic,
      isAuthorisedPeer: rosterOf(options.roster ?? [derivePublicKey(initiatorStatic)]),
      prologue: options.responderPrologue,
      random: seededRandom(`${seed}:responder`)
    })
  }
}

function handshake(options: PairOptions = {}): { initiator: PeerSession; responder: PeerSession } {
  const sessions = pair(options)
  sessions.responder.readHandshakeMessage(sessions.initiator.writeHandshakeMessage())
  sessions.initiator.readHandshakeMessage(sessions.responder.writeHandshakeMessage())
  return sessions
}

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (isPeerError(error)) return error.code
    throw error
  }
  throw new Error('expected the call to throw, and it returned')
}

describe('a completed IK handshake', () => {
  it('names the protocol it actually implements', () => {
    expect(PROTOCOL_NAME).toBe('Noise_IK_25519_ChaChaPoly_SHA256')
  })

  it('leaves both sides established and agreed on the transcript', () => {
    const { initiator, responder } = handshake()
    expect(initiator.stage).toBe('established')
    expect(responder.stage).toBe('established')
    expect(Buffer.from(initiator.handshakeHash())).toEqual(Buffer.from(responder.handshakeHash()))
    expect(initiator.handshakeHash()).toHaveLength(32)
  })

  it('tells each side which peer it actually authenticated', () => {
    const { initiator, responder } = handshake()
    expect(Buffer.from(initiator.remoteStaticPublicKey())).toEqual(Buffer.from(bob.publicKey))
    expect(Buffer.from(responder.remoteStaticPublicKey())).toEqual(Buffer.from(alice.publicKey))
  })

  it('carries traffic in both directions', () => {
    const { initiator, responder } = handshake()
    expect(read(responder.decrypt(initiator.encrypt(text('worktree list'))))).toBe('worktree list')
    expect(read(initiator.decrypt(responder.encrypt(text('three panes'))))).toBe('three panes')
  })

  it('carries payloads inside the handshake messages themselves', () => {
    const sessions = pair()
    const first = sessions.initiator.writeHandshakeMessage(text('hello from the initiator'))
    expect(read(sessions.responder.readHandshakeMessage(first))).toBe('hello from the initiator')
    const second = sessions.responder.writeHandshakeMessage(text('hello back'))
    expect(read(sessions.initiator.readHandshakeMessage(second))).toBe('hello back')
  })

  it('reads and writes byte ranges that sit inside a larger buffer', () => {
    // Anything reading from a socket hands over a view into a shared read
    // buffer, not a freshly allocated array. Ignoring `byteOffset` anywhere
    // would encrypt or authenticate the wrong bytes.
    const sessions = pair()
    const backing = new Uint8Array(128).fill(0xaa)
    const payload = backing.subarray(37, 60)
    payload.set(text('inside a bigger buffer'))

    const first = sessions.initiator.writeHandshakeMessage(payload)
    const relayed = new Uint8Array(first.length + 7)
    relayed.set(first, 7)
    expect(Buffer.from(sessions.responder.readHandshakeMessage(relayed.subarray(7)))).toEqual(Buffer.from(payload))
    sessions.initiator.readHandshakeMessage(sessions.responder.writeHandshakeMessage())

    const ciphertext = sessions.initiator.encrypt(payload)
    const framed = new Uint8Array(ciphertext.length + 13)
    framed.set(ciphertext, 13)
    expect(Buffer.from(sessions.responder.decrypt(framed.subarray(13)))).toEqual(Buffer.from(payload))
  })

  it('produces the same bytes twice from the same injected randomness', () => {
    const first = pair({ seed: 'pinned' }).initiator.writeHandshakeMessage(text('x'))
    const second = pair({ seed: 'pinned' }).initiator.writeHandshakeMessage(text('x'))
    expect(Buffer.from(first)).toEqual(Buffer.from(second))
  })

  it('produces different bytes from different randomness, so ephemerals are really ephemeral', () => {
    const first = pair({ seed: 'one' }).initiator.writeHandshakeMessage(text('x'))
    const second = pair({ seed: 'two' }).initiator.writeHandshakeMessage(text('x'))
    expect(Buffer.from(first)).not.toEqual(Buffer.from(second))
  })

  it('gives the two directions independent keys, so a message cannot be reflected', () => {
    const { initiator } = handshake()
    const outbound = initiator.encrypt(text('typed into your pane'))
    // Handing the initiator its own ciphertext is what a relay echoing frames
    // back would produce.
    expect(codeOf(() => initiator.decrypt(outbound))).toBe(PeerErrorCode.DecryptionFailed)
  })
})

describe('the published IK vector, driven through the public API', () => {
  // `noiseVectors.test.ts` checks the engine. This checks that the session
  // wrapper uses it correctly — the right role, the right turn order, and the
  // right one of the two transport keys for each direction. A session that
  // reproduced the specification's bytes through a mis-wired wrapper would pass
  // there and fail here.
  const vector = (
    JSON.parse(readFileSync(new URL('./noiseVectors.json', import.meta.url), 'utf8')) as {
      vectors: {
        protocol_name: string
        init_prologue: string
        init_static: string
        init_ephemeral: string
        resp_static: string
        resp_ephemeral: string
        handshake_hash: string
        messages: { payload: string; ciphertext: string }[]
      }[]
    }
  ).vectors.find((entry) => entry.protocol_name === PROTOCOL_NAME)

  it('is present in the corpus', () => {
    expect(vector).toBeDefined()
  })

  it('reproduces every message of the vector, handshake and transport alike', () => {
    if (!vector) throw new Error('the IK vector is missing from the corpus')
    const fromHex = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'hex'))
    const toHex = (value: Uint8Array): string => Buffer.from(value).toString('hex')
    const once = (value: string): (() => Uint8Array) => {
      let issued = false
      return () => {
        if (issued) throw new Error('IK should need exactly one ephemeral per side')
        issued = true
        return fromHex(value)
      }
    }

    const initiatorStatic = fromHex(vector.init_static)
    const responderStatic = fromHex(vector.resp_static)
    const initiator = createInitiatorSession({
      staticPrivateKey: initiatorStatic,
      remoteStaticPublicKey: derivePublicKey(responderStatic),
      prologue: fromHex(vector.init_prologue),
      random: once(vector.init_ephemeral)
    })
    const responder = createResponderSession({
      staticPrivateKey: responderStatic,
      isAuthorisedPeer: rosterOf([derivePublicKey(initiatorStatic)]),
      prologue: fromHex(vector.init_prologue),
      random: once(vector.resp_ephemeral)
    })

    const [first, second, ...transport] = vector.messages
    if (!first || !second) throw new Error('the IK vector is malformed')

    expect(toHex(initiator.writeHandshakeMessage(fromHex(first.payload)))).toBe(first.ciphertext)
    expect(toHex(responder.readHandshakeMessage(fromHex(first.ciphertext)))).toBe(first.payload)
    expect(toHex(responder.writeHandshakeMessage(fromHex(second.payload)))).toBe(second.ciphertext)
    expect(toHex(initiator.readHandshakeMessage(fromHex(second.ciphertext)))).toBe(second.payload)

    expect(toHex(initiator.handshakeHash())).toBe(vector.handshake_hash)
    expect(toHex(responder.handshakeHash())).toBe(vector.handshake_hash)

    transport.forEach((message, index) => {
      const fromInitiator = index % 2 === 0
      const sender = fromInitiator ? initiator : responder
      const receiver = fromInitiator ? responder : initiator
      expect(toHex(sender.encrypt(fromHex(message.payload)))).toBe(message.ciphertext)
      expect(toHex(receiver.decrypt(fromHex(message.ciphertext)))).toBe(message.payload)
    })
    expect(transport.length).toBeGreaterThan(0)
  })
})

describe('authenticating the peer, which is the whole point of IK', () => {
  it('refuses an initiator whose static key is not the one we expected', () => {
    const sessions = pair({ initiatorStatic: mallory.privateKey, roster: [alice.publicKey] })
    const forged = sessions.initiator.writeHandshakeMessage()
    expect(codeOf(() => sessions.responder.readHandshakeMessage(forged))).toBe(PeerErrorCode.UnknownPeer)
  })

  it('sends nothing back to an initiator it refused', () => {
    const sessions = pair({ initiatorStatic: mallory.privateKey, roster: [alice.publicKey] })
    expect(codeOf(() => sessions.responder.readHandshakeMessage(sessions.initiator.writeHandshakeMessage()))).toBe(
      PeerErrorCode.UnknownPeer
    )
    expect(sessions.responder.stage).toBe('closed')
    expect(codeOf(() => sessions.responder.writeHandshakeMessage())).toBe(PeerErrorCode.SessionClosed)
  })

  it('accepts any key the roster vouches for, not only the first', () => {
    const sessions = pair({
      initiatorStatic: mallory.privateKey,
      roster: [alice.publicKey, mallory.publicKey]
    })
    sessions.responder.readHandshakeMessage(sessions.initiator.writeHandshakeMessage())
    sessions.initiator.readHandshakeMessage(sessions.responder.writeHandshakeMessage())
    expect(Buffer.from(sessions.responder.remoteStaticPublicKey())).toEqual(Buffer.from(mallory.publicKey))
  })

  it('refuses an initiator that addressed its first message to a different responder', () => {
    // The initiator was told bob's key but is in fact talking to mallory's
    // machine: mallory cannot decrypt a message sealed to bob.
    const sessions = pair({
      responderStatic: mallory.privateKey,
      initiatorBelievesResponderIs: bob.publicKey,
      roster: [alice.publicKey]
    })
    expect(codeOf(() => sessions.responder.readHandshakeMessage(sessions.initiator.writeHandshakeMessage()))).toBe(
      PeerErrorCode.DecryptionFailed
    )
  })

  it('refuses a peer that disagrees about the prologue', () => {
    const sessions = pair({ initiatorPrologue: text('project-a'), responderPrologue: text('project-b') })
    expect(codeOf(() => sessions.responder.readHandshakeMessage(sessions.initiator.writeHandshakeMessage()))).toBe(
      PeerErrorCode.DecryptionFailed
    )
  })

  it('rejects key material of the wrong length rather than padding it', () => {
    expect(
      codeOf(() =>
        createInitiatorSession({
          staticPrivateKey: new Uint8Array(DH_LEN - 1),
          remoteStaticPublicKey: bob.publicKey
        })
      )
    ).toBe(PeerErrorCode.InvalidKey)
    expect(
      codeOf(() =>
        createInitiatorSession({
          staticPrivateKey: alice.privateKey,
          remoteStaticPublicKey: new Uint8Array(DH_LEN + 1)
        })
      )
    ).toBe(PeerErrorCode.InvalidKey)
  })

  it('rejects a responder key that is not a usable curve point', () => {
    const sessions = pair({ initiatorBelievesResponderIs: new Uint8Array(DH_LEN) })
    // An all-zero public key is a low-order point; the DH must not quietly
    // produce an all-zero shared secret.
    expect(codeOf(() => sessions.initiator.writeHandshakeMessage())).toBe(PeerErrorCode.InvalidKey)
    expect(sessions.initiator.stage).toBe('closed')
  })

  it('keeps two different pairings mutually unintelligible', () => {
    const first = handshake({ seed: 'first' })
    const second = handshake({ seed: 'second' })
    const ciphertext = first.initiator.encrypt(text('not for you'))
    expect(codeOf(() => second.responder.decrypt(ciphertext))).toBe(PeerErrorCode.DecryptionFailed)
  })
})

describe('hostile or damaged transport messages', () => {
  it('refuses a replayed transport message', () => {
    const { initiator, responder } = handshake()
    const message = initiator.encrypt(text('once'))
    expect(read(responder.decrypt(message))).toBe('once')
    expect(codeOf(() => responder.decrypt(message))).toBe(PeerErrorCode.DecryptionFailed)
  })

  it('refuses transport messages delivered out of order', () => {
    const { initiator, responder } = handshake()
    const first = initiator.encrypt(text('first'))
    const second = initiator.encrypt(text('second'))
    expect(codeOf(() => responder.decrypt(second))).toBe(PeerErrorCode.DecryptionFailed)
    // And the session is gone, so the message it skipped is no use either.
    expect(codeOf(() => responder.decrypt(first))).toBe(PeerErrorCode.SessionClosed)
  })

  it('refuses a truncated transport message at every truncation point', () => {
    const plaintext = text('a reasonable line of terminal output')
    for (let cut = 0; cut < plaintext.length + 16; cut += 1) {
      const { initiator, responder } = handshake()
      const message = initiator.encrypt(plaintext)
      expect(codeOf(() => responder.decrypt(message.subarray(0, cut)))).toBe(PeerErrorCode.DecryptionFailed)
    }
  })

  it('refuses a transport message with a single flipped bit anywhere in it', () => {
    const plaintext = text('mute this pane')
    for (let index = 0; index < plaintext.length + 16; index += 1) {
      for (const bit of [0x01, 0x80]) {
        const { initiator, responder } = handshake()
        const message = initiator.encrypt(plaintext)
        const tampered = new Uint8Array(message)
        tampered[index] = (tampered[index] ?? 0) ^ bit
        expect(codeOf(() => responder.decrypt(tampered))).toBe(PeerErrorCode.DecryptionFailed)
      }
    }
  })

  it('refuses a transport message with bytes appended to it', () => {
    const { initiator, responder } = handshake()
    const message = initiator.encrypt(text('padded'))
    const extended = new Uint8Array(message.length + 1)
    extended.set(message)
    expect(codeOf(() => responder.decrypt(extended))).toBe(PeerErrorCode.DecryptionFailed)
  })

  it('refuses a transport message longer than Noise permits without trying to decrypt it', () => {
    const { responder } = handshake()
    expect(codeOf(() => responder.decrypt(new Uint8Array(65536)))).toBe(PeerErrorCode.MessageTooLong)
    expect(responder.stage).toBe('closed')
  })

  it('carries a plaintext of the largest permitted size, and refuses one byte more', () => {
    const { initiator, responder } = handshake()
    const biggest = new Uint8Array(MAX_PLAINTEXT_LEN).fill(0x61)
    expect(responder.decrypt(initiator.encrypt(biggest))).toHaveLength(MAX_PLAINTEXT_LEN)
    expect(codeOf(() => initiator.encrypt(new Uint8Array(MAX_PLAINTEXT_LEN + 1)))).toBe(PeerErrorCode.MessageTooLong)
    // Refusing our own over-long plaintext consumed nothing, so the session
    // still works. Only wire failures are fatal.
    expect(initiator.stage).toBe('established')
    expect(read(responder.decrypt(initiator.encrypt(text('still fine'))))).toBe('still fine')
  })

  it('authenticates each transport message independently of the ones before it', () => {
    const { initiator, responder } = handshake()
    expect(read(responder.decrypt(initiator.encrypt(text('one'))))).toBe('one')
    const second = initiator.encrypt(text('two'))
    const tampered = new Uint8Array(second)
    tampered[0] = (tampered[0] ?? 0) ^ 0xff
    expect(codeOf(() => responder.decrypt(tampered))).toBe(PeerErrorCode.DecryptionFailed)
  })
})

describe('hostile or damaged handshake messages', () => {
  it('refuses a handshake message longer than Noise permits', () => {
    const sessions = pair()
    expect(codeOf(() => sessions.responder.readHandshakeMessage(new Uint8Array(65536)))).toBe(
      PeerErrorCode.MessageTooLong
    )
  })

  it('refuses a handshake message too short to hold its own tokens', () => {
    const sessions = pair()
    const first = sessions.initiator.writeHandshakeMessage()
    expect(codeOf(() => sessions.responder.readHandshakeMessage(first.subarray(0, 10)))).toBe(PeerErrorCode.Truncated)
  })

  it('refuses a handshake message with a flipped bit anywhere in it', () => {
    const template = pair().initiator.writeHandshakeMessage(text('hi'))
    for (let index = 0; index < template.length; index += 1) {
      const sessions = pair()
      const first = sessions.initiator.writeHandshakeMessage(text('hi'))
      const tampered = new Uint8Array(first)
      tampered[index] = (tampered[index] ?? 0) ^ 0x40
      const code = codeOf(() => sessions.responder.readHandshakeMessage(tampered))
      // A flipped bit in the ephemeral changes which key the static was sealed
      // to, so it can surface as either a failed decryption or an unusable
      // point. Both refuse; neither continues.
      expect([PeerErrorCode.DecryptionFailed, PeerErrorCode.InvalidKey, PeerErrorCode.UnknownPeer]).toContain(code)
      expect(sessions.responder.stage).toBe('closed')
    }
  })

  it('refuses a second copy of the first handshake message on the same session', () => {
    const sessions = pair()
    const first = sessions.initiator.writeHandshakeMessage()
    sessions.responder.readHandshakeMessage(first)
    expect(codeOf(() => sessions.responder.readHandshakeMessage(first))).toBe(PeerErrorCode.OutOfTurn)
  })

  it('does not pretend to stop a first handshake message replayed to a fresh responder', () => {
    // IK has no anti-replay on its first message and cannot have one: the
    // responder has no state yet. A fresh responder will accept a recorded
    // message one and its payload. What the attacker cannot do is finish —
    // it has no initiator ephemeral private key — so the session never carries
    // traffic. Callers must therefore treat a message-one payload as
    // potentially old, and never as a command.
    const recorded = pair({ seed: 'recorded' }).initiator.writeHandshakeMessage(text('replayable'))
    const fresh = pair({ seed: 'fresh' }).responder
    expect(read(fresh.readHandshakeMessage(recorded))).toBe('replayable')
    expect(fresh.stage).toBe('handshake')
  })
})

describe('calls made at the wrong moment', () => {
  it('refuses transport traffic before the handshake has completed', () => {
    const sessions = pair()
    expect(codeOf(() => sessions.initiator.encrypt(text('too early')))).toBe(PeerErrorCode.OutOfTurn)
    expect(codeOf(() => sessions.initiator.decrypt(new Uint8Array(17)))).toBe(PeerErrorCode.OutOfTurn)
    sessions.responder.readHandshakeMessage(sessions.initiator.writeHandshakeMessage())
    expect(codeOf(() => sessions.initiator.encrypt(text('still too early')))).toBe(PeerErrorCode.OutOfTurn)
  })

  it('refuses to answer out of turn on either side', () => {
    const sessions = pair()
    expect(sessions.initiator.expectsHandshakeWrite).toBe(true)
    expect(sessions.responder.expectsHandshakeRead).toBe(true)
    expect(codeOf(() => sessions.responder.writeHandshakeMessage())).toBe(PeerErrorCode.OutOfTurn)
    const first = sessions.initiator.writeHandshakeMessage()
    expect(codeOf(() => sessions.initiator.writeHandshakeMessage())).toBe(PeerErrorCode.OutOfTurn)
    sessions.responder.readHandshakeMessage(first)
    expect(codeOf(() => sessions.responder.readHandshakeMessage(first))).toBe(PeerErrorCode.OutOfTurn)
  })

  it('refuses handshake calls once the handshake is done', () => {
    const { initiator, responder } = handshake()
    expect(initiator.expectsHandshakeWrite).toBe(false)
    expect(initiator.expectsHandshakeRead).toBe(false)
    expect(codeOf(() => initiator.writeHandshakeMessage())).toBe(PeerErrorCode.OutOfTurn)
    expect(codeOf(() => responder.readHandshakeMessage(new Uint8Array(48)))).toBe(PeerErrorCode.OutOfTurn)
  })

  it('refuses to reveal a peer key or transcript before either is authenticated', () => {
    const sessions = pair()
    expect(codeOf(() => sessions.initiator.remoteStaticPublicKey())).toBe(PeerErrorCode.OutOfTurn)
    expect(codeOf(() => sessions.responder.handshakeHash())).toBe(PeerErrorCode.OutOfTurn)
  })

  it('refuses a handshake payload too long to fit the message', () => {
    const sessions = pair()
    expect(codeOf(() => sessions.initiator.writeHandshakeMessage(new Uint8Array(65536)))).toBe(
      PeerErrorCode.MessageTooLong
    )
    // Refused before anything was mixed, so the handshake still works.
    expect(sessions.initiator.stage).toBe('handshake')
    sessions.responder.readHandshakeMessage(sessions.initiator.writeHandshakeMessage())
    expect(sessions.responder.stage).toBe('handshake')
  })

  it('is dead after any failure that came off the wire', () => {
    const { initiator, responder } = handshake()
    const message = initiator.encrypt(text('once'))
    responder.decrypt(message)
    expect(codeOf(() => responder.decrypt(message))).toBe(PeerErrorCode.DecryptionFailed)
    expect(responder.stage).toBe('closed')
    expect(codeOf(() => responder.decrypt(message))).toBe(PeerErrorCode.SessionClosed)
    expect(codeOf(() => responder.encrypt(text('anything')))).toBe(PeerErrorCode.SessionClosed)
    expect(codeOf(() => responder.handshakeHash())).toBe(PeerErrorCode.SessionClosed)
    expect(codeOf(() => responder.remoteStaticPublicKey())).toBe(PeerErrorCode.SessionClosed)
  })

  it('is dead after close, and closing twice is not an error', () => {
    const { initiator } = handshake()
    initiator.close()
    initiator.close()
    expect(initiator.stage).toBe('closed')
    expect(codeOf(() => initiator.encrypt(text('anything')))).toBe(PeerErrorCode.SessionClosed)
  })

  it('hands out copies, so a caller cannot mutate the session through them', () => {
    const { initiator } = handshake()
    const key = initiator.remoteStaticPublicKey()
    key.fill(0)
    expect(Buffer.from(initiator.remoteStaticPublicKey())).toEqual(Buffer.from(bob.publicKey))
  })

  it('copies the caller key material it was given, so later reuse of that buffer is harmless', () => {
    const scratch = new Uint8Array(alice.privateKey)
    const session = createInitiatorSession({
      staticPrivateKey: scratch,
      remoteStaticPublicKey: bob.publicKey,
      random: seededRandom('copy-check')
    })
    scratch.fill(0)
    const responder = createResponderSession({
      staticPrivateKey: bob.privateKey,
      isAuthorisedPeer: rosterOf([alice.publicKey]),
      random: seededRandom('copy-check-responder')
    })
    responder.readHandshakeMessage(session.writeHandshakeMessage())
    session.readHandshakeMessage(responder.writeHandshakeMessage())
    expect(Buffer.from(responder.remoteStaticPublicKey())).toEqual(Buffer.from(alice.publicKey))
  })
})

describe('the nonce counter', () => {
  it('advances by exactly one per message, so the same plaintext never repeats a ciphertext', () => {
    const { initiator, responder } = handshake()
    const first = initiator.encrypt(text('same'))
    const second = initiator.encrypt(text('same'))
    expect(Buffer.from(first)).not.toEqual(Buffer.from(second))
    expect(read(responder.decrypt(first))).toBe('same')
    expect(read(responder.decrypt(second))).toBe('same')
  })

  it('refuses to encrypt once the nonce space is exhausted, rather than wrapping', () => {
    const cs = initializeKey(new Uint8Array(32).fill(9))
    cs.n = MAX_NONCE
    expect(codeOf(() => encryptWithAd(cs, new Uint8Array(0), text('over the edge')))).toBe(PeerErrorCode.NonceExhausted)
    // The counter did not move, so a retry cannot slip past the ceiling either.
    expect(cs.n).toBe(MAX_NONCE)
    expect(codeOf(() => encryptWithAd(cs, new Uint8Array(0), text('again')))).toBe(PeerErrorCode.NonceExhausted)
  })

  it('refuses to decrypt once the nonce space is exhausted', () => {
    const cs = initializeKey(new Uint8Array(32).fill(9))
    cs.n = MAX_NONCE
    expect(codeOf(() => decryptWithAd(cs, new Uint8Array(0), new Uint8Array(16)))).toBe(PeerErrorCode.NonceExhausted)
  })

  it('uses the last usable nonce and then stops', () => {
    const encrypting = initializeKey(new Uint8Array(32).fill(9))
    const decrypting = initializeKey(new Uint8Array(32).fill(9))
    encrypting.n = MAX_NONCE - 1n
    decrypting.n = MAX_NONCE - 1n
    const ciphertext = encryptWithAd(encrypting, new Uint8Array(0), text('last one'))
    expect(read(decryptWithAd(decrypting, new Uint8Array(0), ciphertext))).toBe('last one')
    expect(encrypting.n).toBe(MAX_NONCE)
    expect(codeOf(() => encryptWithAd(encrypting, new Uint8Array(0), text('one too many')))).toBe(
      PeerErrorCode.NonceExhausted
    )
  })
})

describe('secrecy of the things that must never be printed', () => {
  /** Every rendering of a value a careless log line or crash report might produce. */
  function renderings(value: unknown): string[] {
    const out = [inspect(value, { depth: null, showHidden: true }), String(value)]
    try {
      out.push(JSON.stringify(value) ?? '')
    } catch {
      out.push('')
    }
    if (value instanceof Error) {
      out.push(value.message, value.stack ?? '', JSON.stringify(Object.getOwnPropertyNames(value)))
    }
    return out
  }

  /** The same bytes in the three encodings a log line is likely to use. */
  function encodings(secret: Uint8Array): string[] {
    const buffer = Buffer.from(secret)
    return [buffer.toString('hex'), buffer.toString('hex').toUpperCase(), buffer.toString('base64')]
  }

  const secrets = [alice.privateKey, bob.privateKey, mallory.privateKey]

  function expectNoSecrets(value: unknown): void {
    for (const rendering of renderings(value)) {
      for (const secret of secrets) {
        for (const encoded of encodings(secret)) {
          expect(rendering).not.toContain(encoded)
        }
      }
    }
  }

  it('keeps key material out of every error this library can throw', () => {
    const failures: (() => unknown)[] = [
      () => createInitiatorSession({ staticPrivateKey: new Uint8Array(3), remoteStaticPublicKey: bob.publicKey }),
      () => pair({ initiatorBelievesResponderIs: new Uint8Array(DH_LEN) }).initiator.writeHandshakeMessage(),
      () => {
        const s = pair({ initiatorStatic: mallory.privateKey, roster: [alice.publicKey] })
        s.responder.readHandshakeMessage(s.initiator.writeHandshakeMessage())
      },
      () => {
        const s = pair()
        s.responder.readHandshakeMessage(s.initiator.writeHandshakeMessage().subarray(0, 8))
      },
      () => {
        const s = pair()
        const first = s.initiator.writeHandshakeMessage()
        first[0] = (first[0] ?? 0) ^ 0xff
        s.responder.readHandshakeMessage(first)
      },
      () => {
        const s = handshake()
        const message = s.initiator.encrypt(text('once'))
        s.responder.decrypt(message)
        s.responder.decrypt(message)
      },
      () => handshake().initiator.encrypt(new Uint8Array(MAX_PLAINTEXT_LEN + 1)),
      () => handshake().responder.decrypt(new Uint8Array(65536)),
      () => pair().initiator.encrypt(text('too early')),
      () => {
        const cs = initializeKey(new Uint8Array(32).fill(7))
        cs.n = MAX_NONCE
        encryptWithAd(cs, new Uint8Array(0), text('x'))
      }
    ]

    let thrown = 0
    for (const failure of failures) {
      try {
        failure()
      } catch (error) {
        thrown += 1
        expect(isPeerError(error)).toBe(true)
        expectNoSecrets(error)
        // The nonce must not travel either; it is the other half of a
        // catastrophic AEAD failure.
        expect((error as PeerError).message).not.toMatch(/nonce\s*[:=]?\s*\d/i)
      }
    }
    expect(thrown).toBe(failures.length)
  })

  it('has nothing secret to print when the session object itself is logged', () => {
    const { initiator, responder } = handshake()
    initiator.encrypt(text('some traffic'))
    for (const session of [initiator, responder]) {
      expectNoSecrets(session)
      // Transport keys are derived, so check the rendering names no byte blobs
      // at all rather than only the statics we happen to know.
      const rendering = inspect(session, { depth: null, showHidden: true })
      expect(rendering).not.toMatch(/Uint8Array|Buffer|\bk\b\s*:/)
    }
  })

  it('gives every error code a message that cannot have been built from a value', () => {
    for (const code of Object.values(PeerErrorCode)) {
      const error = new PeerError(code)
      expect(error.code).toBe(code)
      // Same code, same text, every time: nothing was interpolated in.
      expect(new PeerError(code).message).toBe(error.message)
      expect(error.message).not.toMatch(/[0-9a-f]{16,}/i)
      expect(error.message.length).toBeGreaterThan(0)
    }
  })
})
