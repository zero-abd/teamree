// The public surface: one `Noise_IK_25519_ChaChaPoly_SHA256` session, as bytes
// in and bytes out.
//
// `IK` because each side already knows the other's static public key before it
// starts — the roster in `.teamree/members/` is exactly the "known in advance"
// that IK assumes. The initiator authenticates the responder by encrypting the
// first message to a key only that responder holds; the responder authenticates
// the initiator by the static key it decrypts out of that same message, which it
// checks against the roster before answering. Neither side ever sends its
// identity in the clear, so a relay that splices the two streams together learns
// only that two anonymous endpoints paired.
//
// This library does not frame. A Noise transport message is a bare ciphertext,
// and something underneath — a WebSocket, or the newline framing in
// `protocol.ts` — must preserve message boundaries. Handing `decrypt` two
// concatenated messages, or half of one, will fail, which is the correct
// outcome but not a substitute for framing.
//
// Three properties the tests pin, because they are what makes it hard to misuse:
//
//   * Every method checks the session's stage first, so calling them out of
//     order is a typed `PeerError`, never undefined behaviour.
//   * Any failure that came from the wire closes the session permanently. Noise
//     transport carries no nonce and has no replay window: a message that fails
//     to authenticate is indistinguishable from a message out of sequence, and
//     in both cases the stream can no longer be trusted or resynchronised.
//     Rejected *local* input — a plaintext that is too long — consumes nothing
//     and leaves the session usable.
//   * `established` is not the same thing as authenticated, and the API says so
//     rather than leaving it to a comment. Message one of IK is replayable by
//     anyone who recorded it, so a responder can reach `established` opposite
//     something that holds no private key at all. `confirmed` is the state that
//     means the peer proved possession of the static key it claimed, and it is
//     what gates `remoteStaticPublicKey()`. Message one carries no payload, so
//     there is nothing for a replay to deliver either.

import { PeerErrorCode, peerError } from './errors'
import {
  type CipherState,
  destroyHandshake,
  encryptWithAd,
  decryptWithAd,
  type HandshakePattern,
  type HandshakeState,
  handshakeHash as transcriptHash,
  initializeHandshake,
  protocolNameFor,
  readMessage,
  type TransportKeys,
  writeMessage
} from './noise'
import {
  DH_LEN,
  derivePublicKey,
  generateKeyPair,
  type KeyPair,
  MAX_MESSAGE_LEN,
  type RandomSource,
  systemRandom,
  TAG_LEN,
  equalBytes,
  wipe
} from './primitives'

/**
 *   IK:
 *     <- s
 *     ...
 *     -> e, es, s, ss
 *     <- e, ee, se
 */
const IK_PATTERN: HandshakePattern = {
  name: 'IK',
  initiatorPreMessage: [],
  responderPreMessage: ['s'],
  messages: [
    ['e', 'es', 's', 'ss'],
    ['e', 'ee', 'se']
  ]
}

export const PROTOCOL_NAME = protocolNameFor(IK_PATTERN)

/**
 * What each IK handshake message spends on tokens before the payload's own
 * tag: message one carries an ephemeral, an encrypted static and a tag;
 * message two carries an ephemeral and a tag. Kept here so an over-long payload
 * is refused before the handshake state has been touched.
 *
 * Message one's budget is not an invitation: see `FIRST_MESSAGE`, which allows
 * it no payload at all.
 */
const HANDSHAKE_OVERHEAD: readonly number[] = [DH_LEN + (DH_LEN + TAG_LEN) + TAG_LEN, DH_LEN + TAG_LEN]

/**
 * IK's first message is replayable and cannot be otherwise: the responder has
 * no state yet with which to recognise a repeat, so a recorded message one
 * replayed by anyone — a relay, above all, which holds both the frame and the
 * rendezvous that delivers it — is accepted again, payload and all. So this
 * library carries nothing there. Message two and every transport message after
 * it are bound to a live ephemeral and can say whatever the caller wants.
 */
const FIRST_MESSAGE = 0

/** The largest plaintext a single transport message can carry. */
export const MAX_PLAINTEXT_LEN = MAX_MESSAGE_LEN - TAG_LEN

export type PeerRole = 'initiator' | 'responder'

export type SessionStage = 'handshake' | 'established' | 'closed'

export type InitiatorOptions = {
  /** Our own X25519 private key. The public half is derived, never supplied. */
  readonly staticPrivateKey: Uint8Array
  /** The peer's static public key, from the repository roster. */
  readonly remoteStaticPublicKey: Uint8Array
  /** Bound into the transcript; both sides must agree byte for byte. */
  readonly prologue?: Uint8Array
  readonly random?: RandomSource
}

export type ResponderOptions = {
  readonly staticPrivateKey: Uint8Array
  /**
   * The roster check, run against the initiator's static key once the whole of
   * its first message has been processed and before anything is sent back.
   * Returning false aborts the handshake with `unknown_peer`. It deliberately
   * does not run the moment that key is decrypted; `noise.ts` says why, and the
   * short version is that deciding earlier would tell a stranger who is on the
   * roster by how long we took to refuse it.
   *
   * Being on the roster is not yet proof of anything: the key arrived in a
   * message a replayer could have recorded. `confirmed` is what turns a claimed
   * identity into a proved one.
   *
   * Note for whatever puts this on a socket: `unknown_peer` and
   * `decryption_failed` are distinguishable here on purpose, because the local
   * operator wants to know which happened. Do not relay that distinction to the
   * peer. Locally it is a diagnostic; on the wire it is an oracle that tells a
   * caller whether it failed because it is not a member or because it dialled
   * the wrong machine. Drop the connection the same way for both.
   */
  readonly isAuthorisedPeer: (staticPublicKey: Uint8Array) => boolean
  readonly prologue?: Uint8Array
  readonly random?: RandomSource
}

export type PeerSession = {
  readonly role: PeerRole
  readonly stage: SessionStage
  /**
   * True once the peer has proved it holds the private half of the static key
   * it claimed, and the session is still usable. Gate anything actionable on
   * this rather than on `stage === 'established'`.
   *
   * An initiator is confirmed the moment it is established: only the responder
   * it addressed could have produced message two. A responder is confirmed by
   * the first transport message that decrypts, because those keys need the
   * initiator's ephemeral *and* static private keys — which is exactly what a
   * replayer of message one does not have.
   */
  readonly confirmed: boolean
  /** True when this side owes the wire the next handshake message. */
  readonly expectsHandshakeWrite: boolean
  /** True when this side is waiting for the next handshake message. */
  readonly expectsHandshakeRead: boolean
  /**
   * Writes the next handshake message. The first one takes no payload and
   * refuses a non-empty one with `replayable_payload`; the second may carry
   * anything that fits.
   */
  writeHandshakeMessage(payload?: Uint8Array): Uint8Array
  /**
   * Reads the next handshake message and returns its payload. A non-empty
   * payload on the first message is refused with `replayable_payload`, so what
   * a responder gets back from its first read is always empty.
   */
  readHandshakeMessage(message: Uint8Array): Uint8Array
  encrypt(plaintext: Uint8Array): Uint8Array
  decrypt(message: Uint8Array): Uint8Array
  /** The peer's authenticated static public key. Throws until confirmed. */
  remoteStaticPublicKey(): Uint8Array
  /** Noise's channel binding value, safe to expose. Throws until established. */
  handshakeHash(): Uint8Array
  close(): void
}

const EMPTY = new Uint8Array(0)

export function createInitiatorSession(options: InitiatorOptions): PeerSession {
  const staticKeyPair = staticPairFrom(options.staticPrivateKey)
  const remote = copyKey(options.remoteStaticPublicKey)
  return createSession({
    role: 'initiator',
    staticKeyPair,
    remoteStaticPublicKey: remote,
    acceptRemoteStatic: undefined,
    prologue: options.prologue ?? EMPTY,
    random: options.random ?? systemRandom
  })
}

export function createResponderSession(options: ResponderOptions): PeerSession {
  const staticKeyPair = staticPairFrom(options.staticPrivateKey)
  return createSession({
    role: 'responder',
    staticKeyPair,
    remoteStaticPublicKey: null,
    acceptRemoteStatic: options.isAuthorisedPeer,
    prologue: options.prologue ?? EMPTY,
    random: options.random ?? systemRandom
  })
}

/**
 * The common case of a roster with a fixed set of keys. Comparison is
 * length-checked and constant-time — membership is public information, so this
 * is belt and braces rather than a requirement.
 */
export function rosterOf(publicKeys: readonly Uint8Array[]): (candidate: Uint8Array) => boolean {
  const roster = publicKeys.map(copyKey)
  return (candidate) => roster.some((known) => equalBytes(known, candidate))
}

function staticPairFrom(privateKey: Uint8Array): KeyPair {
  if (privateKey.length !== DH_LEN) throw peerError(PeerErrorCode.InvalidKey)
  // Copied so a caller zeroing or reusing its buffer cannot mutate the session.
  const copy = new Uint8Array(privateKey)
  return { privateKey: copy, publicKey: derivePublicKey(copy) }
}

function copyKey(key: Uint8Array): Uint8Array {
  if (key.length !== DH_LEN) throw peerError(PeerErrorCode.InvalidKey)
  return new Uint8Array(key)
}

type SessionConfig = {
  readonly role: PeerRole
  readonly staticKeyPair: KeyPair
  readonly remoteStaticPublicKey: Uint8Array | null
  readonly acceptRemoteStatic: ((staticPublicKey: Uint8Array) => boolean) | undefined
  readonly prologue: Uint8Array
  readonly random: RandomSource
}

/**
 * Built from closures rather than fields on purpose. Keys, chaining keys and
 * nonces live in this function's scope and are reachable only through the
 * methods below, so `console.log(session)`, `util.inspect(session)` and
 * `JSON.stringify(session)` have nothing secret to print — which is the shape a
 * log line actually takes.
 */
function createSession(config: SessionConfig): PeerSession {
  const initiator = config.role === 'initiator'

  let stage: SessionStage = 'handshake'
  let handshake: HandshakeState | null = initializeHandshake({
    pattern: IK_PATTERN,
    initiator,
    prologue: config.prologue,
    staticKeyPair: config.staticKeyPair,
    remoteStaticPublicKey: config.remoteStaticPublicKey,
    random: config.random,
    acceptRemoteStatic: config.acceptRemoteStatic
  })
  let sending: CipherState | null = null
  let receiving: CipherState | null = null
  let remoteStatic: Uint8Array | null = null
  let transcript: Uint8Array | null = null
  let confirmed = false

  const shutDown = (): void => {
    stage = 'closed'
    // A dead session confirms nothing, so a caller polling `confirmed` cannot
    // be told yes about a peer it can no longer hear from.
    confirmed = false
    if (handshake) destroyHandshake(handshake)
    handshake = null
    // The static private key here is this session's own copy, so erasing it
    // cannot disturb the caller's.
    wipe(config.staticKeyPair.privateKey)
    wipe(sending?.k ?? null)
    wipe(receiving?.k ?? null)
    sending = null
    receiving = null
  }

  /** Anything that fails on data from the wire takes the session down with it. */
  const failClosed = <T>(run: () => T): T => {
    try {
      return run()
    } catch (error) {
      shutDown()
      throw error
    }
  }

  const requireStage = (expected: SessionStage): void => {
    if (stage === 'closed') throw peerError(PeerErrorCode.SessionClosed)
    if (stage !== expected) throw peerError(PeerErrorCode.OutOfTurn)
  }

  const messageIndex = (): number => handshake?.messageIndex ?? IK_PATTERN.messages.length
  const owesWrite = (): boolean => stage === 'handshake' && messageIndex() % 2 === (initiator ? 0 : 1)

  const adopt = (transport: TransportKeys, hs: HandshakeState): void => {
    sending = initiator ? transport.initiatorToResponder : transport.responderToInitiator
    receiving = initiator ? transport.responderToInitiator : transport.initiatorToResponder
    remoteStatic = hs.rs ? hs.rs.slice() : null
    transcript = transcriptHash(hs)
    // An initiator reaching this point has decrypted message two, which only
    // the responder it addressed could have written; that is key confirmation
    // and there is nothing further to wait for. A responder reaching it has
    // only a claimed identity, and waits for a transport message.
    confirmed = initiator
    destroyHandshake(hs)
    handshake = null
    stage = 'established'
  }

  return {
    get role() {
      return config.role
    },
    get stage() {
      return stage
    },
    get confirmed() {
      return confirmed
    },
    get expectsHandshakeWrite() {
      return owesWrite()
    },
    get expectsHandshakeRead() {
      return stage === 'handshake' && !owesWrite()
    },

    writeHandshakeMessage(payload = EMPTY) {
      requireStage('handshake')
      const hs = handshake
      if (!hs || !owesWrite()) throw peerError(PeerErrorCode.OutOfTurn)
      // Both checks run before the handshake state is touched, so a refused
      // payload leaves the session exactly as it was.
      if (hs.messageIndex === FIRST_MESSAGE && payload.length > 0) throw peerError(PeerErrorCode.ReplayablePayload)
      const overhead = HANDSHAKE_OVERHEAD[hs.messageIndex] ?? MAX_MESSAGE_LEN
      if (payload.length > MAX_MESSAGE_LEN - overhead) throw peerError(PeerErrorCode.MessageTooLong)

      return failClosed(() => {
        const step = writeMessage(hs, payload)
        if (step.transport) adopt(step.transport, hs)
        return step.bytes
      })
    },

    readHandshakeMessage(message) {
      requireStage('handshake')
      const hs = handshake
      if (!hs || owesWrite()) throw peerError(PeerErrorCode.OutOfTurn)
      const first = hs.messageIndex === FIRST_MESSAGE

      return failClosed(() => {
        const step = readMessage(hs, message)
        // A peer that puts something in the replayable message is not one this
        // library knows how to talk to, and the refusal is after the fact
        // rather than before it only because the length is not knowable until
        // the message has been opened.
        if (first && step.bytes.length > 0) throw peerError(PeerErrorCode.ReplayablePayload)
        if (step.transport) adopt(step.transport, hs)
        // Copied: with no handshake key yet in play the payload can be a view
        // into the caller's own buffer.
        return step.bytes.slice()
      })
    },

    encrypt(plaintext) {
      requireStage('established')
      const cs = sending
      if (!cs) throw peerError(PeerErrorCode.OutOfTurn)
      if (plaintext.length > MAX_PLAINTEXT_LEN) throw peerError(PeerErrorCode.MessageTooLong)
      // Transport messages are authenticated with no associated data: the
      // transcript is already bound into the keys by Split().
      return failClosed(() => encryptWithAd(cs, EMPTY, plaintext))
    },

    decrypt(message) {
      requireStage('established')
      const cs = receiving
      if (!cs) throw peerError(PeerErrorCode.OutOfTurn)
      return failClosed(() => {
        if (message.length > MAX_MESSAGE_LEN) throw peerError(PeerErrorCode.MessageTooLong)
        const plaintext = decryptWithAd(cs, EMPTY, message)
        // Key confirmation: these keys came out of Split() over ee, es, se and
        // ss, so a message that authenticates under them was written by
        // something holding the ephemeral and static private keys of the peer
        // we think we are talking to.
        confirmed = true
        return plaintext
      })
    },

    remoteStaticPublicKey() {
      requireStage('established')
      // Withheld until the peer has proved the identity it claimed, so a
      // replayed message one cannot be attributed to the person it names.
      if (!confirmed) throw peerError(PeerErrorCode.UnconfirmedPeer)
      if (!remoteStatic) throw peerError(PeerErrorCode.OutOfTurn)
      return remoteStatic.slice()
    },

    handshakeHash() {
      requireStage('established')
      if (!transcript) throw peerError(PeerErrorCode.OutOfTurn)
      return transcript.slice()
    },

    close() {
      shutDown()
    }
  }
}

/** Fresh X25519 identity for an installation. The private half never leaves the machine. */
export function generateStaticKeyPair(random: RandomSource = systemRandom): KeyPair {
  return generateKeyPair(random)
}
