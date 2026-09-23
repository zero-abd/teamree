// The whole wire contract in one file. Control is text, content is binary: the
// relay speaks only text frames and forwards only binary frames, verbatim.

/** Bumped only for a change a v1 peer could not survive. */
export const PROTOCOL_VERSION = 1

/**
 * A rendezvous token is 32 bytes as 64 lowercase hex characters, nothing else:
 * a fixed shape tells the relay operator nothing beyond "these two match".
 */
const RENDEZVOUS_PATTERN = /^[0-9a-f]{64}$/

export function isRendezvousToken(value: unknown): value is string {
  return typeof value === 'string' && RENDEZVOUS_PATTERN.test(value)
}

/** The one frame a peer ever sends the relay. Everything after it is ciphertext. */
export type Hello = { version: number; rendezvous: string }

export type ControlFrame =
  | { t: 'waiting' }
  | { t: 'paired'; session: string; initiator: boolean }
  | { t: 'closing'; code: number; reason: string }
  // Application-level keepalive, allowed any time after the hello: not every
  // host exposes the WebSocket ping, and a peer-driven one need not wake the relay.
  | { t: 'ping' }
  | { t: 'pong' }

/** Exactly what a peer must send to be answered with a pong, byte for byte. */
export const PING_FRAME = '{"t":"ping"}'
export const PONG_FRAME = '{"t":"pong"}'

/**
 * Close codes in the private 4000-4999 range. "Partner left, reconnect now" and
 * "superseded, back off first" must differ, or two reconnecting peers knock each other over forever.
 */
export const CloseCode = {
  /** Absent, late, malformed or wrong-version hello. */
  BadHello: 4000,
  /** The session ended because the other side did. Reconnect immediately. */
  PartnerGone: 4001,
  /** A newer connection claimed this rendezvous. Back off before reconnecting. */
  Superseded: 4002,
  /** This peer stopped reading and the relay will not buffer for it. */
  SlowConsumer: 4003,
  /** Frame or byte rate over the per-connection budget. */
  RateLimited: 4004,
  /** No sign of life past the idle budget. Both halves get it: neither left. */
  Idle: 4005,
  /** Waited for a partner for longer than the pairing budget. */
  PairTimeout: 4006,
  /** The relay is at its connection cap. */
  Capacity: 4007,
  /** A peer sent something the protocol does not allow at that point. */
  Protocol: 4008,
  /** A frame over the size cap. The standard code, so any client understands it. */
  TooLarge: 1009,
  /** The relay is shutting down. Standard "going away" so peers simply return. */
  GoingAway: 1001
} as const

export type HelloResult = { ok: true; hello: Hello } | { ok: false; reason: string }

/** Unknown keys are ignored: the relay must never grow behaviour that depends on frame contents. */
export function parseHello(text: string): HelloResult {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'hello is not JSON' }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'hello is not an object' }
  }
  const record = value as Record<string, unknown>
  if (record.version !== PROTOCOL_VERSION) return { ok: false, reason: 'unsupported protocol version' }
  if (!isRendezvousToken(record.rendezvous)) return { ok: false, reason: 'rendezvous is not 32 hex-encoded bytes' }
  return { ok: true, hello: { version: PROTOCOL_VERSION, rendezvous: record.rendezvous } }
}

export function encodeControl(frame: ControlFrame): string {
  return JSON.stringify(frame)
}
