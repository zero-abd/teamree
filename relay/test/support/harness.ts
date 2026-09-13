// Everything here exists so that the tests can be about the relay rather than
// about timing. Two rules hold throughout:
//
//   - nothing sleeps. Deadlines are driven by a manual clock, and everything
//     else is awaited as a condition on a real socket event.
//   - the relay is spoken to over a real WebSocket on a real port, because the
//     whole point of this program is the transport.

import { createHash, randomBytes } from 'node:crypto'
import { WebSocket } from 'ws'
import type { Clock } from '../../src/core/clock.js'
import type { RelayConfig } from '../../src/core/config.js'
import type { Logger } from '../../src/core/log.js'
import { PROTOCOL_VERSION, type ControlFrame } from '../../src/core/protocol.js'
import { createNodeLogger } from '../../src/node/logging.js'
import { startRelay, type Relay } from '../../src/node/server.js'

export type ManualClock = Clock & { advance: (ms: number) => void }

export function createManualClock(start = 1_700_000_000_000): ManualClock {
  let current = start
  return {
    now: () => current,
    advance: (ms) => {
      current += ms
    }
  }
}

/** Collects events and lets a test await a condition on them without polling. */
export class Inbox<T> {
  readonly items: T[] = []
  private waiters: Array<() => void> = []

  push(item: T): void {
    this.items.push(item)
    const woken = this.waiters
    this.waiters = []
    for (const wake of woken) wake()
  }

  async until(predicate: (items: readonly T[]) => boolean): Promise<readonly T[]> {
    while (!predicate(this.items)) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    return this.items
  }

  async atLeast(count: number): Promise<readonly T[]> {
    return this.until((items) => items.length >= count)
  }
}

export type CapturedLog = { lines: string[]; records: Array<Record<string, unknown>>; logger: Logger }

export function captureLog(now: () => number): CapturedLog {
  const lines: string[] = []
  const records: Array<Record<string, unknown>> = []
  const logger = createNodeLogger({
    now,
    write: (line) => {
      lines.push(line)
      records.push(JSON.parse(line) as Record<string, unknown>)
    }
  })
  return { lines, records, logger }
}

export type TestRelay = {
  relay: Relay
  clock: ManualClock
  log: CapturedLog
  url: string
}

/**
 * Test defaults deliberately disable the automatic sweep by pushing its interval
 * far into the future: a test that wants a deadline checked advances the clock
 * and calls `relay.sweep()` itself, which is what makes the result the same
 * every run.
 */
export async function startTestRelay(overrides: Partial<RelayConfig> = {}): Promise<TestRelay> {
  const clock = createManualClock()
  const log = captureLog(clock.now)
  const relay = await startRelay({
    clock,
    log: log.logger,
    config: {
      host: '127.0.0.1',
      port: 0,
      // Far enough out that advancing the clock never trips the automatic
      // sweep: a test that wants a deadline checked calls `relay.sweep()`
      // itself, at an instant it chose.
      keepaliveIntervalMs: 3_600_000,
      // Short, because several tests deliberately leave a peer that will never
      // finish its closing handshake, and teardown should not wait on it.
      shutdownGraceMs: 250,
      ...overrides
    }
  })
  return { relay, clock, log, url: `ws://127.0.0.1:${relay.port}${relay.config.path}` }
}

export type Closed = { code: number; reason: string }

export class TestPeer {
  readonly control = new Inbox<ControlFrame>()
  readonly binary = new Inbox<Buffer>()
  readonly pings = new Inbox<true>()
  readonly closed = new Inbox<Closed>()
  readonly socket: WebSocket

  constructor(socket: WebSocket) {
    this.socket = socket
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) this.binary.push(Buffer.from(data))
      else this.control.push(JSON.parse(data.toString('utf8')) as ControlFrame)
    })
    socket.on('ping', () => this.pings.push(true))
    socket.on('close', (code: number, reason: Buffer) => this.closed.push({ code, reason: reason.toString('utf8') }))
    // A peer closed by the relay is an expected outcome here, not a failure.
    socket.on('error', () => {})
  }

  hello(rendezvous: string, version = PROTOCOL_VERSION): void {
    this.socket.send(JSON.stringify({ version, rendezvous }))
  }

  raw(text: string): void {
    this.socket.send(text)
  }

  send(payload: Buffer | string): void {
    this.socket.send(Buffer.from(payload), { binary: true })
  }

  async waitPaired(): Promise<Extract<ControlFrame, { t: 'paired' }>> {
    const frames = await this.control.until((items) => items.some((frame) => frame.t === 'paired'))
    return frames.find((frame) => frame.t === 'paired') as Extract<ControlFrame, { t: 'paired' }>
  }

  async waitClosed(): Promise<Closed> {
    const seen = await this.closed.atLeast(1)
    return seen[0] as Closed
  }

  close(): void {
    this.socket.close()
  }
}

export async function connectPeer(harness: TestRelay, headers: Record<string, string> = {}): Promise<TestPeer> {
  const socket = new WebSocket(harness.url, { headers })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
  return new TestPeer(socket)
}

/** Connects and greets, resolving once the relay has acknowledged the hello. */
export async function joinPeer(harness: TestRelay, rendezvous: string): Promise<TestPeer> {
  const peer = await connectPeer(harness)
  peer.hello(rendezvous)
  await peer.control.atLeast(1)
  return peer
}

/** A well-formed rendezvous token. Its derivation is a peer concern, not a relay one. */
export function rendezvousToken(seed = randomBytes(16).toString('hex')): string {
  return createHash('sha256').update(seed).digest('hex')
}
