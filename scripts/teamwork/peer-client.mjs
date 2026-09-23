// A client for one runtime's local socket: newline-delimited JSON (src/shared/protocol.ts), responses
// and stream events interleaved. Needs no build, and is the same shape a peer transport is.

import { connect } from 'node:net'

/**
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
  /** Events for a subscription not yet named: its first frames can arrive before the response. */
  #held = new Map()
  #buffer = ''
  #nextId = 0
  /** Every method sent, in order, so a test can show what this end did not have to ask for. */
  #called = []
  /** Set once and reported to every later caller, so a dropped socket fails fast. */
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
   * Subscribes and routes events to `onEvent`; resolves with the method's answer plus a `close`,
   * which is the caller's to call.
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
        // Best effort: the runtime may already have gone.
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
    // From the pending request: a response carries only the id.
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
