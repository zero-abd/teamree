// The pairing table, and the only place in the relay that decides anything.
//
// It works on a `Peer` interface rather than on sockets so that the awkward
// cases — a peer that vanishes, a reconnect racing its own half-open
// predecessor, two peers arriving in the same tick — are decided by logic you
// can read, and the socket layer is left with nothing to get wrong.
//
// The load-bearing fact, and the source of most of the rules below: **the relay
// cannot tell the two peers apart.** Both are anonymous connections that
// presented the same opaque token. There is no "side A" to reconnect into.

import { CloseCode, type ControlFrame } from './protocol.js'
import { randomHex } from './random.js'

export type Peer = {
  readonly id: string
  /** Forwards a spliced frame. The only path a payload byte ever takes. */
  deliver: (payload: Uint8Array) => void
  /** Bytes already handed to this peer's socket that it has not taken yet. */
  backlog: () => number
  /**
   * Both halves of a pairing learn about it here, including the one that was
   * already waiting — which is the only way a parked peer ever becomes willing
   * to carry content.
   */
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

  /**
   * The partner of a paired peer, or undefined if it is still waiting. Callers
   * ask this per frame, so it is a map lookup rather than a scan.
   */
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
      // The arriving peer initiates: it is the one that knew a partner was
      // present without waiting to be told. Handing out a fixed answer stops
      // both sides opening a handshake at once, and costs the relay no knowledge
      // of what the handshake contains.
      existing.peer.markPaired(sessionId, false)
      peer.markPaired(sessionId, true)
      return { status: 'paired', pairRef: existing.pairRef, sessionId }
    }

    // A third connection on a live session. The relay cannot know whether this
    // is one of the two coming back from a suspend with a half-open socket
    // behind it, or an unrelated arrival — it cannot tell the peers apart. So it
    // does the only thing that is right either way: it ends the session and lets
    // the newcomer wait. Both old peers are told they were superseded rather
    // than that their partner left, so their reconnects are staggered and the
    // two of them do not spend the evening displacing each other.
    this.dropSession(token, existing)
    const pairRef = randomHex(6)
    this.entries.set(token, { kind: 'waiting', pairRef, peer, since: now })
    existing.first.close(CloseCode.Superseded, 'rendezvous claimed by a newer connection')
    existing.second.close(CloseCode.Superseded, 'rendezvous claimed by a newer connection')
    return { status: 'waiting', pairRef, supersededSession: true }
  }

  /**
   * Removes a peer and tears down whatever it was part of. Safe to call twice,
   * and safe to call for a peer that has already been replaced — the identity
   * check is what stops a superseded peer's late close event from evicting the
   * connection that replaced it.
   */
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

    // A Noise session cannot outlive either of its transports, so there is no
    // useful state to keep for the survivor. It is told and closed, and the pair
    // rebuilds from scratch on reconnect.
    const partner = existing.first.id === peer.id ? existing.second : existing.first
    this.dropSession(token, existing)
    partner.close(CloseCode.PartnerGone, 'partner disconnected')
    return { removed: true, endedSession: true }
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

  /**
   * Puts back a pairing the host had already made and then lost, because it was
   * evicted from memory between frames. This is a reconstruction, not a new
   * pairing: nobody is told, nothing is minted, and the ids are the ones the
   * peers were already given.
   */
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

  /**
   * Forgets every pairing without telling anyone, for a host that is about to
   * close all of them itself. Without this, closing the first peer of a session
   * would tell the second its partner had left, which is not what happened.
   */
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
