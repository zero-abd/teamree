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
 * One stream's frames waiting for whoever asked for them, and what did not fit.
 *
 * The bound below is a bound and has to stay one, so a hold that runs long
 * enough throws output away. `lost` is what that cost, in bytes, and `lostAt` is
 * the frame it started at — the two things an `elided` is made of.
 */
type Unrouted = {
  events: HeldEvent[]
  lost: number
  lostAt: number
  /**
   * How long this stream has been waiting for somebody to claim it.
   *
   * Measured rather than stamped, and measured on a clock a sleeping machine
   * cannot move, for the same reason every other deadline in this file is. See
   * `elapsed.ts`.
   */
  opened: TimedWindow
}

/** A quiet pair still has to say something, or the relay's idle deadline ends it. */
export const KEEPALIVE_MS = 120_000

/**
 * How long a confirmed link may hear nothing at all before it is over.
 *
 * Two and a half keepalives. A healthy peer's frames arrive one keepalive
 * apart, so a single lost keepalive leaves a two-interval gap and must not end
 * anything; two lost in a row leaves three, and a link losing two in a row is
 * not a link. The half is the margin between those two numbers, and it is the
 * whole reason this is not simply twice: a deadline sitting exactly on the
 * one-loss gap would tear down healthy links on ordinary scheduling jitter.
 *
 * This is the only liveness deadline teamree has of its own, and it has to be,
 * because neither relay supplies one on the path `relay/README.md` recommends.
 * The Worker host cannot send a protocol ping from a Durable Object, and its
 * idle timer is defeated by this very keepalive: the surviving peer's frames
 * refresh the sleeping peer's idle clock. So `phase === 'connected'` means
 * "something from them decrypted recently" or it means nothing at all.
 */
export const SILENCE_TIMEOUT_MS = KEEPALIVE_MS * 2.5

/**
 * What a link can honestly say when it has heard nothing for that long.
 *
 * Never "they closed the connection": the socket is still open, which is
 * exactly the case this deadline exists for. What is known is that this side
 * went on sending and nothing came back.
 */
export const SILENT_PEER_DETAIL = 'your teammate’s machine stopped answering'

/**
 * How long a confirmed link may hear nothing before the window is told the age
 * of that silence.
 *
 * One and a half keepalives, and the half is the whole of the argument. One
 * interval is what an ordinary gap *is* — a healthy peer's frames arrive
 * exactly that far apart — so the threshold has to sit past it or every link
 * on the team announces a silence in the instant before each keepalive lands,
 * on nothing but scheduling jitter and a round trip. The half is the same
 * margin `SILENCE_TIMEOUT_MS` puts between the one-loss gap and the two-loss
 * gap, borrowed here for the same reason, and it would take sixty seconds of
 * drift to cross.
 *
 * It sits beside the interval it is derived from rather than wherever the age
 * gets drawn, so there is one threshold in the app and not two that can stop
 * agreeing. Between it and the deadline above there are two minutes: a reader
 * sees `3m`, then `4m`, and then the link is over and says so instead. Those
 * minutes used to read as `connected` and nothing else, which was the residue
 * of the lie the deadline shortened.
 */
export const LINK_QUIET_AFTER_MS = KEEPALIVE_MS * 1.5

/**
 * What the same deadline may say when this machine is the one that was away.
 *
 * A lid closed here suspends the timers and steps the wall clock, so the
 * deadline fires on wake having measured a silence nobody on the other end
 * caused — the sentence above, pointed at the wrong machine. `elapsed.ts`
 * tells the two apart, and this is what is left when it does: not that the
 * teammate is fine, which this side cannot know either, but that whatever was
 * known about them expired while nobody was listening. The link re-establishes
 * and the rows it was showing go stale and dated in the meantime.
 */
export const WOKE_DETAIL = 'this machine was asleep, so nothing is known about your teammate until this link is back'

/**
 * What a frame that does not authenticate is, and what it is not.
 *
 * A Noise transport frame is authenticated by keys only the two machines hold,
 * so one that fails to open means what arrived is not what was sent under that
 * session — a bit changed, a frame replayed, dropped or reordered. The relay is
 * the one thing between the two sockets and the one thing this project's threat
 * model says not to trust, and this is the only symptom it has.
 *
 * It used to arrive on screen as "your teammate's machine dropped the
 * connection", which is the sentence for a socket that closed and names the
 * only party here nothing has been established about. What is known is what
 * this says: something did not survive the trip.
 */
export const UNAUTHENTICATED_DETAIL =
  'a message did not authenticate, so the frames did not reach this machine as your teammate sent them'

/**
 * How long a link that has given up waits before looking again.
 *
 * Three close codes mean something a reconnect cannot fix: the relay refused
 * this client's greeting, refused a frame, or refused one as too large. The
 * link says so and stops dialling, which is right — and it used to stop for
 * ever, which is not. Nothing revived it: `PeerService.reconcile()` skips a
 * link it already holds on an unchanged relay, so a teammate lost this way was
 * lost until the app was restarted.
 *
 * None of the three is actually permanent. A relay gets restarted, rolled back
 * and upgraded without this app hearing about it, and `4008` in particular is
 * sent both for a frame this client got wrong and for the relay failing to
 * find the other socket in its own pairing table — a condition this end had no
 * part in and no way to tell apart from the other. So the link looks again,
 * rarely: far enough apart to cost a relay that means it nothing, close enough
 * that somebody who fixes the relay does not also have to tell everyone on the
 * team to restart.
 */
export const STOPPED_RETRY_MS = 300_000

/**
 * What a pairing that never became a session is, and what it is not.
 *
 * The relay splices two sockets and then the frames stop: a replayer holding a
 * recording, a relay that pairs and forwards nothing, a middle that drops. The
 * handshake deadline expires and this side closes its own socket to end it —
 * and that close arrives back at `onClosed` carrying `paired: true`, which used
 * to come out as "your teammate's machine dropped the connection". Nobody hung
 * up. This end gave up on a conversation that never started, and the teammate
 * may well be sitting there paired, waiting for the same frames.
 */
export const HANDSHAKE_STALLED_DETAIL = 'your teammate’s machine was reached but the two never finished connecting'

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

/**
 * What waiting means before anything is odd about it.
 *
 * Only what this side can see. Two people who committed different relay URLs,
 * or whose clocks are more than an hour apart, each wait here while the other
 * machine is perfectly connected — to somewhere else — so a line asserting
 * their machine is not connected is a diagnosis this client cannot make. The
 * long form below names the two things that are checkable; the short form says
 * the one thing that is known.
 */
export const WAITING_DETAIL = 'nobody has answered on this rendezvous yet'

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
  'who stepped out. Two things can be checked from here: that both machines agree about the time, because ' +
  'the rendezvous changes on the hour and teamree will not pair across two of them, and that .teamree/relay ' +
  'names the same relay on both.'

/**
 * How much of a stream is held while its own subscribe answer is still in
 * flight.
 *
 * A subscription's first events can beat the response that names it: the far
 * side attaches the stream inside the handler, and a pane already printing
 * writes frames behind the answer rather than after it. The window is one round
 * trip, so these are generous; they are bounds rather than a capacity, and a
 * stream nobody ever claims cannot grow without limit.
 *
 * Reaching the event bound throws output away, and that is said rather than
 * done quietly: the frames that survive are handed over behind an `elided`
 * carrying what went, the same event the owner's own pacer writes when its
 * buffer overruns, because it is the same fact — output the pane printed and
 * this side will never show. A relay that stalls and then hands over a fat
 * batch is exactly the shape that reaches this, and it reaches it in one
 * synchronous run of frames, before the continuation that would have attached
 * the route has had a turn.
 */
export const MAX_UNROUTED_STREAMS = 16
export const MAX_UNROUTED_EVENTS = 256

/**
 * How long an unclaimed stream may hold one of those slots.
 *
 * The window a hold is for is one round trip, and `PEER_CALL_TIMEOUT_MS` is the
 * longest a round trip is allowed to be: past it the call that would have
 * claimed this stream has already been failed, so nothing is coming for it.
 *
 * Without this the only thing that ever removed an entry was `route`, and
 * `route` is only reached when the subscribe answer that names the stream comes
 * back. A `terminal.subscribe` that times out never learns its id, never routes
 * and never unsubscribes: the far side goes on streaming that pane for the life
 * of the link, and the entry keeps its slot for the life of the link too.
 * Sixteen of those and every later stream loses its head.
 */
export const UNROUTED_HOLD_MS = PEER_CALL_TIMEOUT_MS

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
  /**
   * A clock this machine going to sleep cannot move. Defaults to
   * `performance.now()`.
   *
   * Every deadline that could end in a sentence about somebody else's machine
   * is measured against this, and the disagreement between it and `now` is how
   * a slept machine is told from a silent teammate. See `elapsed.ts`.
   */
  monotonicNow?: () => number
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
  /**
   * Called whenever the phase, its detail, or the age of the link's silence
   * changes — never on a repeat.
   *
   * The third of those is why this is not simply "the phase changed". Nobody
   * downstream re-reads a link on a timer, so a status that is never sent is a
   * status that is never drawn, and both the moment silence becomes worth
   * saying and the moment it stops being are changes a reader has to be told
   * about.
   */
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
   * This machine was asleep: whatever was believed about the teammate expired
   * while nobody was listening, so believe nothing and go and find out.
   *
   * Called by the link itself when a deadline comes back from a window this
   * process did not run through, and by the service when the operating system
   * says the machine resumed. Both mean the same thing, and doing it twice for
   * one wake costs nothing.
   */
  wake: () => void
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
  /** Scoped to one attempt: did this side end it because nothing was coming back? */
  let silentThisAttempt = false
  /**
   * Rotations waited through since anybody was last on the other end. Not per
   * attempt: it is the whole point that it survives the reconnect each rollover
   * causes, and it is cleared by somebody arriving rather than by time passing.
   */
  let rolloversWaiting = 0
  /**
   * Whether the last session this link had ended in silence rather than a close.
   *
   * Not per attempt, for the same reason `rolloversWaiting` is not: what it
   * changes is what the *wait* means afterwards. A rendezvous nobody has ever
   * answered and a rendezvous a teammate answered an hour ago and then went
   * quiet on are two different sentences, and only the second one has already
   * ruled out the clock and the relay file. Cleared by somebody arriving.
   */
  let heardThenSilent = false
  /**
   * Whether this machine has slept since it last confirmed anybody.
   *
   * Cleared by confirming, not by connecting: until a frame from the teammate
   * decrypts again, the truthful thing to say about them is that this side was
   * not there to hear.
   */
  let sleptWithoutAnswer = false
  /** A wake already has a reconnect coming; a second signal for it is not two. */
  let wakePending = false
  /**
   * Which attempt owns the socket. Events from an abandoned one are not this
   * link's business — waking abandons a socket whose close is still in flight.
   */
  let generation = 0
  /**
   * Scoped to one attempt: did this session end on a frame that did not
   * authenticate?
   *
   * Kept apart from `refusedThisAttempt` because it answers a second question —
   * whether this session counts as one that worked. A session broken by
   * something between the two machines did not work, however long it ran.
   */
  let unauthenticatedThisAttempt = false
  /**
   * Scoped to one attempt: did the handshake run out its deadline?
   *
   * A pairing that never became a session. Separate from every other reason a
   * socket ends because it is the one where the socket was closed *by this
   * side*, on purpose, and the relay's `paired: true` on the way out describes
   * the rendezvous rather than anything either machine did.
   */
  let stalledThisAttempt = false
  /** Scoped to one session: has anything from the far end ever decrypted? */
  let confirmed = false
  /**
   * Scoped to one session: has the silence outlasted `LINK_QUIET_AFTER_MS`?
   *
   * Held rather than worked out when the status is read, because it is the
   * *crossing* that has to be announced. A reader who is only ever handed a
   * link when something about it changes would otherwise go on showing the
   * last thing it was handed.
   */
  let quiet = false
  /** When that happened, so a session can be asked how long it lasted. */
  let confirmedAt: number | undefined
  /** Streams this side opened on the teammate, by subscription id. */
  const routes = new Map<string, (event: unknown, sequence: number) => void>()
  /** Events for a subscription whose answer has not landed yet, in order. */
  const unrouted = new Map<string, Unrouted>()
  /**
   * Streams that were refused a hold, and how much of them went with the
   * refusal.
   *
   * A tally and nothing else: no events, so a stream here costs a number rather
   * than a buffer. It exists because the bound above used to be enforced by
   * dropping the frames and writing nothing down, which left `route` with no
   * entry, no `elided`, and a watcher quietly missing the head of the pane it
   * had just asked for — the one thing the event bound beside it is careful not
   * to do.
   *
   * Bounded like everything else fed from the wire, and by the same number,
   * because the far end chooses how many stream ids exist.
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
    // Only while the link is up, and only once the silence has outlasted
    // `LINK_QUIET_AFTER_MS`. The length of the silence is the transport's own
    // measurement — the one the deadline reads, so the window and the teardown
    // quote one number — and it is measured on a clock this machine going to
    // sleep cannot move.
    //
    // It reaches the window as a stamp rather than as that length because the
    // sidebar ticks on its own clock and is only handed a link when something
    // about it changes: an age it works out for itself goes on being right
    // while nothing is sent to it again. Subtracting a monotonic duration from
    // the wall clock *now* is what turns one into the other, and it is done
    // here, at the instant the two agree, rather than by keeping a wall-clock
    // stamp from before a sleep that would have aged by the whole of it.
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
   * What this link can say for itself while nobody is on the other end.
   *
   * A teammate who was here and stopped is not a rendezvous nobody has found,
   * so that reading wins over the two-rotation diagnosis: the clock and the
   * relay file are exactly what `WAITING_TOO_LONG_DETAIL` sends somebody to
   * check, and a session that ran on this rendezvous has already proved both.
   */
  const waitingDetail = (): string => {
    if (heardThenSilent) return SILENT_PEER_DETAIL
    if (rolloversWaiting >= WAITING_EPOCHS_BEFORE_DIAGNOSIS) return WAITING_TOO_LONG_DETAIL
    // Under the two-rotation diagnosis, because rotations are only counted
    // while this machine is awake to wait through them, and above the ordinary
    // wait, because "nobody has answered yet" omits the part this side did.
    if (sleptWithoutAnswer) return WOKE_DETAIL
    return WAITING_DETAIL
  }

  /**
   * A one-shot that knows whether this process ran through its own wait.
   *
   * Every deadline that could end in a sentence about the teammate is armed
   * through here, so the answer is available both to the deadline itself and to
   * whatever else has to interpret an event that arrived alongside it — a
   * socket dying on wake, most of all, which is a lid closing here and not a
   * teammate leaving.
   */
  const setDeadline = (delayMs: number, run: (interrupted: boolean) => void): (() => void) => {
    const window = startTimedWindow(options.scheduler, delayMs)
    outstanding = window
    return options.scheduler.setTimer(
      () => {
        // A window that has had its answer is not evidence any more: left
        // standing, it would go on ageing past the wait it was armed for and
        // eventually look like a sleep to anything that asked it later. `run`
        // arms the next one.
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
    // 1000 with no reason: the peer learns that the connection ended and gets
    // no help telling "not on the roster" from "wrong machine" from "the relay
    // spliced you to a stranger".
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
   * This machine came back from somewhere it was not listening.
   *
   * Everything a link believes is a claim about the recent past, and a sleep
   * ends the recency of all of it at once: the session's keys are as old as the
   * sleep, the socket is probably a corpse the TCP stack has not noticed, and
   * the last frame that decrypted arrived before any of it. So the verdict is
   * not "silent" and not "fine" — it is withdrawn, and the link goes and earns
   * a new one.
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
    // The socket is abandoned rather than closed and waited on: its close frame
    // may never come, and if it does it belongs to an attempt that is over.
    generation += 1
    const abandoned = connection
    connection = undefined
    teardown('this machine was asleep')
    abandoned?.close(1000, '')
    moveTo('connecting', WOKE_DETAIL)
    scheduleRetry('immediate')
  }

  const onClosed = (closure: RelayClosure): void => {
    // A socket does not survive a suspended machine, and the close that lands
    // on waking is this machine's sleep arriving as news about somebody else's.
    // Asked before anything is concluded, because every conclusion below is a
    // sentence about the teammate.
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
    // A session that worked earns the reset; one that confirmed and went inside
    // a keepalive does not, because that is the shape a peer can repeat at will.
    //
    // Nor does one that ended on a frame that did not authenticate, whatever
    // the clock says about its length: forgiving those puts a relay that
    // corrupts one frame per session in charge of how often this machine
    // dials, which is a fresh handshake a second, per link, for as long as it
    // cares to keep doing it.
    const lasted =
      confirmedAt !== undefined &&
      !unauthenticatedThisAttempt &&
      options.scheduler.now() - confirmedAt >= HEALTHY_SESSION_MS
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
      // Said, and then looked at again a long time later. Every one of these is
      // a fact about the relay, and nothing in this process learns that a relay
      // has been fixed: with no timer here the link was not "stopped" but gone,
      // for as long as the app kept running. `PeerService.reconcile()` does not
      // rebuild it either — it skips a linkId it already holds whose relay URL
      // has not changed — so this timer is the only thing that revives it.
      scheduleRetry('gave-up')
      return
    }
    // A link that got all the way up and then dropped is a teammate whose
    // machine went away, not a relay that cannot be reached: saying
    // "unreachable" there would send somebody to check their own network.
    // And a machine that stopped answering did not drop anything: its socket is
    // still open, which is the whole reason this side had to notice for itself.
    if (wasSilent) moveTo('waiting', SILENT_PEER_DETAIL)
    // `waiting`, like every other way a link that was up stops being one: the
    // session is over, the link is going back to the relay, and what is worth
    // saying is why. Deliberately not `refused` — that phase is a handshake
    // that did not complete, and this handshake completed and ran.
    else if (wasUnauthenticated) moveTo('waiting', UNAUTHENTICATED_DETAIL)
    // Before the `paired` branch, and never reached once a session confirmed:
    // the deadline returns early when it has. A rendezvous that paired and then
    // carried nothing is not somebody hanging up, and the relay saying `paired`
    // is the one thing both of those have in common.
    else if (wasStalled) moveTo('waiting', HANDSHAKE_STALLED_DETAIL)
    else if (wasConnected || closure.paired) moveTo('waiting', 'your teammate’s machine dropped the connection')
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

    cancelHandshakeDeadline = setDeadline(HANDSHAKE_TIMEOUT_MS, (interrupted) => {
      cancelHandshakeDeadline = undefined
      // A handshake this machine slept through was never given its fifteen
      // seconds, and the session it belongs to is as stale as the sleep.
      if (interrupted) {
        wake()
        return
      }
      // Covers the unconfirmed window too: a replayer completes the handshake
      // and then, having no keys, can never say anything. This is what ends
      // that session rather than leaving it holding a slot forever.
      if (confirmed) return
      // Recorded before the socket goes, because the close this causes comes
      // back through `onClosed` carrying `paired: true` and would otherwise be
      // read there as the teammate hanging up. They did not: this end gave up
      // on a conversation that never started.
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
   * The deadline, armed once and re-armed only if it fires early.
   *
   * A one-shot that reads the timestamp and re-arms for whatever is left of the
   * window beats both obvious alternatives. Re-arming on every decrypted frame
   * would churn a timer per frame of a pane printing a build log. Folding the
   * check into the keepalive's own repeating tick — which is what a single
   * timer would mean — would put the moment of detection anywhere in a
   * two-minute window *after* the deadline had already passed, and the whole
   * point of the deadline is that it is a number somebody can reason about.
   */
  const armSilenceDeadline = (delayMs: number): void => {
    cancelSilenceDeadline = setDeadline(delayMs, (interrupted) => {
      cancelSilenceDeadline = undefined
      const active = transport
      if (!active) return
      // A deadline that returns from a window this process did not run through
      // has measured this machine's sleep, not the teammate's silence. Blaming
      // them for it would be this feature's own sentence pointed at the wrong
      // end of the link.
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
      // The same silence a rejection gets, and for a plainer reason: there is
      // nobody on the far end to tell.
      connection?.close(1000, '')
    })
  }

  /**
   * When the silence becomes worth a number, on the same re-arming one-shot the
   * deadline above uses.
   *
   * For the same reason, too: folding this into the keepalive's repeating tick
   * would put the crossing anywhere in the two minutes after it happened, and
   * the point of saying "last heard 3m ago" is that it is 3m. Once it has
   * fired there is nothing left for a timer to find — the silence only grows,
   * and the reader adds the growth itself from a timestamp — so the watch is
   * re-armed by the frame that ends it rather than kept running.
   */
  const armQuietWatch = (delayMs: number): void => {
    cancelQuietWatch = setDeadline(delayMs, (interrupted) => {
      cancelQuietWatch = undefined
      const active = transport
      if (!active) return
      // "Last heard 4m ago" is a sentence about the teammate, so it is owed the
      // same check every other deadline here makes: a window this process did
      // not run through measured this machine's sleep and not their silence.
      // On the far side of a wake there is no age to show, because there is no
      // confirmed link to show it on.
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
      // Said directly rather than through `moveTo`: the phase has not moved
      // and must not appear to have. This is the same connected link, now
      // carrying the age of its own silence.
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
   * One of the teammate's streams, to whoever asked for it.
   *
   * By the id the subscription was answered with, never by the shape of what
   * arrived: a pane's output and a presence snapshot are both just objects, and
   * a link that guessed could be made to guess wrong.
   */
  /**
   * Lets go of every hold that has outlived the call it was waiting for.
   *
   * Both maps, because a tally that is never claimed is as stale as a buffer
   * that is never claimed, and neither of them is ever removed by anything
   * else once its subscribe answer has failed to arrive.
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
   * Counts output this link will never be able to hand over.
   *
   * The tally is bounded like the holds it stands in for, and the oldest goes
   * first for the same reason the oldest *event* goes first: what somebody is
   * waiting to see is the newest thing, and a stream that has been counted
   * without being claimed for longer than a call may take is not going to be.
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
      // Whatever has been sitting here longer than a call may take is not
      // waiting for an answer any more: the call that would have claimed it has
      // already been failed. Dropped here rather than on a timer of its own,
      // because this is the only moment the room is needed.
      if (unrouted.size >= MAX_UNROUTED_STREAMS) expireHolds()
      if (unrouted.size >= MAX_UNROUTED_STREAMS) {
        // Still full of streams that may yet be claimed, so this one gets no
        // buffer — but it does get counted. What it loses is output the pane
        // printed and this side will never show, which is the same fact the
        // event bound below writes down, and it is owed the same `elided`.
        tally(stream, event, sequence)
        return
      }
      held = { events: [], lost: 0, lostAt: 0, opened: startTimedWindow(options.scheduler) }
      unrouted.set(stream, held)
    }
    if (held.events.length >= MAX_UNROUTED_EVENTS) {
      const dropped = held.events.shift()
      if (dropped !== undefined) {
        // The oldest, because the newest output is the output somebody is
        // waiting to see — the same trade the owner's pacer makes, and counted
        // in the same units so the two holes read as one number when they land
        // in the same window.
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
    // Whatever came in before the answer did, in the order it came in, each
    // still carrying where it came in. This is the join a watcher depends on:
    // the first bytes of a live pane must not be the ones lost to the round
    // trip that asked for them, and arriving late here must not make a frame
    // look later than it was.
    const held = unrouted.get(subscription)
    // A stream that was refused a buffer still knows what it cost, and that is
    // the whole reason the tally exists: there is nothing to replay, and saying
    // so is not the same as saying nothing.
    const lost = held ?? overflowed.get(subscription)
    unrouted.delete(subscription)
    overflowed.delete(subscription)
    // In front of what outlived it, because that is where the hole is: what went
    // was in front of everything still here. It carries the sequence of the
    // first frame dropped, so a reader joining by frame order places the hole
    // where it happened rather than at the boundary it happens to be read at.
    if (lost !== undefined && lost.lost > 0) onEvent({ type: 'elided', bytes: lost.lost }, lost.lostAt)
    for (const { event, sequence } of held?.events ?? []) onEvent(event, sequence)
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
    // Somebody is there now, which is the only thing that retires what a sleep
    // left unknown.
    sleptWithoutAnswer = false
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
      onFatal: (failure) => {
        // A Noise stream with a hole in it is over: there is no point it could
        // be picked up from, so the socket goes and the link rebuilds.
        //
        // What the reader is told about it depends on which failure it was, and
        // `onClosed` below is where that is said — the same place every other
        // way a session ends is accounted for. Recorded before the close rather
        // than after it, because the close is what re-enters `onClosed`, where
        // `confirmed` and `paired` are both true and the answer would otherwise
        // be "your teammate's machine dropped the connection": the sentence for
        // a socket that closed, aimed at the only party here nothing has been
        // established about.
        if (failure.kind === 'unauthenticated') unauthenticatedThisAttempt = true
        connection?.close(1000, '')
      },
      onError: options.onError
    })

    // Deliberately NOT `connected` yet, and deliberately not a new phase the
    // user reads: from where they sit this is still connecting, because nothing
    // has yet shown that anyone is there.
    cancelKeepalive = repeat(setDeadline, KEEPALIVE_MS, (interrupted) => {
      // The most frequent deadline on a healthy link, so it is the one that
      // notices a sleep soonest — a keepalive sent into an hour-old socket
      // proves nothing to anybody.
      if (interrupted) {
        wake()
        return
      }
      transport?.keepalive()
    })
    // The other half of that keepalive, and the half neither relay host
    // supplies: sending one costs nothing and proves nothing, so this is what
    // requires one to come back.
    armSilenceDeadline(SILENCE_TIMEOUT_MS)
    // And the part of the same silence that is worth saying out loud before it
    // is fatal. The transport opens its quiet window when it is built, so this
    // starts from the moment the session did.
    armQuietWatch(LINK_QUIET_AFTER_MS)
    // The round trip that confirms the keys, made of a frame the relay's idle
    // deadline wanted anyway. The peer's own keepalive confirms us to them.
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
    // Carried into the reconnect, because it is still true until somebody
    // answers: this machine slept and nothing has been heard since.
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
          // A peer still parked when the hour turns re-registers under the new
          // token, which is what `relay/README.md` says a client does. Two
          // machines whose clocks straddle the boundary do not meet until the
          // lagging one crosses it; teamree does not paper over a wrong clock,
          // and pretending otherwise would mean guessing at neighbouring epochs
          // and pairing with whoever answered.
          cancelEpochWatch = setDeadline(
            Math.max(1, epochEndsAt(options.scheduler.now()) - options.scheduler.now()),
            (interrupted) => {
              cancelEpochWatch = undefined
              // A rotation is only waited through by a machine that was awake
              // for it, and the two-rotation diagnosis sends somebody to check
              // their clock — which a slept machine would deserve and a
              // teammate would not.
              if (interrupted) {
                wake()
                return
              }
              rolledOverThisAttempt = true
              // Counted here rather than where the next one is dialled: this is
              // the only place that knows a whole rotation was spent parked on
              // the relay with nobody arriving.
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
          // And the screen has to stop saying it. "Nobody has answered on this
          // rendezvous yet" was left standing for the whole fifteen seconds of
          // the handshake, contradicted by the relay in the same breath that
          // started it: somebody has answered, and the two are now agreeing
          // keys. That is what `connecting` means here, exactly as it does for
          // the unconfirmed window after the handshake parses.
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
          // The end of a silence is an arrival, not a deadline, so it is
          // noticed here. A window still showing "last heard 4m ago" for a
          // teammate who answered a second ago would be the same untruth this
          // number exists to remove, pointed the other way.
          if (quiet && transport && transport.quietForMs < LINK_QUIET_AFTER_MS) {
            quiet = false
            options.onStatusChange(snapshot())
            armQuietWatch(LINK_QUIET_AFTER_MS)
          }
        },
        onClosed: (closure) => {
          // A socket the link walked away from can still deliver its close, and
          // its reason is about an attempt that is already over.
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

/**
 * A repeating timer built from the one-shot seam, so a scheduler only has to
 * implement one thing and a test only has to drive one thing.
 */
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
