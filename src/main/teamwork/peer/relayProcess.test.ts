// The same two peers, over the relay itself.
//
// Everything in `peerLink.test.ts` runs against a fake relay in this process,
// which is the only way to drive a relay restart or a displaced rendezvous on
// demand. A handshake proved only against that is a handshake proved against
// something this repository also wrote, so this file runs the real thing: the
// container host, as a child process, on a real port, over real WebSockets,
// with real Noise between two real identities.
//
// It needs the relay built, which is a separate package with its own
// dependencies and its own `dist/`. When that is absent the file says so
// loudly and skips rather than failing, because a missing build of another
// package is not a broken peer transport — but a skip that says nothing is how
// a suite quietly stops testing the thing it was written for.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadIdentity } from '../identity'
import type { LinkScheduler } from './peerLink'
import {
  createPeerRuntime,
  fixedRemoteRunner,
  makeProjectDir,
  project,
  terminal,
  worktree,
  type PeerRuntime
} from './peerTestSupport'
import { webSocketDialer } from './relaySocket'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const RELAY_ENTRY = join(REPO_ROOT, 'relay', 'dist', 'node', 'index.js')
const RELAY_BUILT = existsSync(RELAY_ENTRY)

if (!RELAY_BUILT) {
  console.warn(
    `[peer] skipping the real-relay tests: ${RELAY_ENTRY} is not there.\n` +
      '[peer] build it with:  cd relay && npm install && npm run build'
  )
}

/** Wall-clock, because the point of this file is that the real thing works. */
const realScheduler: LinkScheduler = {
  now: () => Date.now(),
  setTimer: (run, delayMs) => {
    const timer = setTimeout(run, delayMs)
    return () => clearTimeout(timer)
  },
  random: () => 0.5
}

type RunningRelay = { url: string; stop: () => Promise<void> }

/**
 * The relay on a port the OS picked, learned from the line it logs rather than
 * from a guess — a hard-coded port is how a suite starts failing the moment
 * anything else on the machine wants one.
 */
async function startRelay(): Promise<RunningRelay> {
  const child = spawn(process.execPath, [RELAY_ENTRY], {
    cwd: join(REPO_ROOT, 'relay'),
    env: {
      ...process.env,
      RELAY_HOST: '127.0.0.1',
      RELAY_PORT: '0',
      // Tight enough that the pairing budget is not what a hanging test waits
      // on, wide enough that nothing here trips it.
      RELAY_PAIR_TIMEOUT_MS: '60000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const port = await new Promise<number>((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      for (const line of buffer.split('\n')) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as { event?: string; port?: number }
          if (entry.event === 'relay.listening' && typeof entry.port === 'number') {
            child.stdout.off('data', onData)
            resolve(entry.port)
            return
          }
        } catch {
          // Not a JSON line yet; keep reading.
        }
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', (chunk: Buffer) => {
      reject(new Error(`the relay wrote to stderr: ${chunk.toString('utf8')}`))
    })
    child.once('exit', (code) => reject(new Error(`the relay exited with ${code} before it listened`)))
  })

  return {
    url: `ws://127.0.0.1:${port}/v1/relay`,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve()
        child.once('exit', () => resolve())
        // SIGTERM, because that is what a container runtime sends and what the
        // relay's graceful shutdown is written for.
        child.kill('SIGTERM')
      })
  }
}

/**
 * Waits for a condition the runtime itself announces.
 *
 * Every change to a link's phase or to what a teammate is showing fires
 * `onChange`, so this resolves on the event rather than on a timer. The timeout
 * is a failure mode, not a delay: nothing here waits for it when the thing
 * being waited on happens.
 */
function until(waiters: Set<() => void>, predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  if (predicate()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(check)
      reject(new Error(`timed out waiting for ${what}`))
    }, timeoutMs)
    const check = (): void => {
      if (!predicate()) return
      waiters.delete(check)
      clearTimeout(timer)
      resolve()
    }
    waiters.add(check)
  })
}

describe.skipIf(!RELAY_BUILT)('two peers over the real relay', () => {
  let relay: RunningRelay
  let alice: PeerRuntime
  let bob: PeerRuntime
  const waiters = new Set<() => void>()
  const wake = (): void => {
    for (const waiter of [...waiters]) waiter()
  }

  beforeAll(async () => {
    relay = await startRelay()

    const aliceData = await makeProjectDir([])
    const bobData = await makeProjectDir([])
    const aliceKey = (await loadIdentity(aliceData)).publicKey
    const bobKey = (await loadIdentity(bobData)).publicKey
    const roster = [
      { handle: 'alice', publicKey: aliceKey },
      { handle: 'bob', publicKey: bobKey }
    ]

    const shared = {
      // The real dialer: Node's own WebSocket, over a real TCP connection.
      dial: webSocketDialer,
      scheduler: realScheduler,
      env: { TEAMREE_RELAY_URL: relay.url },
      runner: fixedRemoteRunner('git@example.invalid:team/repo.git'),
      onChange: wake
    }

    alice = await createPeerRuntime({
      ...shared,
      dataDir: aliceData,
      workspace: {
        projects: [project('p_alice', await makeProjectDir(roster))],
        worktrees: [worktree('wt_a1', 'p_alice', 'search ranking', 'feat/ranking')],
        terminals: [terminal('t_a1', 'wt_a1', { agent: 'claude', busy: true, lastOutputAt: Date.now() })]
      }
    })
    bob = await createPeerRuntime({
      ...shared,
      dataDir: bobData,
      workspace: {
        projects: [project('p_bob', await makeProjectDir(roster))],
        worktrees: [worktree('wt_b1', 'p_bob', 'flaky test', 'fix/flake')],
        terminals: [terminal('t_b1', 'wt_b1', { agent: 'codex', lastOutputAt: Date.now() - 45_000 })]
      }
    })

    await Promise.all([alice.service.start(), bob.service.start()])
  }, 60_000)

  afterAll(async () => {
    alice?.service.stop()
    bob?.service.stop()
    await relay?.stop()
  })

  it('handshakes through the relay’s own splice and reaches connected on both sides', async () => {
    await until(waiters, () => phase(alice, 'p_alice') === 'connected', 'Alice to connect')
    await until(waiters, () => phase(bob, 'p_bob') === 'connected', 'Bob to connect')

    expect(phase(alice, 'p_alice')).toBe('connected')
    expect(phase(bob, 'p_bob')).toBe('connected')
  })

  it('carries a presence snapshot end to end, encrypted, with the panes in it', async () => {
    await until(
      waiters,
      () => alice.service.presence({ projectId: 'p_alice' }).worktrees.length === 1,
      'Bob’s worktree to reach Alice'
    )

    const [seen] = alice.service.presence({ projectId: 'p_alice' }).worktrees
    expect(seen?.handle).toBe('bob')
    expect(seen?.name).toBe('flaky test')
    expect(seen?.branch).toBe('fix/flake')
    expect(seen?.panes[0]?.agent).toBe('codex')
    expect(seen?.panes[0]?.quietForMs).toBeGreaterThanOrEqual(45_000)
  })

  it('sends a fresh snapshot when the far side’s workspace moves', async () => {
    bob.workspace.worktrees.push(worktree('wt_b2', 'p_bob', 'second thing', 'feat/second'))
    bob.changed()

    await until(
      waiters,
      () => alice.service.presence({ projectId: 'p_alice' }).worktrees.length === 2,
      'the second worktree to reach Alice'
    )
    expect(alice.service.presence({ projectId: 'p_alice' }).worktrees.map((entry) => entry.name)).toEqual([
      'flaky test',
      'second thing'
    ])
  })
})

function phase(runtime: PeerRuntime, projectId: string): string | undefined {
  return runtime.service.status({ projectId }).links[0]?.phase
}
