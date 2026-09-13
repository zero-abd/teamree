// The relay's wire protocol, from the client side. `relay/README.md` is the
// specification and this file agrees with it rather than interpreting it.
//
//   1. Connect to `<relay>/<sha256-of-token>`.
//   2. Send one text frame: {"version":1,"rendezvous":"<64 hex characters>"}.
//   3. Read {"t":"waiting"} until {"t":"paired","session":…,"initiator":…}.
//   4. Every binary frame after that is forwarded verbatim to the partner.
//
// Control is text and content is binary, in both directions, with no
// exceptions. Nothing here ever writes a binary frame that is not a Noise
// message and never reads one as anything but one.
//
// The close codes are the interesting part, because what a client does about
// each is what stops two peers knocking each other over forever. `4001` (your
// partner left) means reconnect now; `4002` (a newer connection claimed this
// rendezvous) means back off first. A client that treated the second as the
// first would reconnect into a displacement, displace its partner in turn, and
// do that for as long as both machines were running.

import { NO_CLOSE_CODE, type RelayDialer, type RelaySocket } from './relaySocket'

/** Bumped only for a change a v1 peer could not survive. Mirrors the relay's. */
export const RELAY_PROTOCOL_VERSION = 1

/**
 * The relay's private-range close codes, as `relay/README.md` tabulates them.
 * Duplicated rather than imported because `relay/` is a separate program with
 * its own package: a peer that agreed with it by sharing a module would only be
 * agreeing with the copy it was built against.
 */
export const RelayCloseCode = {
  BadHello: 4000,
  PartnerGone: 4001,
  Superseded: 4002,
  SlowConsumer: 4003,
  RateLimited: 4004,
  Idle: 4005,
  PairTimeout: 4006,
  Capacity: 4007,
  Protocol: 4008,
  TooLarge: 1009,
  GoingAway: 1001
} as const

/** Exactly the bytes the relay answers with a pong. */
const PING_FRAME = '{"t":"ping"}'

export type RelayConnectionEvents = {
  /** Parked: the socket is up and the partner has not arrived. */
  onWaiting: () => void
  onPaired: (paired: { sessionId: string; initiator: boolean }) => void
  /** One Noise transport message, exactly as the partner framed it. */
  onBinary: (payload: Uint8Array) => void
  /** Terminal and called once. `code` is 0 when the socket never got one. */
  onClosed: (closure: RelayClosure) => void
}

export type RelayClosure = {
  code: number
  reason: string
  /** True once the pair was spliced, so a caller can tell a drop from a refusal. */
  paired: boolean
}

export type RelayConnectionOptions = {
  url: string
  /** 64 lowercase hex characters. The relay accepts no other shape. */
  token: string
  dial: RelayDialer
  events: RelayConnectionEvents
}

export type RelayConnection = {
  /** One Noise transport message. Refused before the pair exists. */
  send: (payload: Uint8Array) => void
  /** An application-level keepalive the relay answers without waking anything. */
  ping: () => void
  close: (code?: number, reason?: string) => void
}

type Phase = 'greeting' | 'waiting' | 'paired' | 'closed'

export function openRelayConnection(options: RelayConnectionOptions): RelayConnection {
  let phase: Phase = 'greeting'
  let socket: RelaySocket | undefined

  const shutDown = (code: number, reason: string): void => {
    if (phase === 'closed') return
    const wasPaired = phase === 'paired'
    phase = 'closed'
    options.events.onClosed({ code, reason, paired: wasPaired })
  }

  socket = options.dial(options.url, {
    onOpen: () => {
      if (phase !== 'greeting') return
      socket?.sendText(JSON.stringify({ version: RELAY_PROTOCOL_VERSION, rendezvous: options.token }))
    },
    onText: (text) => {
      if (phase === 'closed') return
      const frame = parseControl(text)
      if (!frame) return

      switch (frame.t) {
        case 'waiting':
          if (phase === 'greeting') {
            phase = 'waiting'
            options.events.onWaiting()
          }
          return
        case 'paired':
          // A second `paired` on one socket is not a thing the relay does, and
          // acting on it would restart a handshake mid-session.
          if (phase === 'paired') return
          phase = 'paired'
          options.events.onPaired({ sessionId: frame.session, initiator: frame.initiator })
          return
        default:
          // `pong` and `closing` are advisory. A relay that lied in one could at
          // worst tear the session down, which it can do by hanging up anyway.
          return
      }
    },
    onBinary: (payload) => {
      // Content before the splice exists is not content: the relay forwards
      // nothing until both halves are there, so this can only be noise.
      if (phase !== 'paired') return
      options.events.onBinary(payload)
    },
    onClosed: (code, reason) => shutDown(code, reason)
  })

  return {
    send: (payload) => {
      if (phase !== 'paired') return
      socket?.sendBinary(payload)
    },
    ping: () => {
      if (phase === 'closed') return
      socket?.sendText(PING_FRAME)
    },
    close: (code = 1000, reason = '') => {
      socket?.close(code, reason)
      // Not reported here: the socket's own close event is what ends this, so
      // reporting now would deliver `onClosed` twice for one closure.
    }
  }
}

type ControlFrame =
  | { t: 'waiting' }
  | { t: 'paired'; session: string; initiator: boolean }
  | { t: 'pong' }
  | { t: 'closing' }

/** Anything that is not a frame this client acts on becomes undefined, not a throw. */
function parseControl(text: string): ControlFrame | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>

  if (record.t === 'waiting') return { t: 'waiting' }
  if (record.t === 'pong') return { t: 'pong' }
  if (record.t === 'closing') return { t: 'closing' }
  if (record.t === 'paired' && typeof record.session === 'string' && typeof record.initiator === 'boolean') {
    return { t: 'paired', session: record.session, initiator: record.initiator }
  }
  return undefined
}

export type ReconnectPolicy =
  /** Come back at once: the partner left and the relay is fine. */
  | { kind: 'immediate' }
  /** Come back after a backoff, which grows while the cause persists. */
  | { kind: 'backoff' }
  /**
   * Stop dialling and say why: something is wrong that reconnecting cannot fix.
   *
   * Not "never again". Every condition that lands here is about the relay, and
   * a relay is restarted, rolled back and upgraded without this app hearing
   * about it, so the link looks once more after a long wait. See
   * `STOPPED_RETRY_MS` in `peerLink.ts`, which is where that wait lives because
   * that is where the timer is.
   */
  | { kind: 'stop'; reason: string }

/**
 * What to do about each way a relay connection can end.
 *
 * The table is `relay/README.md`'s "What a client should do" column, and the
 * one place a disagreement with the relay would show up as two peers fighting.
 */
export function reconnectPolicyFor(closure: RelayClosure): ReconnectPolicy {
  switch (closure.code) {
    case RelayCloseCode.PartnerGone:
      return { kind: 'immediate' }
    case RelayCloseCode.Superseded:
      // The newcomer is already parked on this rendezvous, so backing off is
      // both what the relay asks for and what makes the next attempt pair on
      // its first try instead of displacing the peer that just arrived.
      return { kind: 'backoff' }
    case RelayCloseCode.PairTimeout:
    case RelayCloseCode.Idle:
    case RelayCloseCode.GoingAway:
    case RelayCloseCode.SlowConsumer:
      return { kind: 'immediate' }
    case RelayCloseCode.RateLimited:
    case RelayCloseCode.Capacity:
      return { kind: 'backoff' }
    case RelayCloseCode.BadHello:
      return { kind: 'stop', reason: 'the relay refused this client’s greeting; it may speak a newer protocol' }
    case RelayCloseCode.Protocol:
      // Both halves, because this end cannot tell them apart. The relay sends
      // 4008 for a frame it would not accept, and also when it cannot find the
      // other socket in its own pairing table — which is a condition inside the
      // relay that this client had no part in. Naming only the first would put
      // an operator to work looking for a bug on the wrong machine.
      return {
        kind: 'stop',
        reason:
          'the relay refused this connection; that is either a frame this client sent or its own record of the pairing'
      }
    case RelayCloseCode.TooLarge:
      return { kind: 'stop', reason: 'the relay refused a frame as too large' }
    case NO_CLOSE_CODE:
      return { kind: 'backoff' }
    default:
      // An ordinary 1000, or a code from a relay newer than this client. Both
      // are "try again in a moment" rather than "give up".
      return { kind: 'backoff' }
  }
}
