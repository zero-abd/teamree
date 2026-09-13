// A client for one runtime's local socket, speaking the protocol in
// src/shared/protocol.ts: newline-delimited JSON, one value per line, with
// responses and stream events interleaved on the same connection.
//
// The harness talks this rather than shelling out to the built `teamree` CLI for
// two reasons. It needs no build step, so a two-peer run works from a clean
// checkout. And it is the same shape a peer transport is: `docs/teamwork.md`
// describes a teammate as "a third transport onto the same catalogue", so a
// client that sends `{ id, method, params }` and reads `{ id, ok, result }` back
// is already the thing that eventually goes over the relay.

import { connect } from 'node:net'

/**
 * Connects to a runtime endpoint.
 *
 * @param {string} endpoint Unix socket path, or a named pipe on Windows.
 * @returns {Promise<PeerClient>}
 */
export function connectToRuntime(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint)
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.removeListener('error', reject)
      resolve(new PeerClient(socket))
    })
  })
}

export class PeerClient {
  #socket
  #pending = new Map()
  #streams = new Map()
  /**
   * Events for a subscription this end cannot name yet.
   *
   * Responses and stream events share one socket and are read in order, and a
   * subscription can start pushing before the response that names it is
   * written — so the first frames of a pane can arrive before the caller has
   * any id to file them under. Dropping them would make this harness lose the
   * first thing a pane says, which is a bug it exists to catch elsewhere.
   */
  #held = new Map()
  #buffer = ''
  #nextId = 0
  /**
   * Every method this client has sent, in order.
   *
   * Kept because some of what teamwork promises is about what a person did
   * *not* have to do: a teammate's worktrees arrive without anybody
   * subscribing, and the only honest way to assert that is to be able to show
   * what this end actually asked for.
   */
  #called = []
  /** Set once, and reported to every caller afterwards: a socket that dropped
   * mid-run must not leave the next call hanging until the suite times out. */
  #closed = null

  constructor(socket) {
    this.#socket = socket
    socket.on('data', (chunk) => this.#ingest(chunk))
    socket.on('close', () => this.#fail(new Error('runtime closed the connection')))
    socket.on('error', (error) => this.#fail(error))
  }

  /** Every method this client has sent, oldest first. */
  get called() {
    return [...this.#called]
  }

  /**
   * Sends one request and resolves with its result.
   *
   * @param {string} method
   * @param {unknown} [params]
   * @returns {Promise<unknown>}
   */
  call(method, params = {}) {
    if (this.#closed) return Promise.reject(this.#closed)
    this.#called.push(method)
    const id = `h${this.#nextId++}`
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method })
      this.#socket.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  /**
   * Subscribes and routes the stream's events to `onEvent`.
   *
   * Resolves with the method's own answer — which for `teamwork.watch` carries
   * the owner's pane dimensions beside the subscription id — plus a `close`.
   * Closing is the caller's, since a subscription nobody released keeps a pty
   * streaming into nothing.
   *
   * @param {string} method A method that answers with a subscription id.
   * @param {unknown} params
   * @param {(event: any) => void} onEvent
   * @returns {Promise<any>}
   */
  async subscribe(method, params, onEvent) {
    const result = await this.call(method, params)
    const subscription = result.subscription
    this.#streams.set(subscription, onEvent)
    for (const event of this.#held.get(subscription) ?? []) onEvent(event)
    this.#held.delete(subscription)

    return {
      ...result,
      close: async () => {
        this.#streams.delete(subscription)
        this.#held.delete(subscription)
        // Best effort: the runtime may already have gone, and tearing a harness
        // down is not a reason to fail a test that otherwise passed.
        await this.call('unsubscribe', { subscription }).catch(() => {})
      }
    }
  }

  close() {
    this.#socket.destroy()
  }

  #ingest(chunk) {
    this.#buffer += chunk
    let newline = this.#buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).trim()
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line) this.#dispatch(JSON.parse(line))
      newline = this.#buffer.indexOf('\n')
    }
  }

  #dispatch(frame) {
    if ('stream' in frame) {
      const onEvent = this.#streams.get(frame.stream)
      if (onEvent) onEvent(frame.event)
      else this.#held.set(frame.stream, [...(this.#held.get(frame.stream) ?? []), frame.event])
      return
    }
    const waiter = this.#pending.get(frame.id)
    if (!waiter) return
    this.#pending.delete(frame.id)
    if (frame.ok) {
      waiter.resolve(frame.result)
      return
    }
    // The method is taken from the pending request, not the response: a response
    // carries only the id, and an error reading "h7 failed" helps nobody.
    const error = new Error(`${waiter.method}: ${frame.error.message}`)
    error.code = frame.error.code
    waiter.reject(error)
  }

  #fail(error) {
    this.#closed ??= error
    for (const waiter of this.#pending.values()) waiter.reject(error)
    this.#pending.clear()
    this.#streams.clear()
    this.#held.clear()
  }
}
