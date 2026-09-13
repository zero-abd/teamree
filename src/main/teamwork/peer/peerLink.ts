// One link to one teammate: dial, handshake, run, and come back when it drops.
//
// A link is per teammate **per project**, because the rendezvous is. The token
// is derived from the Diffie-Hellman between two keys *and the project key*, so
// two people who share three repositories meet in three places. That costs a
// connection per shared repository and buys the thing a pairwise session cannot
// have: a Noise transcript that says which project it is for. The project goes
// into the prologue as well as the token, so the binding is in the transcript
// itself rather than inferred from where the two of them happened to meet.
//
// THE ONE RULE THAT IS NOT NEGOTIABLE. `src/shared/peer` distinguishes
// `unknown_peer` from `decryption_failed` on purpose, and its author left a
// note saying why that distinction must not reach the wire: it separates "you
// are not a member" from "you dialled the wrong machine", which is an oracle a
// stranger can walk a roster with. Every handshake failure here ends the
// connection the same way — same close code, same empty reason, same silence —
// and the difference survives only in this process, for its own operator.
//
// THE SECOND RULE THAT IS NOT NEGOTIABLE. Completing an `IK` handshake is not
// proof that anybody is there. A responder finishes message 2 having only
// *written* it, so a replayer holding a captured message 1 and no private key
// reaches `established` with the real peer's static key attached to it. It can
// read nothing and can never send a transport message — it has no keys — but a
// link that announced itself `connected` on that basis would be claiming a
// teammate is present when they are not, and would be doing it on evidence a
// compromised relay can manufacture from a recording.
//
// So this file treats `established` as "the handshake parsed" and waits for the
// first successfully *decrypted* transport message before it will say
// `connected`, subscribe to anything, or let a snapshot be believed. That is
// key confirmation, it costs one round trip of a frame that was going to be
// sent anyway, and it is the property a replayer cannot forge. Nothing
// actionable is ever put in the message-1 payload, which is the other half of
// the same fix; the payload this sends is empty.
//
// Everything with a deadline in it is driven by an injected clock and an
// injected timer, so the tests for reconnection, backoff and the hourly epoch
// boundary assert behaviour rather than wait for it.

import type { PeerLink as PeerLinkStatus, PeerLinkPhase, PeerPresence } from '../../../shared/entities'
import { createInitiatorSession, createResponderSession, isPeerError, type PeerSession } from '../../../shared/peer'
import { createPeerTransport, type PeerTransport } from '../../runtime/peerTransport'
import type { Dispatcher } from '../../runtime/dispatcher'
import type { SubscriptionHub } from '../../runtime/subscriptionHub'
import { openRelayConnection, reconnectPolicyFor, type RelayClosure, type RelayConnection } from './relayConnection'
import type { RelayDialer } from './relaySocket'
import { epochAt, epochEndsAt, rendezvousToken, rendezvousUrl, sessionPrologue, sharedSecret } from './rendezvous'

/** A quiet pair still has to say something, or the relay's idle deadline ends it. */
export const KEEPALIVE_MS = 120_000

/** Past this a paired connection that has not finished handshaking is not going to. */
export const HANDSHAKE_TIMEOUT_MS = 15_000

export const BACKOFF_START_MS = 1_000
export const BACKOFF_CEILING_MS = 60_000

/**
 * Timers and the clock, as one seam.
 *
 * Injected rather than reached for so a test can run an hour of reconnection in
 * a microtask, and so nothing in this file is ever tempted to sleep.
 */
export type LinkScheduler = {
  now: () => number
  /** Returns the cancel for the timer it set. */
  setTimer: (run: () => void, delayMs: number) => () => void
  /** Jitter, so a relay restarting does not get the whole team back at once. */
  random?: () => number
}

export type PeerLinkOptions = {
  /** The teammate's base64 public key: the identity, and the only one accepted. */
  remotePublicKey: string
  /** What the roster files that key under, for the window to show. */
  handle: string
  /**
   * The project this link is for, as `projectKey.ts` derives it.
   *
   * Not optional, and not defaulted. It goes into the rendezvous and into the
   * Noise prologue, so a link without one is a session that does not know what
   * it is about — which is exactly the thing this parameter exists to stop
   * happening by omission.
   */
  projectKey: string
  /** This installation's raw X25519 scalar. Never leaves this object. */
  staticPrivateKey: Uint8Array
  relayUrl: string
  /**
   * This link's subscription scope, and the id its handlers see as the caller.
   * Passed in rather than derived here: the service maps it back to the
   * teammate it belongs to, and two places deriving one id is two places for it
   * to stop agreeing.
   */
  connectionId: string
  dial: RelayDialer
  dispatch: Dispatcher
  subscriptions: SubscriptionHub
  scheduler: LinkScheduler
  /** Called whenever the phase or its detail changes, never on a repeat. */
  onStatusChange: (status: PeerLinkStatus) => void
  /** A snapshot this teammate pushed. Dropped by the caller if it is behind. */
  onPresence: (presence: PeerPresence) => void
  onError?: (error: unknown) => void
}

export type PeerLink = {
  readonly status: PeerLinkStatus
  start: () => void
  /** Stops for good: no reconnect, no timers, no socket. */
  stop: () => void
}

type HandshakeOutcome =
  | { kind: 'established' }
  /** Locally distinguishable, and never reported to the peer. */
  | { kind: 'rejected'; local: string }

export function createPeerLink(options: PeerLinkOptions): PeerLink {
  const random = options.scheduler.random ?? Math.random
  const connectionId = options.connectionId
  const secret = sharedSecret(options.staticPrivateKey, options.remotePublicKey)

  let phase: PeerLinkPhase = 'connecting'
  let detail: string | undefined
  let since = options.scheduler.now()
  let attempts = 0
  let backoffMs = BACKOFF_START_MS

  let running = false
  /** Scoped to one attempt: why this socket is about to end, when we ended it. */
  let refusedThisAttempt = false
  let rolledOverThisAttempt = false
  /** Scoped to one session: has anything from the far end ever decrypted? */
  let confirmed = false
  let connection: RelayConnection | undefined
  let session: PeerSession | undefined
  let transport: PeerTransport | undefined
  let cancelTimer: (() => void) | undefined
  let cancelKeepalive: (() => void) | undefined
  let cancelHandshakeDeadline: (() => void) | undefined
  let cancelEpochWatch: (() => void) | undefined

  const snapshot = (): PeerLinkStatus => {
    const status: PeerLinkStatus = {
      publicKey: options.remotePublicKey,
      handle: options.handle,
      phase,
      since,
      attempts
    }
    if (detail !== undefined) status.detail = detail
    return status
  }

  const moveTo = (next: PeerLinkPhase, nextDetail?: string): void => {
    if (phase === next && detail === nextDetail) return
    phase = next
    detail = nextDetail
    since = options.scheduler.now()
    options.onStatusChange(snapshot())
  }

  const clearTimers = (): void => {
    cancelTimer?.()
    cancelKeepalive?.()
    cancelHandshakeDeadline?.()
    cancelEpochWatch?.()
    cancelTimer = undefined
    cancelKeepalive = undefined
    cancelHandshakeDeadline = undefined
    cancelEpochWatch = undefined
  }

  /**
   * Everything this attempt owns, released in one place.
   *
   * The Noise session is closed rather than dropped: it holds transport keys,
   * and `close` wipes them instead of leaving them for the collector.
   */
  const teardown = (reason: string): void => {
    clearTimers()
    transport?.close(reason)
    transport = undefined
    session?.close()
    session = undefined
    connection?.close()
    connection = undefined
  }

  /** Identical for every handshake failure, whatever it actually was. */
  const dropSilently = (): void => {
    // 1000 with no reason: the peer learns that the connection ended and gets
    // no help telling "not on the roster" from "wrong machine" from "the relay
    // spliced you to a stranger".
    connection?.close(1000, '')
  }

  const scheduleRetry = (kind: 'immediate' | 'backoff'): void => {
    if (!running) return
    const delay =
      kind === 'immediate'
        ? 0
        : // Full jitter: the whole window rather than a fixed fraction of it, so
          // a relay coming back does not get every link on the team at once.
          Math.round(backoffMs * random())
    if (kind === 'backoff') backoffMs = Math.min(backoffMs * 2, BACKOFF_CEILING_MS)
    cancelTimer = options.scheduler.setTimer(() => {
      cancelTimer = undefined
      connect()
    }, delay)
  }

  const onClosed = (closure: RelayClosure): void => {
    const wasConnected = confirmed
    const wasRefused = refusedThisAttempt
    const wasRollover = rolledOverThisAttempt
    teardown('the peer link ended')
    if (!running) return

    // The hour turned under a parked connection. Nothing is wrong, the token
    // has simply moved on, so the phase stays as it was and the link comes
    // straight back under the new one.
    if (wasRollover) {
      scheduleRetry('immediate')
      return
    }

    // A refusal keeps the reason the operator needs and backs off: whatever
    // answered will answer again, and reconnecting into it at speed would spend
    // the relay's budget proving the same thing repeatedly.
    if (wasRefused) {
      scheduleRetry('backoff')
      return
    }

    const policy = reconnectPolicyFor(closure)
    if (policy.kind === 'stop') {
      moveTo('stopped', policy.reason)
      return
    }
    // A link that got all the way up and then dropped is a teammate whose
    // machine went away, not a relay that cannot be reached: saying
    // "unreachable" there would send somebody to check their own network.
    if (wasConnected || closure.paired) moveTo('waiting', 'your teammate’s machine dropped the connection')
    else moveTo('unreachable', closure.reason || 'the relay could not be reached')
    scheduleRetry(policy.kind)
  }

  const runHandshake = (initiator: boolean, token: string): void => {
    // Always passed, never defaulted. An empty prologue is a transcript that
    // authenticates two keys and says nothing about what they are talking
    // about, and every mitigation for that would have to live at a call site
    // rather than here.
    const prologue = sessionPrologue(options.projectKey, token)

    session = initiator
      ? createInitiatorSession({
          staticPrivateKey: options.staticPrivateKey,
          remoteStaticPublicKey: Buffer.from(options.remotePublicKey, 'base64'),
          prologue
        })
      : createResponderSession({
          staticPrivateKey: options.staticPrivateKey,
          prologue,
          // Not "anyone on any roster": this rendezvous can only have been
          // computed by the holder of that one key, so that one key is the only
          // legitimate answer to it.
          isAuthorisedPeer: (candidate) => Buffer.from(candidate).toString('base64') === options.remotePublicKey
        })

    cancelHandshakeDeadline = options.scheduler.setTimer(() => {
      cancelHandshakeDeadline = undefined
      // Covers the unconfirmed window too: a replayer completes the handshake
      // and then, having no keys, can never say anything. This is what ends
      // that session rather than leaving it holding a slot forever.
      if (confirmed) return
      // Says nothing to the peer, for the same reason a rejection says nothing.
      dropSilently()
    }, HANDSHAKE_TIMEOUT_MS)

    if (initiator) {
      try {
        connection?.send(session.writeHandshakeMessage())
      } catch (error) {
        rejectHandshake(localReason(error))
      }
    }
  }

  const rejectHandshake = (local: string): void => {
    // Local only. The peer gets a closed socket and nothing else.
    refusedThisAttempt = true
    moveTo('refused', local)
    dropSilently()
  }

  const onHandshakeMessage = (message: Uint8Array): HandshakeOutcome => {
    const active = session
    if (!active) return { kind: 'rejected', local: 'a handshake message arrived with no handshake running' }
    try {
      active.readHandshakeMessage(message)
      if (active.expectsHandshakeWrite) connection?.send(active.writeHandshakeMessage())
    } catch (error) {
      return { kind: 'rejected', local: localReason(error) }
    }
    return active.stage === 'established'
      ? { kind: 'established' }
      : { kind: 'rejected', local: 'the handshake did not complete' }
  }

  /**
   * Key confirmation: a transport message from the far end that authenticated.
   *
   * This is the moment a peer stops being a handshake that parsed and starts
   * being somebody who holds the private key. Everything the user is told, and
   * everything believed about what they are showing, hangs off it.
   */
  const confirm = (): void => {
    if (confirmed || !transport) return

    // Belt and braces over what `IK` already guarantees: whichever side we
    // played, the key the transcript authenticated is the key we dialled. This
    // lives here rather than at `established` because the session refuses to
    // name a peer that has not yet proved it holds the private half — on this
    // side of the handshake that proof is the frame that just decrypted, and
    // asking any earlier is asking before there is an answer.
    const active = session
    if (!active) return
    if (Buffer.from(active.remoteStaticPublicKey()).toString('base64') !== options.remotePublicKey) {
      rejectHandshake('the handshake authenticated a different key than the one this link dialled')
      return
    }

    confirmed = true
    backoffMs = BACKOFF_START_MS
    moveTo('connected')
    // One subscription for the life of the link. It answers immediately, so
    // there is no separate first read to race with the stream.
    void transport.call('peer.subscribe', {}).catch((error: unknown) => {
      options.onError?.(error)
      connection?.close(1000, '')
    })
  }

  const establish = (): void => {
    const active = session
    if (!active) return
    cancelHandshakeDeadline?.()
    cancelHandshakeDeadline = undefined

    transport = createPeerTransport({
      session: active,
      send: (message) => connection?.send(message),
      dispatch: options.dispatch,
      subscriptions: options.subscriptions,
      connectionId,
      // The first thing this side successfully decrypts is the first proof that
      // somebody holding the private key is actually on the other end. Until
      // then the handshake has only been parsed.
      onConfirmed: confirm,
      onStreamEvent: (_stream, event) => {
        // Cannot arrive before confirmation — it had to be decrypted to get
        // here — but the ordering is asserted rather than assumed, because a
        // forged snapshot is exactly what a replayer would want.
        if (!confirmed) return
        options.onPresence(event as PeerPresence)
      },
      onFatal: () => {
        // A Noise stream with a hole in it is over: there is no point it could
        // be picked up from, so the socket goes and the link rebuilds.
        connection?.close(1000, '')
      },
      onError: options.onError
    })

    // Deliberately NOT `connected` yet, and deliberately not a new phase the
    // user reads: from where they sit this is still connecting, because nothing
    // has yet shown that anyone is there.
    cancelKeepalive = repeat(options.scheduler, KEEPALIVE_MS, () => transport?.keepalive())
    // The round trip that confirms the keys, made of a frame the relay's idle
    // deadline wanted anyway. The peer's own keepalive confirms us to them.
    transport.keepalive()
  }

  const connect = (): void => {
    if (!running) return
    attempts += 1
    refusedThisAttempt = false
    rolledOverThisAttempt = false
    confirmed = false
    moveTo('connecting')

    const epoch = epochAt(options.scheduler.now())
    const token = rendezvousToken(secret, options.projectKey, epoch)

    connection = openRelayConnection({
      url: rendezvousUrl(options.relayUrl, token),
      token,
      dial: options.dial,
      events: {
        onWaiting: () => {
          moveTo('waiting', 'your teammate’s machine is not connected')
          // A peer still parked when the hour turns re-registers under the new
          // token, which is what `relay/README.md` says a client does. Two
          // machines whose clocks straddle the boundary do not meet until the
          // lagging one crosses it; teamree does not paper over a wrong clock,
          // and pretending otherwise would mean guessing at neighbouring epochs
          // and pairing with whoever answered.
          cancelEpochWatch = options.scheduler.setTimer(
            () => {
              cancelEpochWatch = undefined
              rolledOverThisAttempt = true
              connection?.close(1000, '')
            },
            Math.max(1, epochEndsAt(options.scheduler.now()) - options.scheduler.now())
          )
        },
        onPaired: ({ initiator }) => {
          cancelEpochWatch?.()
          cancelEpochWatch = undefined
          runHandshake(initiator, token)
        },
        onBinary: (payload) => {
          if (session && session.stage === 'handshake') {
            const outcome = onHandshakeMessage(payload)
            if (outcome.kind === 'rejected') rejectHandshake(outcome.local)
            else establish()
            return
          }
          transport?.receive(payload)
        },
        onClosed
      }
    })
  }

  return {
    get status() {
      return snapshot()
    },
    start: () => {
      if (running) return
      running = true
      backoffMs = BACKOFF_START_MS
      connect()
    },
    stop: () => {
      running = false
      teardown('teamwork stopped')
    }
  }
}

/**
 * A repeating timer built from the one-shot seam, so a scheduler only has to
 * implement one thing and a test only has to drive one thing.
 */
function repeat(scheduler: LinkScheduler, everyMs: number, run: () => void): () => void {
  let cancel: (() => void) | undefined
  let stopped = false
  const arm = (): void => {
    if (stopped) return
    cancel = scheduler.setTimer(() => {
      run()
      arm()
    }, everyMs)
  }
  arm()
  return () => {
    stopped = true
    cancel?.()
  }
}

/**
 * The local half of a failure, in words for this machine's operator.
 *
 * `PeerError` messages come from a frozen, secret-free table — the library
 * refuses a message parameter precisely so key material cannot be templated
 * into one — so quoting one here carries no risk of quoting a key.
 */
function localReason(error: unknown): string {
  if (isPeerError(error)) return `${error.message} (${error.code})`
  return error instanceof Error ? error.message : String(error)
}
