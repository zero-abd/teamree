// What an operator can see, what they cannot see, and what happens when they
// stop the process. The second of those is the one that matters most: running
// the relay must buy nobody a way to read what is going through it.

import { afterEach, describe, expect, it } from 'vitest'
import { configFromEnv, ConfigError } from '../src/core/config.js'
import { CloseCode } from '../src/core/protocol.js'
import { connectPeer, joinPeer, rendezvousToken, startTestRelay, type TestRelay } from './support/harness.js'

let harness: TestRelay
let running = false

async function start(overrides: Parameters<typeof startTestRelay>[0] = {}): Promise<TestRelay> {
  harness = await startTestRelay(overrides)
  running = true
  return harness
}

afterEach(async () => {
  if (!running) return
  running = false
  await harness.relay.close()
})

function healthUrl(relay: TestRelay): string {
  return `http://127.0.0.1:${relay.relay.port}/healthz`
}

describe('what running the relay shows you', () => {
  it('reports how much is connected without saying who any of it is', async () => {
    await start()
    const token = rendezvousToken()
    const first = await joinPeer(harness, token)
    await joinPeer(harness, token)
    await first.waitPaired()
    await joinPeer(harness, rendezvousToken('alone'))

    const response = await fetch(healthUrl(harness))
    const body = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(body).toEqual({
      status: 'ok',
      uptimeMs: expect.any(Number),
      connections: { total: 3, greeting: 0, waiting: 1 },
      sessions: 1
    })
    // Counts and nothing else: no token, no address, no per-session detail.
    expect(JSON.stringify(body)).not.toContain(token)
  })

  it('refuses a health read with no credential once one is configured', async () => {
    await start({ healthToken: 'operators-only' })

    expect((await fetch(healthUrl(harness))).status).toBe(401)
    expect((await fetch(healthUrl(harness), { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await fetch(healthUrl(harness), { headers: { authorization: 'Bearer operators-only' } })).status).toBe(200)
  })

  it('answers nothing but the health endpoint', async () => {
    await start()

    expect((await fetch(`http://127.0.0.1:${harness.relay.port}/`)).status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${harness.relay.port}/metrics`)).status).toBe(404)
    expect((await fetch(healthUrl(harness), { method: 'POST' })).status).toBe(404)
  })

  it('gives whoever runs it no way to read what peers are saying', async () => {
    await start()
    const token = rendezvousToken()
    const first = await joinPeer(harness, token)
    const second = await joinPeer(harness, token)
    await first.waitPaired()

    // In production this would be ciphertext. Plaintext here makes the assertion
    // meaningful: if any of it reached the operator's view, this would find it.
    const secret = 'the-thing-the-operator-must-not-learn'
    first.send(Buffer.from(secret))
    await second.binary.atLeast(1)

    // The operator has exactly two windows onto a running relay — its logs and
    // its health endpoint. Neither carries content, and neither carries the
    // rendezvous, which is the pair's shared secret rather than the relay's.
    const health = await (await fetch(healthUrl(harness))).text()
    const logs = harness.log.lines.join('\n')
    expect(logs).not.toContain(secret)
    expect(logs).not.toContain(token)
    expect(health).not.toContain(secret)
    expect(health).not.toContain(token)
  })

  it('keeps no trace of a payload in the log even when a peer is closed for sending it', async () => {
    await start({ maxFramesPerSecond: 1 })
    const token = rendezvousToken()
    const first = await joinPeer(harness, token)
    await joinPeer(harness, token)
    await first.waitPaired()

    const secret = 'still-not-the-operators-business'
    first.send(Buffer.from(secret))
    first.send(Buffer.from(secret))
    await first.waitClosed()

    expect(harness.log.lines.join('\n')).not.toContain(secret)
  })

  it('names a frame-level failure with a code rather than with prose it did not write', async () => {
    await start()
    const peer = await joinPeer(harness, rendezvousToken())

    // A text frame that is not valid UTF-8. The library underneath rejects it
    // and hands up an Error whose message is its own wording — which is the
    // one thing not logged, so that "no payload byte reaches a log" does not
    // quietly become a claim about a dependency's release notes.
    peer.socket.send(Buffer.from([0xff, 0xfe, 0xfd]), { binary: false })
    await peer.waitClosed()

    const errors = harness.log.records.filter((record) => record.event === 'connection.error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.reason).toBe('WS_ERR_INVALID_UTF8')
  })

  it('records both sides of a pairing under one reference so a session can be followed', async () => {
    await start()
    const token = rendezvousToken()
    const first = await joinPeer(harness, token)
    const second = await joinPeer(harness, token)
    await first.waitPaired()
    const opened = harness.log.records.filter((record) => record.event === 'session.opened')

    expect(opened).toHaveLength(1)
    expect(opened[0]?.pair).toEqual(expect.any(String))
    // A ref is a name for a pairing within one run, not a fingerprint of it: it
    // is derived under a key generated at start-up and thrown away at exit.
    expect(opened[0]?.pair).not.toBe(token)
    expect(second.control.items).toHaveLength(1)
  })

  it('does not log a client address unless asked to', async () => {
    await start()
    await connectPeer(harness)
    const withoutAddresses = harness.log.records.filter((record) => record.address !== undefined)

    expect(withoutAddresses).toHaveLength(0)
    expect(harness.log.records.some((record) => record.addressRef !== undefined)).toBe(true)
  })
})

describe('stopping', () => {
  it('closes live sessions with a reason instead of dropping them', async () => {
    await start()
    const token = rendezvousToken()
    const first = await joinPeer(harness, token)
    const second = await joinPeer(harness, token)
    await first.waitPaired()

    await harness.relay.close()

    // 1001 is "going away": a peer that sees it knows to come back, and knows it
    // was not thrown out for anything it did.
    expect((await first.waitClosed()).code).toBe(CloseCode.GoingAway)
    expect((await second.waitClosed()).code).toBe(CloseCode.GoingAway)
    expect(first.control.items.at(-1)).toMatchObject({ t: 'closing', code: CloseCode.GoingAway })
  })

  it('stops accepting new peers while it is stopping', async () => {
    await start()
    await harness.relay.close()

    await expect(connectPeer(harness)).rejects.toThrow()
  })
})

describe('configuration', () => {
  it('takes its listen address and every limit from the environment', () => {
    const config = configFromEnv({
      RELAY_HOST: '127.0.0.1',
      RELAY_PORT: '9999',
      RELAY_PATH: '/socket',
      RELAY_MAX_CONNECTIONS: '4',
      RELAY_IDLE_TIMEOUT_MS: '1000',
      RELAY_LOG_CLIENT_ADDRESS: 'true'
    })

    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 9999,
      path: '/socket',
      maxConnections: 4,
      idleTimeoutMs: 1000,
      logClientAddress: true
    })
  })

  it('refuses to start on a limit it cannot make sense of rather than guessing', () => {
    // A relay that quietly fell back to a default is a relay whose operator
    // believes it is enforcing something it is not.
    expect(() => configFromEnv({ RELAY_PORT: 'eight-thousand' })).toThrow(ConfigError)
    expect(() => configFromEnv({ RELAY_MAX_FRAME_BYTES: '-1' })).toThrow(ConfigError)
    expect(() => configFromEnv({ RELAY_PATH: 'socket' })).toThrow(/RELAY_PATH/)
    expect(() => configFromEnv({ RELAY_MAX_BUFFERED_BYTES: '65536', RELAY_MAX_FRAME_BYTES: '131072' })).toThrow(
      /RELAY_MAX_BUFFERED_BYTES/
    )
  })

  it('needs nothing from its host but a listening socket and an environment', () => {
    // Asserted by construction: core carries no import of a filesystem, a
    // database or a process global, so the only thing a different runtime has to
    // supply is a socket adapter.
    expect(configFromEnv({})).toMatchObject({ host: '0.0.0.0', port: 8787 })
  })
})
