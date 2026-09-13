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

import type { PeerLink as PeerLinkStatus, PeerLinkPhase } from '../../../shared/entities'
import type { MethodName, ParamsOf, ResultOf } from '../../../shared/methods'
import { createInitiatorSession, createResponderSession, isPeerError, type PeerSession } from '../../../shared/peer'
import {
  createPeerTransport,
  type RemoteReadVerdict,
  type Answered,
  type PeerTransport,
  type RemoteWriteRequest,
  type RemoteWriteVerdict
} from '../../runtime/peerTransport'
import type { Dispatcher } from '../../runtime/dispatcher'
import type { SubscriptionHub } from '../../runtime/subscriptionHub'
import { openRelayConnection, reconnectPolicyFor, type RelayClosure, type RelayConnection } from './relayConnection'
import type { RelayDialer } from './relaySocket'
import { epochAt, epochEndsAt, rendezvousToken, rendezvousUrl, sessionPrologue, sharedSecret } from './rendezvous'

/** One of the teammate's stream events, and where it sat in the received order. */
type HeldEvent = { event: unknown; sequence: number }

/** A quiet pair still has to say something, or the relay's idle deadline ends it. */
export const KEEPALIVE_MS = 120_000

/** Past this a paired connection that has not finished handshaking is not going to. */
export const HANDSHAKE_TIMEOUT_MS = 15_000

export const BACKOFF_START_MS = 1_000
export const BACKOFF_CEILING_MS = 60_000

/**
 * The shortest wait between one attempt ending and the next one dialling.
 *
 * `relay/README.md` says to come straight back after a `4001`, and for a
 * teammate whose machine really did drop that is right. Taken literally it is
 * also a way for the far end to choose how often this machine spends a
 * Diffie-Hellman and a socket: confirm, drop, repeat, and none of it costs the
 * side doing it anything. "Straight back" therefore has a floor.
 */
export const RECONNECT_FLOOR_MS = 1_000

/**
 * How long a confirmed session has to last before its backoff is forgiven.
 *
 * One keepalive interval, because a session that carried one of those was a
 * session that worked. A session that confirmed and went inside it proves
 * nothing about the link, so it pays the growing backoff like any other
 * failure rather than resetting it.
 */
export const HEALTHY_SESSION_MS = KEEPALIVE_MS

/**
 * How many hourly rendezvous rotations a link waits through before it says more
 * than "not connected".
 *
 * Two, because one proves nothing: a link started at any point in an hour
 * crosses its first boundary after anywhere from a second to an hour, and a
 * colleague making a coffee covers that. Two rotations is between one and two
 * hours of nobody arriving at an address only these two machines can compute,
 * which is long enough that the ordinary explanations are used up.
 */
export const WAITING_EPOCHS_BEFORE_DIAGNOSIS = 2

/** What waiting means before anything is odd about it. */
export const WAITING_DETAIL = 'your teammate’s machine is not connected'

/**
 * What the client can honestly say when nobody has arrived for that long.
 *
 * A clock far enough out to straddle the hourly boundary and a teammate
 * pointing at a different relay both present as this, for ever, and the relay
 * genuinely cannot help: it sees opaque tokens by design, and to it an
 * unanswered rendezvous is indistinguishable from a rendezvous nobody else has
 * ever computed. So this names what is known — nobody has answered here — and
 * the two things that are checkable from this side, and diagnoses neither.
 */
export const WAITING_TOO_LONG_DETAIL =
  'nobody has answered on this rendezvous across two hourly rotations, which is longer than a teammate ' +
  'who is simply away. The relay cannot tell either of us why: it only ever sees opaque tokens. Two things ' +
  'can be checked from here — that both machines agree about the time, because the rendezvous changes on ' +
  'the hour and teamree will not pair across two of them, and that .teamree/relay names the same relay on both.'

/**
 * How much of a stream is held while its own subscribe answer is still in
 * flight.
 *
 * A subscription's first events can beat the response that names it: the far
 * side attaches the stream inside the handler, and a pane already printing
 * writes frames behind the answer rather than after it. The window is one round
 * trip, so these are generous; they are bounds rather than a capacity, and a
 * stream nobody ever claims cannot grow without limit.
 */
export const MAX_UNROUTED_STREAMS = 16
export const MAX_UNROUTED_EVENTS = 256

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
  /**
   * A snapshot this teammate pushed, exactly as it decrypted.
   *
   * `unknown`, because it is: the far end authenticated, which says who wrote
   * these bytes and nothing whatever about their shape. The caller validates.
   */
  onPresence: (presence: unknown) => void
  /**
   * Which of *this* machine's panes the teammate has open, whenever it changes.
   *
   * The owner's half of the bargain in `docs/teamwork.md`: watching cannot be
   * done invisibly, so the fact travels up from the transport that saw the
   * subscription rather than being inferred anywhere later.
   */
  onWatchersChange?: (terminalIds: readonly string[]) => void
  /**
   * Whether one of this teammate's keystrokes may reach one of this machine's
   * panes.
   *
   * Passed straight through to the transport, which is where the gate has to
   * be: it is the last place that still knows the caller is a teammate. A link
   * left without one carries no keystrokes, which is the correct default for
   * the one method on the allow-list that runs code.
   */
  onRemoteWrite?: (write: RemoteWriteRequest) => RemoteWriteVerdict
  onRemoteRead?: (terminalId: string) => RemoteReadVerdict
  onError?: (error: unknown) => void
}

export type PeerLink = {
  readonly status: PeerLinkStatus
  start: () => void
  /** Stops for good: no reconnect, no timers, no socket. */
  stop: () => void
  /**
   * Asks the teammate for something, from the same catalogue.
   *
   * Refused unless the session is confirmed, which is the rule this whole file
   * is written around: a replayed handshake reaches `established` holding
   * somebody else's key, and a call made on that basis would be a request sent
   * into a session nobody is on the other end of.
   */
  call: <M extends MethodName>(method: M, params: ParamsOf<M>) => Promise<ResultOf<M>>
  /**
   * The same, and where the teammate's answer sat among the frames that arrived
   * with it.
   *
   * What `paneWatch.ts` joins a scrollback to a live stream by. The numbers
   * here and the ones `route` reports come from one counter, so they are
   * comparable and nothing else about them means anything.
   */
  callInOrder: <M extends MethodName>(method: M, params: ParamsOf<M>) => Promise<Answered<M>>
  /**
   * Directs one of the teammate's streams somewhere. Returns the undo.
   *
   * Presence has a route of its own from the moment the link confirms; this is
   * how a watched pane gets one, and why a stream frame is never guessed at by
   * its shape. Each event comes with its position in the received frame order,
   * for the caller that has to know whether it preceded an answer.
   */
  route: (subscription: string, onEvent: (event: unknown, sequence: number) => void) => () => void
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
  /**
   * Rotations waited through since anybody was last on the other end. Not per
   * attempt: it is the whole point that it survives the reconnect each rollover
   * causes, and it is cleared by somebody arriving rather than by time passing.
   */
  let rolloversWaiting = 0
  /** Scoped to one session: has anything from the far end ever decrypted? */
  let confirmed = false
  /** When that happened, so a session can be asked how long it lasted. */
  let confirmedAt: number | undefined
  /** Streams this side opened on the teammate, by subscription id. */
  const routes = new Map<string, (event: unknown, sequence: number) => void>()
  /** Events for a subscription whose answer has not landed yet, in order. */
  const unrouted = new Map<string, HeldEvent[]>()
  let cancelPresenceRoute: (() => void) | undefined
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
    cancelPresenceRoute = undefined
    routes.clear()
    unrouted.clear()
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
        ? RECONNECT_FLOOR_MS
        : // Full jitter: the whole window rather than a fixed fraction of it, so
          // a relay coming back does not get every link on the team at once.
          Math.max(RECONNECT_FLOOR_MS, Math.round(backoffMs * random()))
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
    // A session that worked earns the reset; one that confirmed and went inside
    // a keepalive does not, because that is the shape a peer can repeat at will.
    const lasted = confirmedAt !== undefined && options.scheduler.now() - confirmedAt >= HEALTHY_SESSION_MS
    if (lasted) backoffMs = BACKOFF_START_MS
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
    // A session that confirmed and then went straight away is not the "your
    // partner left, come back now" case the relay's table is written for,
    // whatever code ended it: repeated, it is somebody else choosing how often
    // this machine dials. It backs off like a failure, because that is what it
    // is until one of these sessions lasts.
    scheduleRetry(wasConnected && !lasted ? 'backoff' : policy.kind)
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
   * One of the teammate's streams, to whoever asked for it.
   *
   * By the id the subscription was answered with, never by the shape of what
   * arrived: a pane's output and a presence snapshot are both just objects, and
   * a link that guessed could be made to guess wrong.
   */
  const deliver = (stream: string, event: unknown, sequence: number): void => {
    const route = routes.get(stream)
    if (route) {
      route(event, sequence)
      return
    }
    let held = unrouted.get(stream)
    if (!held) {
      if (unrouted.size >= MAX_UNROUTED_STREAMS) return
      held = []
      unrouted.set(stream, held)
    }
    if (held.length >= MAX_UNROUTED_EVENTS) held.shift()
    held.push({ event, sequence })
  }

  /** Both public call shapes, and the one refusal they share. */
  const ask = <M extends MethodName>(method: M, params: ParamsOf<M>): Promise<Answered<M>> => {
    const active = transport
    if (!confirmed || !active) {
      return Promise.reject(new Error('this teammate’s session is not confirmed'))
    }
    return active.callInOrder(method, params)
  }

  const route = (subscription: string, onEvent: (event: unknown, sequence: number) => void): (() => void) => {
    routes.set(subscription, onEvent)
    // Whatever came in before the answer did, in the order it came in, each
    // still carrying where it came in. This is the join a watcher depends on:
    // the first bytes of a live pane must not be the ones lost to the round
    // trip that asked for them, and arriving late here must not make a frame
    // look later than it was.
    const held = unrouted.get(subscription)
    unrouted.delete(subscription)
    for (const { event, sequence } of held ?? []) onEvent(event, sequence)
    return () => {
      routes.delete(subscription)
    }
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
    confirmedAt = options.scheduler.now()
    // Now, and not at `establish`: the deadline's job is the unconfirmed window,
    // and this is the moment that window closes.
    cancelHandshakeDeadline?.()
    cancelHandshakeDeadline = undefined
    moveTo('connected')
    // One subscription for the life of the link. It answers immediately, so
    // there is no separate first read to race with the stream.
    void transport
      .call('peer.subscribe', {})
      .then(({ subscription }) => {
        cancelPresenceRoute?.()
        cancelPresenceRoute = route(subscription, (event) => options.onPresence(event))
      })
      .catch((error: unknown) => {
        options.onError?.(error)
        connection?.close(1000, '')
      })
  }

  const establish = (): void => {
    const active = session
    if (!active) return
    // The deadline is deliberately left running. It exists for the window this
    // function opens — the handshake has parsed and nobody has yet shown they
    // hold a key — and cancelling it here would leave a replayed session
    // holding a rendezvous, kept alive by this side's own keepalive, forever.

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
      onStreamEvent: (stream, event, sequence) => {
        // Cannot arrive before confirmation — it had to be decrypted to get
        // here — but the ordering is asserted rather than assumed, because a
        // forged snapshot is exactly what a replayer would want.
        if (!confirmed) return
        deliver(stream, event, sequence)
      },
      onWatchChange: options.onWatchersChange,
      ...(options.onRemoteWrite ? { onRemoteWrite: options.onRemoteWrite } : {}),
      ...(options.onRemoteRead ? { onRemoteRead: options.onRemoteRead } : {}),
      scheduler: options.scheduler,
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
    confirmedAt = undefined
    moveTo('connecting')

    const epoch = epochAt(options.scheduler.now())
    const token = rendezvousToken(secret, options.projectKey, epoch)

    connection = openRelayConnection({
      url: rendezvousUrl(options.relayUrl, token),
      token,
      dial: options.dial,
      events: {
        onWaiting: () => {
          moveTo(
            'waiting',
            rolloversWaiting >= WAITING_EPOCHS_BEFORE_DIAGNOSIS ? WAITING_TOO_LONG_DETAIL : WAITING_DETAIL
          )
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
              // Counted here rather than where the next one is dialled: this is
              // the only place that knows a whole rotation was spent parked on
              // the relay with nobody arriving.
              rolloversWaiting += 1
              connection?.close(1000, '')
            },
            Math.max(1, epochEndsAt(options.scheduler.now()) - options.scheduler.now())
          )
        },
        onPaired: ({ initiator }) => {
          cancelEpochWatch?.()
          cancelEpochWatch = undefined
          // Somebody answered here, so whatever the wait was, it was not this.
          rolloversWaiting = 0
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
      rolloversWaiting = 0
      connect()
    },
    stop: () => {
      running = false
      teardown('teamwork stopped')
    },
    call: <M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> =>
      ask(method, params).then((answer) => answer.result),
    callInOrder: ask,
    route
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
