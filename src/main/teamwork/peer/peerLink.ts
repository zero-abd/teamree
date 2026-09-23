// One link to one teammate, per project: dial, handshake, run, come back when it drops.
// Every handshake failure ends the socket identically: `unknown_peer` vs `decryption_failed` is a roster oracle.
// `established` means the handshake parsed; `connected` waits for the first decrypted frame a replayer cannot forge.

import type { PeerLink as PeerLinkStatus, PeerLinkPhase } from '../../../shared/entities'
import type { MethodName, ParamsOf, ResultOf } from '../../../shared/methods'
import { createInitiatorSession, createResponderSession, isPeerError, type PeerSession } from '../../../shared/peer'
import {
  createPeerTransport,
  outputBytes,
  PEER_CALL_TIMEOUT_MS,
  type RemoteReadVerdict,
  type Answered,
  type PeerTransport,
  type RemoteWriteRequest,
  type RemoteWriteVerdict
} from '../../runtime/peerTransport'
import type { Dispatcher } from '../../runtime/dispatcher'
import { startTimedWindow, type TimedWindow } from '../../runtime/elapsed'
import type { SubscriptionHub } from '../../runtime/subscriptionHub'
import { openRelayConnection, reconnectPolicyFor, type RelayClosure, type RelayConnection } from './relayConnection'
import type { RelayDialer } from './relaySocket'
import { epochAt, epochEndsAt, rendezvousToken, rendezvousUrl, sessionPrologue, sharedSecret } from './rendezvous'

/** One of the teammate's stream events, and where it sat in the received order. */
type HeldEvent = { event: unknown; sequence: number }

/**
 * One stream's frames waiting for whoever asked for them, and what did not fit:
 * `lost` bytes from frame `lostAt` on, the two things an `elided` is made of.
 */
type Unrouted = {
  events: HeldEvent[]
  lost: number
  lostAt: number
  /** How long this stream has been waiting, on a clock sleep cannot move. See `elapsed.ts`. */
  opened: TimedWindow
}

/** A quiet pair still has to say something, or the relay's idle deadline ends it. */
export const KEEPALIVE_MS = 120_000

/**
 * How long a confirmed link may hear nothing before it is over: two and a half keepalives. One
 * lost keepalive leaves a two-interval gap and must not end anything; the half is margin over jitter.
 * The only liveness deadline teamree has — neither relay host supplies one on the recommended path.
 */
export const SILENCE_TIMEOUT_MS = KEEPALIVE_MS * 2.5

/** Never "they closed the connection": the socket is still open. This side sent and nothing came back. */
export const SILENT_PEER_DETAIL = 'your teammate’s machine stopped answering'

/**
 * How long a confirmed link may hear nothing before the window is told the age of that silence.
 * One and a half keepalives: one interval is an ordinary gap, so the threshold must sit past it.
 * Kept beside the interval it derives from so there is one threshold in the app, not two.
 */
export const LINK_QUIET_AFTER_MS = KEEPALIVE_MS * 1.5

/**
 * What the deadline may say when this machine was the one away: a closed lid steps the wall clock,
 * so the deadline fires on wake having measured a silence nobody on the other end caused.
 */
export const WOKE_DETAIL = 'this machine was asleep, so nothing is known about your teammate until this link is back'

/**
 * A Noise frame that fails to open was not what was sent under this session — changed, replayed,
 * dropped or reordered — and the untrusted relay is the only thing between the sockets.
 * Not "dropped the connection": nothing has been established about the teammate.
 */
export const UNAUTHENTICATED_DETAIL =
  'a message did not authenticate, so the frames did not reach this machine as your teammate sent them'

/**
 * How long a link that has given up waits before looking again. The three `stop` close codes are
 * facts about the relay, none permanent: relays get restarted, and `4008` is also sent when the relay
 * cannot find the other socket in its own table. Nothing else revives a stopped link —
 * `PeerService.reconcile()` skips a linkId it already holds on an unchanged relay.
 */
export const STOPPED_RETRY_MS = 300_000

/**
 * A pairing that never became a session. This side closes on the handshake deadline and that close
 * comes back through `onClosed` with `paired: true`; nobody hung up, so it must not say they did.
 */
export const HANDSHAKE_STALLED_DETAIL = 'your teammate’s machine was reached but the two never finished connecting'

/** Past this a paired connection that has not finished handshaking is not going to. */
export const HANDSHAKE_TIMEOUT_MS = 15_000

export const BACKOFF_START_MS = 1_000
export const BACKOFF_CEILING_MS = 60_000

/**
 * The shortest wait between attempts. `relay/README.md` says come straight back after a `4001`; taken
 * literally the far end could make this machine spend a Diffie-Hellman and a socket at will.
 */
export const RECONNECT_FLOOR_MS = 1_000

/**
 * How long a confirmed session must last before its backoff is forgiven: one keepalive interval.
 * A session that confirmed and went inside it proves nothing about the link.
 */
export const HEALTHY_SESSION_MS = KEEPALIVE_MS

/**
 * Hourly rotations waited through before saying more than "not connected". One proves nothing —
 * the first boundary lands anywhere from a second to an hour in; two is longer than a coffee.
 */
export const WAITING_EPOCHS_BEFORE_DIAGNOSIS = 2

/**
 * Only what this side can see: a teammate on a different relay URL or an hour-off clock is perfectly
 * connected — elsewhere — so "their machine is not connected" is a diagnosis this client cannot make.
 */
export const WAITING_DETAIL = 'nobody has answered on this rendezvous yet'

/**
 * A clock straddling the hourly boundary and a teammate on another relay both present as this, for
 * ever, and the relay cannot help: it sees opaque tokens. Names the two checkable things, diagnoses neither.
 */
export const WAITING_TOO_LONG_DETAIL =
  'nobody has answered on this rendezvous across two hourly rotations, which is longer than a teammate ' +
  'who stepped out. Two things can be checked from here: that both machines agree about the time, because ' +
  'the rendezvous changes on the hour and teamree will not pair across two of them, and that .teamree/relay ' +
  'names the same relay on both.'

/**
 * How much of a stream is held while its own subscribe answer is in flight: a stream's first events
 * can beat the response that names it. Bounds, not capacity. Reaching the event bound throws output
 * away and says so with an `elided`, the same event the owner's pacer writes when its buffer overruns.
 */
export const MAX_UNROUTED_STREAMS = 16
export const MAX_UNROUTED_EVENTS = 256

/**
 * How long an unclaimed stream may hold a slot: `PEER_CALL_TIMEOUT_MS`, past which the call that
 * would have claimed it has already failed. A timed-out `terminal.subscribe` never routes and never
 * unsubscribes, so without this its slot lasted the life of the link; sixteen and every later stream loses its head.
 */
export const UNROUTED_HOLD_MS = PEER_CALL_TIMEOUT_MS

/** Timers and the clock, as one seam, so a test can run an hour of reconnection in a microtask. */
export type LinkScheduler = {
  now: () => number
  /** Returns the cancel for the timer it set. */
  setTimer: (run: () => void, delayMs: number) => () => void
  /** Jitter, so a relay restarting does not get the whole team back at once. */
  random?: () => number
  /**
   * A clock this machine going to sleep cannot move; defaults to `performance.now()`. Its
   * disagreement with `now` is how a slept machine is told from a silent teammate. See `elapsed.ts`.
   */
  monotonicNow?: () => number
}

export type PeerLinkOptions = {
  /** The teammate's base64 public key: the identity, and the only one accepted. */
  remotePublicKey: string
  /** What the roster files that key under, for the window to show. */
  handle: string
  /**
   * The project this link is for, as `projectKey.ts` derives it. Not optional: it goes into the
   * rendezvous and the Noise prologue, so a link without one does not know what it is about.
   */
  projectKey: string
  /** This installation's raw X25519 scalar. Never leaves this object. */
  staticPrivateKey: Uint8Array
  relayUrl: string
  /**
   * This link's subscription scope, and the id its handlers see as the caller. Passed in, not
   * derived: the service maps it back to the teammate, and two derivations can stop agreeing.
   */
  connectionId: string
  dial: RelayDialer
  dispatch: Dispatcher
  subscriptions: SubscriptionHub
  scheduler: LinkScheduler
  /**
   * Called whenever the phase, its detail, or the age of the link's silence changes — never on a
   * repeat. Nobody downstream re-reads a link on a timer, so a status never sent is never drawn.
   */
  onStatusChange: (status: PeerLinkStatus) => void
  /**
   * A snapshot this teammate pushed, exactly as it decrypted. `unknown` because authentication
   * says who wrote the bytes and nothing about their shape; the caller validates.
   */
  onPresence: (presence: unknown) => void
  /**
   * Which of *this* machine's panes the teammate has open. Watching cannot be done invisibly
   * (`docs/teamwork.md`), so the fact travels up from the transport that saw the subscription.
   */
  onWatchersChange?: (terminalIds: readonly string[]) => void
  /**
   * Whether one of this teammate's keystrokes may reach one of this machine's panes. The gate lives
   * in the transport, the last place that knows the caller is a teammate. Absent: no keystrokes.
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
   * This machine was asleep: believe nothing about the teammate and go and find out. Called by the
   * link on an interrupted deadline and by the service on OS resume; twice for one wake costs nothing.
   */
  wake: () => void
  /**
   * Asks the teammate for something. Refused unless the session is confirmed: a replayed handshake
   * reaches `established` holding somebody else's key.
   */
  call: <M extends MethodName>(method: M, params: ParamsOf<M>) => Promise<ResultOf<M>>
  /**
   * The same, plus where the answer sat among the frames that arrived with it — what `paneWatch.ts`
   * joins a scrollback to a live stream by. Comparable only with the numbers `route` reports.
   */
  callInOrder: <M extends MethodName>(method: M, params: ParamsOf<M>) => Promise<Answered<M>>
  /**
   * Directs one of the teammate's streams somewhere; returns the undo. A stream frame is never
   * guessed at by its shape. Each event carries its position in the received frame order.
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
  /** Scoped to one attempt: did this side end it because nothing was coming back? */
  let silentThisAttempt = false
  /**
   * Rotations waited through since anybody was last on the other end. Survives the reconnect each
   * rollover causes; cleared by somebody arriving, not by time passing.
   */
  let rolloversWaiting = 0
  /**
   * Whether the last session ended in silence rather than a close. Not per attempt: it changes what
   * the wait means afterwards, and only that reading has already ruled out the clock and the relay file.
   */
  let heardThenSilent = false
  /**
   * Whether this machine has slept since it last confirmed anybody. Cleared by confirming, not by
   * connecting: until a frame decrypts again, this side was not there to hear.
   */
  let sleptWithoutAnswer = false
  /** A wake already has a reconnect coming; a second signal for it is not two. */
  let wakePending = false
  /** Which attempt owns the socket; waking abandons a socket whose close is still in flight. */
  let generation = 0
  /**
   * Scoped to one attempt: did this session end on a frame that did not authenticate? Apart from
   * `refusedThisAttempt` because it also decides whether the session counts as one that worked.
   */
  let unauthenticatedThisAttempt = false
  /**
   * Scoped to one attempt: did the handshake run out its deadline? The one ending where this side
   * closed the socket on purpose; the relay's `paired: true` describes the rendezvous, not either machine.
   */
  let stalledThisAttempt = false
  /** Scoped to one session: has anything from the far end ever decrypted? */
  let confirmed = false
  /**
   * Scoped to one session: has the silence outlasted `LINK_QUIET_AFTER_MS`? Held because it is the
   * crossing that has to be announced; a reader is only handed a link when something changes.
   */
  let quiet = false
  /** When that happened, so a session can be asked how long it lasted. */
  let confirmedAt: number | undefined
  /** Streams this side opened on the teammate, by subscription id. */
  const routes = new Map<string, (event: unknown, sequence: number) => void>()
  /** Events for a subscription whose answer has not landed yet, in order. */
  const unrouted = new Map<string, Unrouted>()
  /**
   * Streams refused a hold, and how much went with the refusal. A tally, no events: without it
   * `route` had no entry, no `elided`, and a watcher quietly missing the head of the pane.
   * Bounded by the same number, because the far end chooses how many stream ids exist.
   */
  const overflowed = new Map<string, { lost: number; lostAt: number; opened: TimedWindow }>()
  let cancelPresenceRoute: (() => void) | undefined
  let connection: RelayConnection | undefined
  let session: PeerSession | undefined
  let transport: PeerTransport | undefined
  let cancelTimer: (() => void) | undefined
  let cancelKeepalive: (() => void) | undefined
  let cancelSilenceDeadline: (() => void) | undefined
  let cancelQuietWatch: (() => void) | undefined
  let cancelHandshakeDeadline: (() => void) | undefined
  let cancelEpochWatch: (() => void) | undefined
  /** The most recently armed deadline, kept so a closure can be asked about it. */
  let outstanding: TimedWindow | undefined

  const snapshot = (): PeerLinkStatus => {
    const status: PeerLinkStatus = {
      publicKey: options.remotePublicKey,
      handle: options.handle,
      phase,
      since,
      attempts
    }
    if (detail !== undefined) status.detail = detail
    // Only while up and past `LINK_QUIET_AFTER_MS`. The transport's own measurement, on a clock sleep
    // cannot move, turned into a wall-clock stamp here at the instant the two agree: the sidebar
    // ticks on its own clock and is only handed a link when something changes.
    if (quiet && transport) status.lastHeardAt = options.scheduler.now() - transport.quietForMs
    return status
  }

  const moveTo = (next: PeerLinkPhase, nextDetail?: string): void => {
    if (phase === next && detail === nextDetail) return
    phase = next
    detail = nextDetail
    since = options.scheduler.now()
    options.onStatusChange(snapshot())
  }

  /**
   * What this link can say while nobody is on the other end. A teammate who was here and stopped
   * wins over the two-rotation diagnosis: that session already proved the clock and the relay file.
   */
  const waitingDetail = (): string => {
    if (heardThenSilent) return SILENT_PEER_DETAIL
    if (rolloversWaiting >= WAITING_EPOCHS_BEFORE_DIAGNOSIS) return WAITING_TOO_LONG_DETAIL
    // Under the two-rotation diagnosis: rotations are only counted while this machine is awake.
    if (sleptWithoutAnswer) return WOKE_DETAIL
    return WAITING_DETAIL
  }

  /**
   * A one-shot that knows whether this process ran through its own wait. Every deadline that could
   * end in a sentence about the teammate is armed here: a socket dying on wake is a lid closing here.
   */
  const setDeadline = (delayMs: number, run: (interrupted: boolean) => void): (() => void) => {
    const window = startTimedWindow(options.scheduler, delayMs)
    outstanding = window
    return options.scheduler.setTimer(
      () => {
        // A window that has had its answer would otherwise go on ageing and look like a sleep later.
        if (outstanding === window) outstanding = undefined
        run(window.wasInterrupted())
      },
      Math.max(1, delayMs)
    )
  }

  const clearTimers = (): void => {
    cancelTimer?.()
    cancelKeepalive?.()
    cancelSilenceDeadline?.()
    cancelQuietWatch?.()
    cancelHandshakeDeadline?.()
    cancelEpochWatch?.()
    outstanding = undefined
    cancelTimer = undefined
    cancelKeepalive = undefined
    cancelSilenceDeadline = undefined
    cancelQuietWatch = undefined
    cancelHandshakeDeadline = undefined
    cancelEpochWatch = undefined
  }

  /**
   * Everything this attempt owns, released in one place. The Noise session is closed rather than
   * dropped: `close` wipes its transport keys.
   */
  const teardown = (reason: string): void => {
    clearTimers()
    cancelPresenceRoute = undefined
    routes.clear()
    unrouted.clear()
    overflowed.clear()
    transport?.close(reason)
    transport = undefined
    session?.close()
    session = undefined
    connection?.close()
    connection = undefined
  }

  /** Identical for every handshake failure, whatever it actually was. */
  const dropSilently = (): void => {
    // 1000 with no reason: the peer cannot tell "not on the roster" from "wrong machine" from
    // "the relay spliced you to a stranger".
    connection?.close(1000, '')
  }

  const scheduleRetry = (kind: 'immediate' | 'backoff' | 'gave-up'): void => {
    if (!running) return
    const delay =
      kind === 'immediate'
        ? RECONNECT_FLOOR_MS
        : kind === 'gave-up'
          ? STOPPED_RETRY_MS
          : // Full jitter: the whole window rather than a fixed fraction of it, so
            // a relay coming back does not get every link on the team at once.
            Math.max(RECONNECT_FLOOR_MS, Math.round(backoffMs * random()))
    if (kind === 'backoff') backoffMs = Math.min(backoffMs * 2, BACKOFF_CEILING_MS)
    cancelTimer = options.scheduler.setTimer(() => {
      cancelTimer = undefined
      connect()
    }, delay)
  }

  /**
   * This machine came back from somewhere it was not listening. Every belief is a claim about the
   * recent past and a sleep ends the recency of all of it: the verdict is withdrawn, and a new one earned.
   */
  const wake = (): void => {
    if (!running || wakePending) return
    wakePending = true
    sleptWithoutAnswer = true
    // Whatever the deadlines concluded, they were not watching the teammate.
    heardThenSilent = false
    silentThisAttempt = false
    // Nor were the rotations waited through: nobody was here to wait.
    rolloversWaiting = 0
    // Abandoned, not waited on: its close frame may never come, and would belong to an attempt that is over.
    generation += 1
    const abandoned = connection
    connection = undefined
    teardown('this machine was asleep')
    abandoned?.close(1000, '')
    moveTo('connecting', WOKE_DETAIL)
    scheduleRetry('immediate')
  }

  const onClosed = (closure: RelayClosure): void => {
    // A socket does not survive a suspended machine: the close that lands on waking is this
    // machine's sleep, asked before any conclusion about the teammate is drawn.
    if (outstanding?.wasInterrupted() === true) {
      wake()
      return
    }
    const wasConnected = confirmed
    const wasRefused = refusedThisAttempt
    const wasStalled = stalledThisAttempt
    const wasUnauthenticated = unauthenticatedThisAttempt
    const wasRollover = rolledOverThisAttempt
    const wasSilent = silentThisAttempt
    // A session that worked earns the reset. One that confirmed and went inside a keepalive is a
    // shape a peer can repeat at will, and one ended by an unauthenticated frame would put a relay
    // corrupting one frame per session in charge of how often this machine dials.
    const lasted =
      confirmedAt !== undefined &&
      !unauthenticatedThisAttempt &&
      options.scheduler.now() - confirmedAt >= HEALTHY_SESSION_MS
    if (lasted) backoffMs = BACKOFF_START_MS
    teardown('the peer link ended')
    if (!running) return

    // The hour turned under a parked connection: nothing is wrong, the token moved on.
    if (wasRollover) {
      scheduleRetry('immediate')
      return
    }

    // A refusal keeps the reason and backs off: whatever answered will answer again.
    if (wasRefused) {
      scheduleRetry('backoff')
      return
    }

    const policy = reconnectPolicyFor(closure)
    if (policy.kind === 'stop') {
      moveTo('stopped', policy.reason)
      // Looked at again much later: nothing in this process learns a relay was fixed, and
      // `PeerService.reconcile()` skips a linkId it already holds, so this timer is the only revival.
      scheduleRetry('gave-up')
      return
    }
    // A link that got up and then dropped is a teammate gone, not a relay unreachable — "unreachable"
    // would send somebody to check their own network. A silent machine dropped nothing: its socket is open.
    if (wasSilent) moveTo('waiting', SILENT_PEER_DETAIL)
    // `waiting`, not `refused`: that phase is a handshake that did not complete, and this one ran.
    else if (wasUnauthenticated) moveTo('waiting', UNAUTHENTICATED_DETAIL)
    // Before the `paired` branch: a rendezvous that paired and carried nothing is not somebody hanging up.
    else if (wasStalled) moveTo('waiting', HANDSHAKE_STALLED_DETAIL)
    else if (wasConnected || closure.paired) moveTo('waiting', 'your teammate’s machine dropped the connection')
    else moveTo('unreachable', closure.reason || 'the relay could not be reached')
    // A session that confirmed and went straight away is somebody else choosing how often this
    // machine dials, whatever code ended it: it backs off like a failure until one lasts.
    scheduleRetry(wasConnected && !lasted ? 'backoff' : policy.kind)
  }

  const runHandshake = (initiator: boolean, token: string): void => {
    // Always passed: an empty prologue authenticates two keys and says nothing about what they discuss.
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
          // Only the holder of that one key could have computed this rendezvous.
          isAuthorisedPeer: (candidate) => Buffer.from(candidate).toString('base64') === options.remotePublicKey
        })

    cancelHandshakeDeadline = setDeadline(HANDSHAKE_TIMEOUT_MS, (interrupted) => {
      cancelHandshakeDeadline = undefined
      // A handshake slept through was never given its fifteen seconds.
      if (interrupted) {
        wake()
        return
      }
      // Covers the unconfirmed window too: a replayer completes the handshake and, having no keys,
      // can never say anything; this is what ends that session.
      if (confirmed) return
      // Recorded before the socket goes: the close comes back through `onClosed` with
      // `paired: true` and would otherwise read as the teammate hanging up.
      stalledThisAttempt = true
      // Says nothing to the peer, for the same reason a rejection says nothing.
      dropSilently()
    })

    if (initiator) {
      try {
        connection?.send(session.writeHandshakeMessage())
      } catch (error) {
        rejectHandshake(localReason(error))
      }
    }
  }

  /**
   * Armed once, re-armed only if it fires early. Re-arming per decrypted frame would churn a timer
   * per frame of a build log; folding it into the keepalive tick would put detection anywhere in
   * a two-minute window after the deadline passed.
   */
  const armSilenceDeadline = (delayMs: number): void => {
    cancelSilenceDeadline = setDeadline(delayMs, (interrupted) => {
      cancelSilenceDeadline = undefined
      const active = transport
      if (!active) return
      // A window this process did not run through measured this machine's sleep, not their silence.
      if (interrupted) {
        wake()
        return
      }
      const quietFor = active.quietForMs
      if (quietFor < SILENCE_TIMEOUT_MS) {
        armSilenceDeadline(SILENCE_TIMEOUT_MS - quietFor)
        return
      }
      silentThisAttempt = true
      heardThenSilent = true
      // The same silence a rejection gets: there is nobody on the far end to tell.
      connection?.close(1000, '')
    })
  }

  /**
   * When the silence becomes worth a number, on the same re-arming one-shot as the deadline: the
   * point of "last heard 3m ago" is that it is 3m. Once fired there is nothing left to find — the
   * reader adds the growth from a timestamp — so the frame that ends the silence re-arms it.
   */
  const armQuietWatch = (delayMs: number): void => {
    cancelQuietWatch = setDeadline(delayMs, (interrupted) => {
      cancelQuietWatch = undefined
      const active = transport
      if (!active) return
      // "Last heard 4m ago" is a sentence about the teammate, so it is owed the same check as every
      // other deadline here.
      if (interrupted) {
        wake()
        return
      }
      const quietFor = active.quietForMs
      if (quietFor < LINK_QUIET_AFTER_MS) {
        armQuietWatch(LINK_QUIET_AFTER_MS - quietFor)
        return
      }
      quiet = true
      // Not through `moveTo`: the phase has not moved and must not appear to have.
      options.onStatusChange(snapshot())
    })
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
   * Lets go of every hold that has outlived the call it was waiting for — both maps, since nothing
   * else removes either once its subscribe answer has failed to arrive.
   */
  const expireHolds = (): void => {
    for (const [stream, held] of unrouted) {
      if (held.opened.elapsedMs() >= UNROUTED_HOLD_MS) unrouted.delete(stream)
    }
    for (const [stream, held] of overflowed) {
      if (held.opened.elapsedMs() >= UNROUTED_HOLD_MS) overflowed.delete(stream)
    }
  }

  /**
   * Counts output this link will never hand over. Bounded like the holds it stands in for, oldest
   * out first: what somebody is waiting to see is the newest thing.
   */
  const tally = (stream: string, event: unknown, sequence: number): void => {
    let counted = overflowed.get(stream)
    if (!counted) {
      if (overflowed.size >= MAX_UNROUTED_STREAMS) {
        expireHolds()
        const oldest = [...overflowed.keys()][0]
        if (overflowed.size >= MAX_UNROUTED_STREAMS && oldest !== undefined) overflowed.delete(oldest)
      }
      counted = { lost: 0, lostAt: sequence, opened: startTimedWindow(options.scheduler) }
      overflowed.set(stream, counted)
    }
    counted.lost += outputBytes(event)
  }

  const deliver = (stream: string, event: unknown, sequence: number): void => {
    const route = routes.get(stream)
    if (route) {
      route(event, sequence)
      return
    }
    let held = unrouted.get(stream)
    if (!held) {
      // Holds older than a call may take are not waiting any more: that call has already been failed.
      // Dropped here rather than on a timer, because this is the only moment the room is needed.
      if (unrouted.size >= MAX_UNROUTED_STREAMS) expireHolds()
      if (unrouted.size >= MAX_UNROUTED_STREAMS) {
        // Still full of streams that may yet be claimed, so no buffer — but counted, because it is
        // owed the same `elided` the event bound below writes.
        tally(stream, event, sequence)
        return
      }
      held = { events: [], lost: 0, lostAt: 0, opened: startTimedWindow(options.scheduler) }
      unrouted.set(stream, held)
    }
    if (held.events.length >= MAX_UNROUTED_EVENTS) {
      const dropped = held.events.shift()
      if (dropped !== undefined) {
        // The oldest, because the newest output is what somebody is waiting to see — the same trade
        // the owner's pacer makes, counted in the same units.
        if (held.lost === 0) held.lostAt = dropped.sequence
        held.lost += outputBytes(dropped.event)
      }
    }
    held.events.push({ event, sequence })
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
    // Whatever came in before the answer, in order, each still carrying where it came in: the first
    // bytes of a live pane must not be the ones lost to the round trip that asked for them.
    const held = unrouted.get(subscription)
    // A stream refused a buffer still knows what it cost: nothing to replay, but saying so is not nothing.
    const lost = held ?? overflowed.get(subscription)
    unrouted.delete(subscription)
    overflowed.delete(subscription)
    // In front of what outlived it, carrying the sequence of the first frame dropped, so a reader
    // joining by frame order places the hole where it happened.
    if (lost !== undefined && lost.lost > 0) onEvent({ type: 'elided', bytes: lost.lost }, lost.lostAt)
    for (const { event, sequence } of held?.events ?? []) onEvent(event, sequence)
    return () => {
      routes.delete(subscription)
    }
  }

  /**
   * Key confirmation: a transport message from the far end that authenticated. The moment a peer
   * stops being a handshake that parsed and starts being somebody who holds the private key.
   */
  const confirm = (): void => {
    if (confirmed || !transport) return

    // Belt and braces over what `IK` guarantees: the authenticated key is the key we dialled. Here
    // rather than at `established` because the session will not name a peer that has not yet
    // proved it holds the private half, and that proof is the frame that just decrypted.
    const active = session
    if (!active) return
    if (Buffer.from(active.remoteStaticPublicKey()).toString('base64') !== options.remotePublicKey) {
      rejectHandshake('the handshake authenticated a different key than the one this link dialled')
      return
    }

    confirmed = true
    confirmedAt = options.scheduler.now()
    // Somebody is there now, which is the only thing that retires what a sleep left unknown.
    sleptWithoutAnswer = false
    // Now, not at `establish`: the deadline's job is the unconfirmed window, which just closed.
    cancelHandshakeDeadline?.()
    cancelHandshakeDeadline = undefined
    moveTo('connected')
    // One subscription for the life of the link. It answers immediately, so no first read races the stream.
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
    // The deadline is deliberately left running: cancelling it here would leave a replayed session
    // holding a rendezvous, kept alive by this side's own keepalive, forever.

    transport = createPeerTransport({
      session: active,
      send: (message) => connection?.send(message),
      dispatch: options.dispatch,
      subscriptions: options.subscriptions,
      connectionId,
      // The first thing this side decrypts is the first proof that somebody holding the key is there.
      onConfirmed: confirm,
      onStreamEvent: (stream, event, sequence) => {
        // Cannot arrive before confirmation — it had to decrypt — but asserted rather than assumed,
        // because a forged snapshot is exactly what a replayer would want.
        if (!confirmed) return
        deliver(stream, event, sequence)
      },
      onWatchChange: options.onWatchersChange,
      ...(options.onRemoteWrite ? { onRemoteWrite: options.onRemoteWrite } : {}),
      ...(options.onRemoteRead ? { onRemoteRead: options.onRemoteRead } : {}),
      scheduler: options.scheduler,
      onFatal: (failure) => {
        // A Noise stream with a hole in it is over. Recorded before the close, because the close
        // re-enters `onClosed` where `confirmed` and `paired` are both true and the answer would
        // otherwise be "your teammate's machine dropped the connection".
        if (failure.kind === 'unauthenticated') unauthenticatedThisAttempt = true
        connection?.close(1000, '')
      },
      onError: options.onError
    })

    // Deliberately NOT `connected` yet: nothing has yet shown that anyone is there.
    cancelKeepalive = repeat(setDeadline, KEEPALIVE_MS, (interrupted) => {
      // The most frequent deadline on a healthy link, so the one that notices a sleep soonest.
      if (interrupted) {
        wake()
        return
      }
      transport?.keepalive()
    })
    // The half of the keepalive neither relay host supplies: this is what requires one to come back.
    armSilenceDeadline(SILENCE_TIMEOUT_MS)
    // The transport opens its quiet window when built, so this starts from the moment the session did.
    armQuietWatch(LINK_QUIET_AFTER_MS)
    // The round trip that confirms the keys; the peer's own keepalive confirms us to them.
    transport.keepalive()
  }

  const connect = (): void => {
    if (!running) return
    attempts += 1
    generation += 1
    const mine = generation
    /** Whether this attempt still owns the link. See `generation`. */
    const stale = (): boolean => mine !== generation
    refusedThisAttempt = false
    unauthenticatedThisAttempt = false
    stalledThisAttempt = false
    rolledOverThisAttempt = false
    silentThisAttempt = false
    wakePending = false
    confirmed = false
    confirmedAt = undefined
    quiet = false
    // Still true until somebody answers: this machine slept and nothing has been heard since.
    moveTo('connecting', sleptWithoutAnswer ? WOKE_DETAIL : undefined)

    const epoch = epochAt(options.scheduler.now())
    const token = rendezvousToken(secret, options.projectKey, epoch)

    connection = openRelayConnection({
      url: rendezvousUrl(options.relayUrl, token),
      token,
      dial: options.dial,
      events: {
        onWaiting: () => {
          if (stale()) return
          moveTo('waiting', waitingDetail())
          // A peer still parked when the hour turns re-registers under the new token
          // (`relay/README.md`). Clocks straddling the boundary do not meet until the lagging one
          // crosses it; teamree does not guess at neighbouring epochs and pair with whoever answers.
          cancelEpochWatch = setDeadline(
            Math.max(1, epochEndsAt(options.scheduler.now()) - options.scheduler.now()),
            (interrupted) => {
              cancelEpochWatch = undefined
              // A rotation is only waited through by a machine awake for it, and the diagnosis
              // sends somebody to check their clock.
              if (interrupted) {
                wake()
                return
              }
              rolledOverThisAttempt = true
              // The only place that knows a whole rotation was spent parked with nobody arriving.
              rolloversWaiting += 1
              connection?.close(1000, '')
            }
          )
        },
        onPaired: ({ initiator }) => {
          if (stale()) return
          cancelEpochWatch?.()
          cancelEpochWatch = undefined
          // Somebody answered here, so whatever the wait was, it was not this.
          rolloversWaiting = 0
          heardThenSilent = false
          // And the screen has to stop saying so: somebody has answered and the two are now agreeing
          // keys, which is what `connecting` means here.
          moveTo('connecting', sleptWithoutAnswer ? WOKE_DETAIL : undefined)
          runHandshake(initiator, token)
        },
        onBinary: (payload) => {
          if (stale()) return
          if (session && session.stage === 'handshake') {
            const outcome = onHandshakeMessage(payload)
            if (outcome.kind === 'rejected') rejectHandshake(outcome.local)
            else establish()
            return
          }
          transport?.receive(payload)
          // The end of a silence is an arrival, not a deadline, so it is noticed here rather than
          // left showing "last heard 4m ago" for a teammate who answered a second ago.
          if (quiet && transport && transport.quietForMs < LINK_QUIET_AFTER_MS) {
            quiet = false
            options.onStatusChange(snapshot())
            armQuietWatch(LINK_QUIET_AFTER_MS)
          }
        },
        onClosed: (closure) => {
          // A socket the link walked away from can still deliver a close about an attempt already over.
          if (stale()) return
          onClosed(closure)
        }
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
    wake,
    call: <M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> =>
      ask(method, params).then((answer) => answer.result),
    callInOrder: ask,
    route
  }
}

/** A repeating timer built from the one-shot seam, so a scheduler and a test only drive one thing. */
function repeat(
  setDeadline: (delayMs: number, run: (interrupted: boolean) => void) => () => void,
  everyMs: number,
  run: (interrupted: boolean) => void
): () => void {
  let cancel: (() => void) | undefined
  let stopped = false
  const arm = (): void => {
    if (stopped) return
    cancel = setDeadline(everyMs, (interrupted) => {
      run(interrupted)
      arm()
    })
  }
  arm()
  return () => {
    stopped = true
    cancel?.()
  }
}

/**
 * The local half of a failure, for this machine's operator. `PeerError` messages come from a frozen,
 * secret-free table, so quoting one cannot quote a key.
 */
function localReason(error: unknown): string {
  if (isPeerError(error)) return `${error.message} (${error.code})`
  return error instanceof Error ? error.message : String(error)
}
