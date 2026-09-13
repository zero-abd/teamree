// THE FOURTH TRANSPORT.
//
// The runtime already answers one catalogue of methods over Electron IPC for
// the window and over a unix socket for the CLI. A teammate is another way in,
// and this file is deliberately the same shape as `socketServer.ts`: give the
// connection an id, give it a frame decoder, give it a subscription scope, feed
// whatever arrives to the one dispatcher, and write what comes back. Nothing
// below this line knows the caller is two thousand miles away, which is what
// makes `terminal.subscribe` reachable over a peer link in milestone C without
// touching the terminal service at all.
//
// Two things are not like the socket server, and both are because the caller is
// somebody else's machine:
//
// **The bytes are encrypted.** What arrives is a Noise transport message; what
// comes out of it is the same newline-delimited JSON a CLI client sends.
// `peerFraming.ts` owns the boundary between the two.
//
// **The catalogue is not fully open.** A CLI client is the user; a peer is a
// teammate. `docs/teamwork.md` means for a teammate to see panes and eventually
// to type into one, and it does not mean for them to remove a worktree or drop
// a project. So a peer's reachable surface is an explicit allow-list, and it is
// the seam the later milestones widen: C adds the two reads that stream a
// pane's output, D adds `terminal.write`. Everything absent from the set
// answers as an unknown method, which is what it is from where the peer stands.

import type { MethodName, ParamsOf, ResultOf } from '../../shared/methods'
import type { PeerSession } from '../../shared/peer'
import { encodeFrame, ErrorCode, isStreamEvent, type Frame, type Response } from '../../shared/protocol'
import type { Dispatcher } from './dispatcher'
import { createLineReader, encodeLine } from './peerFraming'
import type { SubscriptionHub } from './subscriptionHub'

/**
 * What a teammate may ask this runtime to do, in milestone B.
 *
 * Presence and nothing else. Metadata is automatic; bytes are not, and a pane's
 * bytes are milestone C. Adding a method here is the deliberate act of handing
 * a teammate a new capability, so the set is spelled out rather than derived.
 */
export const PEER_METHODS: readonly MethodName[] = ['peer.presence', 'peer.subscribe', 'unsubscribe'] as const

export type PeerTransportOptions = {
  session: PeerSession
  /** Hands one Noise transport message to whatever is carrying them. */
  send: (message: Uint8Array) => void
  dispatch: Dispatcher
  subscriptions: SubscriptionHub
  /** Unique per link, and the key every subscription this peer opens is owned by. */
  connectionId: string
  /** Defaults to `PEER_METHODS`; a test narrows it to prove the gate is real. */
  allowedMethods?: readonly MethodName[]
  /** Stream frames the *peer* pushed to us, for a subscription we opened there. */
  onStreamEvent?: (stream: string, event: unknown) => void
  /**
   * The link can no longer be trusted and must be torn down: a Noise failure, a
   * frame that is not JSON. Both are unrecoverable — a Noise stream has no
   * resynchronisation point — so this is never a warning.
   */
  onFatal: (reason: string) => void
  /** Failures that cost one call and not the link. */
  onError?: (error: unknown) => void
}

export type PeerTransport = {
  /** A request to the peer, typed from the same catalogue. */
  call: <M extends MethodName>(method: M, params: ParamsOf<M>) => Promise<ResultOf<M>>
  /** One Noise transport message, exactly as the peer framed it. */
  receive: (message: Uint8Array) => void
  /**
   * A content frame carrying nothing.
   *
   * The relay's idle deadline counts content frames only — a text ping does not
   * reset it — so a pair that is merely quiet has to say something in the one
   * language the relay is not allowed to read. An empty line is a whole,
   * well-formed frame that the decoder on the far side drops without waking
   * anything, which makes it the cheapest legal thing to say.
   */
  keepalive: () => void
  /** Fails every call still in flight and releases this peer's subscriptions. */
  close: (reason: string) => void
}

export function createPeerTransport(options: PeerTransportOptions): PeerTransport {
  const allowed = new Set<string>(options.allowedMethods ?? PEER_METHODS)
  const pending = new Map<string, { resolve: (value: never) => void; reject: (error: Error) => void }>()
  const reader = createLineReader(options.session)
  let nextId = 0
  let live = true

  const write = (frame: Frame): void => {
    if (!live) return
    try {
      for (const message of encodeLine(options.session, encodeFrame(frame))) options.send(message)
    } catch (error) {
      // Encryption only fails once the session is already unusable, so there is
      // nothing left to send an error over.
      fail(messageOf(error))
    }
  }

  const fail = (reason: string): void => {
    if (!live) return
    live = false
    options.subscriptions.closeConnection(options.connectionId)
    for (const [, waiter] of pending) waiter.reject(new Error(reason))
    pending.clear()
    options.onFatal(reason)
  }

  // The peer gets its own subscription scope, so whatever it opened dies with
  // the link and cannot outlive the machine that asked for it.
  options.subscriptions.openConnection(options.connectionId, (event) => write(event))

  const handleResponse = (response: Response): void => {
    const waiter = pending.get(response.id)
    if (!waiter) return
    pending.delete(response.id)
    if (response.ok) waiter.resolve(response.result as never)
    else waiter.reject(new PeerCallError(response.error.code, response.error.message))
  }

  const handleRequest = (value: unknown): void => {
    const method = methodOf(value)
    if (method !== undefined && !allowed.has(method)) {
      // Deliberately the same answer a method that does not exist gets. From
      // where the peer stands that is exactly what this is.
      write({
        id: idOf(value),
        ok: false,
        error: { code: ErrorCode.UnknownMethod, message: `${method} is not a method a teammate can call` }
      })
      return
    }
    void options.dispatch(value, { connectionId: options.connectionId }).then(write, (error: unknown) => {
      options.onError?.(error)
    })
  }

  return {
    call: <M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> => {
      if (!live) return Promise.reject(new Error('the peer link is closed'))
      nextId += 1
      const id = `peer_${nextId}`
      return new Promise<ResultOf<M>>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: never) => void, reject })
        write({ id, method, params } as unknown as Frame)
      })
    },

    receive: (message) => {
      if (!live) return
      let values: unknown[]
      try {
        values = reader.push(message)
      } catch (error) {
        // A Noise message that fails to authenticate and a line that is not
        // JSON are the same kind of event: the stream's position is gone and
        // there is no point from which it could be picked up again.
        fail(messageOf(error))
        return
      }
      for (const value of values) {
        if (isResponse(value)) handleResponse(value)
        else if (isStreamFrame(value)) options.onStreamEvent?.(value.stream, value.event)
        else handleRequest(value)
      }
    },

    keepalive: () => {
      if (!live) return
      try {
        for (const message of encodeLine(options.session, '\n')) options.send(message)
      } catch (error) {
        fail(messageOf(error))
      }
    },

    close: (reason) => fail(reason)
  }
}

/** An error the *peer's* runtime returned, with its code preserved. */
export class PeerCallError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'PeerCallError'
    this.code = code
  }
}

function isResponse(value: unknown): value is Response {
  return typeof value === 'object' && value !== null && 'ok' in value && 'id' in value
}

function isStreamFrame(value: unknown): value is { stream: string; event: unknown } {
  return typeof value === 'object' && value !== null && isStreamEvent(value as Frame)
}

function methodOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const method = (value as { method?: unknown }).method
  return typeof method === 'string' ? method : undefined
}

function idOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) return ''
  const id = (value as { id?: unknown }).id
  return typeof id === 'string' ? id : ''
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
