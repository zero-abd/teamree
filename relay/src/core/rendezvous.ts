// The pairing table, and the only place in the relay that decides anything.
// The load-bearing fact behind most rules here: the relay cannot tell the two
// peers apart; both presented the same opaque token, and there is no "side A".

import { CloseCode, type ControlFrame } from './protocol.js'
import { randomHex } from './random.js'

export type Peer = {
  readonly id: string
  /** Forwards a spliced frame. The only path a payload byte ever takes. */
  deliver: (payload: Uint8Array) => void
  /** Bytes already handed to this peer's socket that it has not taken yet. */
  backlog: () => number
  /** Both halves learn of the pairing here; it is how a parked peer becomes willing to carry content. */
  markPaired: (sessionId: string, initiator: boolean) => void
  notify: (frame: ControlFrame) => void
  /** Says why, then closes. Never a bare socket teardown. */
  close: (code: number, reason: string) => void
}

export type JoinOutcome =
  | { status: 'waiting'; pairRef: string; supersededSession: boolean }
  | { status: 'paired'; pairRef: string; sessionId: string }

export type LeaveOutcome = { removed: boolean; endedSession: boolean }

type Entry =
  | { kind: 'waiting'; pairRef: string; peer: Peer; since: number }
  | { kind: 'paired'; pairRef: string; sessionId: string; first: Peer; second: Peer; pairedAt: number }

export type RendezvousStats = { waiting: number; sessions: number }

export class Rendezvous {
  private readonly entries = new Map<string, Entry>()

  // Asked per frame, so a map lookup rather than a scan.
  private readonly partners = new Map<string, Peer>()

  join(token: string, peer: Peer, now: number): JoinOutcome {
    const existing = this.entries.get(token)

    if (existing === undefined) {
      const pairRef = randomHex(6)
      this.entries.set(token, { kind: 'waiting', pairRef, peer, since: now })
      return { status: 'waiting', pairRef, supersededSession: false }
    }

    if (existing.kind === 'waiting') {
      const sessionId = randomHex(8)
      const session: Entry = {
        kind: 'paired',
        pairRef: existing.pairRef,
        sessionId,
        first: existing.peer,
        second: peer,
        pairedAt: now
      }
      this.entries.set(token, session)
      this.partners.set(existing.peer.id, peer)
      this.partners.set(peer.id, existing.peer)
      // The arriving peer initiates: a fixed answer stops both sides opening a handshake at once.
      existing.peer.markPaired(sessionId, false)
      peer.markPaired(sessionId, true)
      return { status: 'paired', pairRef: existing.pairRef, sessionId }
    }

    // A third connection on a live session: a peer back from suspend with a
    // half-open socket, or a stranger; the relay cannot tell. End the session and
    // let the newcomer wait. Both are told "superseded", not "partner left", so
    // their reconnects stagger instead of displacing each other all evening.
    this.dropSession(token, existing)
    const pairRef = randomHex(6)
    this.entries.set(token, { kind: 'waiting', pairRef, peer, since: now })
    existing.first.close(CloseCode.Superseded, 'rendezvous claimed by a newer connection')
    existing.second.close(CloseCode.Superseded, 'rendezvous claimed by a newer connection')
    return { status: 'waiting', pairRef, supersededSession: true }
  }

  // Idempotent; the identity check stops a superseded peer's late close evicting its replacement.
  leave(token: string, peer: Peer): LeaveOutcome {
    const existing = this.entries.get(token)
    this.partners.delete(peer.id)
    if (existing === undefined) return { removed: false, endedSession: false }

    if (existing.kind === 'waiting') {
      if (existing.peer.id !== peer.id) return { removed: false, endedSession: false }
      this.entries.delete(token)
      return { removed: true, endedSession: false }
    }

    if (existing.first.id !== peer.id && existing.second.id !== peer.id) {
      return { removed: false, endedSession: false }
    }

    // A Noise session cannot outlive either transport, so the survivor is told and closed.
    const partner = existing.first.id === peer.id ? existing.second : existing.first
    this.dropSession(token, existing)
    partner.close(CloseCode.PartnerGone, 'partner disconnected')
    return { removed: true, endedSession: true }
  }

  // A relay-decided teardown, both halves given the same reason. `leave` would
  // tell the survivor its partner left, and it would reconnect at once for a fault that never happened.
  endSession(token: string, peer: Peer, code: number, reason: string): boolean {
    const existing = this.entries.get(token)
    if (existing === undefined || existing.kind !== 'paired') return false
    if (existing.first.id !== peer.id && existing.second.id !== peer.id) return false
    // Dropped before either close, so neither re-enters `leave` and tells the other it was abandoned.
    this.dropSession(token, existing)
    existing.first.close(code, reason)
    existing.second.close(code, reason)
    return true
  }

  partnerOf(peer: Peer): Peer | undefined {
    return this.partners.get(peer.id)
  }

  /** Unpaired peers past the parking budget, for the caller to close. */
  expiredWaiters(now: number, pairTimeoutMs: number): Peer[] {
    if (pairTimeoutMs <= 0) return []
    const expired: Peer[] = []
    for (const entry of this.entries.values()) {
      if (entry.kind === 'waiting' && now - entry.since >= pairTimeoutMs) expired.push(entry.peer)
    }
    return expired
  }

  // Puts back a pairing lost to eviction between frames: nobody is told, nothing is minted.
  restore(token: string, peers: readonly Peer[], pairRef: string, sessionId: string | null, since: number): void {
    if (peers.length === 1 && peers[0] !== undefined) {
      this.entries.set(token, { kind: 'waiting', pairRef, peer: peers[0], since })
      return
    }
    const [first, second] = peers
    if (peers.length !== 2 || first === undefined || second === undefined || sessionId === null) return
    this.entries.set(token, { kind: 'paired', pairRef, sessionId, first, second, pairedAt: since })
    this.partners.set(first.id, second)
    this.partners.set(second.id, first)
  }

  // For a host about to close everything itself; otherwise closing the first
  // peer would tell the second its partner had left.
  clear(): void {
    this.entries.clear()
    this.partners.clear()
  }

  stats(): RendezvousStats {
    let waiting = 0
    let sessions = 0
    for (const entry of this.entries.values()) {
      if (entry.kind === 'waiting') waiting += 1
      else sessions += 1
    }
    return { waiting, sessions }
  }

  private dropSession(token: string, entry: Extract<Entry, { kind: 'paired' }>): void {
    this.partners.delete(entry.first.id)
    this.partners.delete(entry.second.id)
    this.entries.delete(token)
  }
}
