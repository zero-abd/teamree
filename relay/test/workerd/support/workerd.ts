// Starts the Worker under workerd — the runtime Cloudflare actually runs it on —
// and hands the tests a real URL to dial.
//
// Everything else in this suite runs against a fake Durable Object that is
// honest about being one. This is the other half: the same behaviours, driven
// through `wrangler dev`, which is workerd on localhost with nothing deployed
// anywhere. Two rules are different here, and both are what a real runtime
// costs:
//
//   - these tests wait on the wall clock. Hibernation and the alarm are the
//     runtime's to schedule and it takes no instruction about when, so there is
//     no manual clock to advance. Every wait is annotated with what it is
//     waiting for and why that long.
//   - when wrangler is not on disk they skip loudly rather than fail. A
//     checkout without it is incomplete, not broken, and a suite that goes red
//     for a missing dependency teaches people to ignore it.

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { Inbox, TestPeer } from '../../support/harness.js'

const require = createRequire(import.meta.url)
const relayRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** How long to give `wrangler dev` to bundle the Worker and bind the port. */
const READY_TIMEOUT_MS = 90_000

/**
 * How long a Durable Object has to be left alone before workerd throws it out of
 * memory. Measured against this runtime rather than assumed: at eight seconds of
 * quiet the object answering was still the one that opened the pairing, and at
 * eleven it was a rebuilt one. The margin above that is for a loaded machine,
 * and every test that waits it out checks that the eviction really happened
 * rather than trusting the number.
 */
export const EVICTION_QUIET_MS = 14_000

/**
 * Why this suite cannot run here, or null when it can. Only ever about things
 * that are missing from the checkout: anything else is a result, not an excuse.
 */
export function workerdUnavailable(): string | null {
  let wrangler: string
  try {
    wrangler = require.resolve('wrangler/package.json')
  } catch {
    return 'the wrangler package is not installed (run `npm ci` in relay/)'
  }
  if (!existsSync(resolve(dirname(wrangler), 'bin/wrangler.js'))) {
    return 'the wrangler package is installed but has no bin/wrangler.js'
  }
  let binary: unknown
  try {
    binary = (require('workerd') as { default?: unknown }).default
  } catch {
    return 'the workerd runtime is not installed (its npm package ships a per-platform binary)'
  }
  if (typeof binary !== 'string' || !existsSync(binary)) {
    return `the workerd binary is missing for this platform (${process.platform}/${process.arch})`
  }
  return null
}

/** Said once, at the top of the run, so a skipped suite cannot pass for a green one. */
export function announceSkip(reason: string): void {
  console.warn(
    [
      '',
      '  ! SKIPPED: the relay Worker was never run against workerd.',
      `  ! ${reason}`,
      '  ! The Durable Object is covered here only by test/hibernation.test.ts, which',
      '  ! drives a hand-written fake. Nothing in this run says the real runtime agrees.',
      ''
    ].join('\n')
  )
}

export type LogRecord = Record<string, unknown>

export type WorkerdRelay = {
  /** The URL a peer dials for a rendezvous, named the way the Worker expects. */
  url: (token: string) => string
  /** Every structured line the Worker has logged, awaitable as it arrives. */
  log: Inbox<LogRecord>
  /**
   * The address label the object will put in its next `connection.opened`. Call
   * it before opening the connection it is about. The labels are random and held
   * by the logger the Durable Object built when it was last constructed, so a
   * peer that opens to a different label than its partner did is a peer that
   * arrived at a rebuilt object. From outside, it is the only evidence there is
   * that an eviction happened at all.
   */
  addressRefOnNextOpen: () => Promise<string>
  stop: () => Promise<void>
}

/**
 * One `wrangler dev`, with the deployed configuration except for the variables a
 * test needs at a length it can wait out. Vars go on the command line rather
 * than into wrangler.jsonc so that the file under test stays the deployed one.
 */
export async function startWorkerdRelay(vars: Record<string, string> = {}): Promise<WorkerdRelay> {
  const log = new Inbox<LogRecord>()
  const output: string[] = []
  const ready = new Inbox<string>()

  const args = [
    'dev',
    '--local',
    '--ip',
    '127.0.0.1',
    // Chosen by the OS and read back off stdout, so suites can run side by side.
    '--port',
    '0',
    '--inspector-port',
    '0',
    // Under .wrangler/, which the relay already ignores, and per-run so that two
    // dev servers never share a lock.
    '--persist-to',
    resolve(relayRoot, `.wrangler/test-state-${process.pid}-${randomUUID()}`),
    ...Object.entries(vars).flatMap(([name, value]) => ['--var', `${name}:${value}`])
  ]

  const child = spawn(process.execPath, [resolve(relayRoot, 'node_modules/wrangler/bin/wrangler.js'), ...args], {
    cwd: relayRoot,
    // Its own process group, so stopping it takes workerd with it rather than
    // leaving a runtime holding a port after the suite has finished.
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' }
  })

  const consume = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim() === '') continue
      output.push(line)
      // The Worker's own logger writes one JSON object per line, and wrangler
      // passes console output straight through.
      const start = line.indexOf('{')
      if (start !== -1) {
        try {
          const parsed = JSON.parse(line.slice(start)) as LogRecord
          if (typeof parsed.event === 'string') log.push(parsed)
        } catch {
          // Not one of ours. Wrangler's own chatter goes in `output` only.
        }
      }
      const port = /Ready on https?:\/\/[^:]+:(\d+)/.exec(line)?.[1]
      if (port !== undefined) ready.push(port)
    }
  }
  child.stdout.on('data', consume)
  child.stderr.on('data', consume)

  const group = child.pid
  const signalGroup = (signal: NodeJS.Signals): boolean => {
    if (group === undefined) return false
    try {
      process.kill(-group, signal)
      return true
    } catch {
      // Already gone, which is the outcome we were after.
      return false
    }
  }

  const stop = async (): Promise<void> => {
    const running = child.exitCode === null && child.signalCode === null
    const ended = running ? new Promise<void>((done) => child.once('exit', () => done())) : Promise.resolve()
    signalGroup('SIGTERM')
    await Promise.race([ended, delay(5_000)])
    // Whatever wrangler did or did not take down with it. A workerd left holding
    // a port outlives the suite, and the next run finds the machine busier for
    // no reason it can see.
    signalGroup('SIGKILL')
  }

  const port = await Promise.race([
    ready.atLeast(1).then((seen) => seen[0] as string),
    delay(READY_TIMEOUT_MS).then(() => null)
  ])
  if (port === null) {
    await stop()
    throw new Error(
      `wrangler dev never bound a port within ${READY_TIMEOUT_MS}ms. Its output was:\n${output.join('\n')}`
    )
  }

  return {
    url: (token) => `ws://127.0.0.1:${port}/v1/relay/${rendezvousName(token)}`,
    log,
    addressRefOnNextOpen: async () => {
      const already = log.items.length
      const seen = await log.until((items) => items.slice(already).some(isConnectionOpened))
      return String(seen.slice(already).find(isConnectionOpened)?.addressRef)
    },
    stop
  }
}

function isConnectionOpened(record: LogRecord): boolean {
  return record.event === 'connection.opened' && typeof record.addressRef === 'string'
}

/** What the Worker calls the object: the rendezvous hashed, never the token itself. */
function rendezvousName(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function connectWorkerdPeer(relay: WorkerdRelay, token: string): Promise<TestPeer> {
  const socket = new WebSocket(relay.url(token))
  await new Promise<void>((accepted, refused) => {
    socket.once('open', () => accepted())
    socket.once('error', refused)
  })
  return new TestPeer(socket)
}

/** Connects and greets, resolving once the Worker has answered the hello. */
export async function joinWorkerdPeer(relay: WorkerdRelay, token: string): Promise<TestPeer> {
  const peer = await connectWorkerdPeer(relay, token)
  peer.hello(token)
  await peer.control.atLeast(1)
  return peer
}

/**
 * An upgrade the Worker is free to refuse, which `connect` is not. A refusal
 * arrives as an HTTP status rather than as a socket, which is the whole point of
 * spending it there: nothing is ever upgraded.
 */
export type Offer = { accepted: true; peer: TestPeer } | { accepted: false; status: number }

export async function offerWorkerdPeer(relay: WorkerdRelay, token: string): Promise<Offer> {
  const socket = new WebSocket(relay.url(token))
  return new Promise((settled) => {
    socket.once('open', () => settled({ accepted: true, peer: new TestPeer(socket) }))
    socket.once('error', (error: Error) => {
      settled({ accepted: false, status: Number(/(\d{3})\s*$/.exec(error.message)?.[1] ?? 0) })
    })
  })
}

/**
 * The only kind of waiting these tests do. Named so that every call site has to
 * say what it is waiting for.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}
