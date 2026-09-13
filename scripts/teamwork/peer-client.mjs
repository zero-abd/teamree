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
  #buffer = ''
  #nextId = 0
  /** Set once, and reported to every caller afterwards: a socket that dropped
   * mid-run must not leave the next call hanging until the suite times out. */
  #closed = null

  constructor(socket) {
    this.#socket = socket
    socket.on('data', (chunk) => this.#ingest(chunk))
    socket.on('close', () => this.#fail(new Error('runtime closed the connection')))
    socket.on('error', (error) => this.#fail(error))
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
    const id = `h${this.#nextId++}`
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method })
      this.#socket.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  /**
   * Subscribes and routes the stream's events to `onEvent`. Resolves with a
   * function that unsubscribes; the caller is responsible for calling it, since
   * a subscription nobody closed keeps a PTY streaming into nothing.
   *
   * @param {string} method A `*.subscribe` method.
   * @param {unknown} params
   * @param {(event: unknown) => void} onEvent
   * @returns {Promise<() => Promise<void>>}
   */
  async subscribe(method, params, onEvent) {
    const result = await this.call(method, params)
    const subscription = result.subscription
    this.#streams.set(subscription, onEvent)
    return async () => {
      this.#streams.delete(subscription)
      // Best effort: the runtime may already have gone, and tearing a harness
      // down is not a reason to fail a test that otherwise passed.
      await this.call('unsubscribe', { subscription }).catch(() => {})
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
      this.#streams.get(frame.stream)?.(frame.event)
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
  }
}
