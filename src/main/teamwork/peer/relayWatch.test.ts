// Watching a teammate's pane, end to end, with nothing in the middle faked.
//
// The relay is the real container host in a child process, on a real port. The
// crypto is real Noise between real identities. The pane is a real PTY with a
// real process in it, reached through the terminal service exactly as it was
// already written — which is the claim milestone C rests on: `terminal.read`
// and `terminal.subscribe` do not learn that the caller is two thousand miles
// away, and nothing in `src/main/terminals` was touched to make this work.
//
// `paneWatch.test.ts` is the companion to this file and covers the one thing it
// cannot: the join between the scrollback and the live tail with the two
// answers resolved in an order chosen by hand. Everything here is real and
// therefore arrives when it arrives.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Params } from '../../../shared/methods'
import type { StreamEvent } from '../../../shared/protocol'
import { ErrorCode } from '../../../shared/protocol'
import { createDispatcher } from '../../runtime/dispatcher'
import { MethodRegistry } from '../../runtime/methodRegistry'
import { createRuntimeContext } from '../../runtime/runtimeContext'
import { SubscriptionHub } from '../../runtime/subscriptionHub'
import { canSpawnPty } from '../../terminals/pty-test-support'
import { loadIdentity, loadStaticPrivateKey } from '../identity'
import { createPeerLink, type LinkScheduler, type PeerLink } from './peerLink'
import {
  createPeerRuntime,
  fixedRemoteRunner,
  makeProjectDir,
  project,
  worktree,
  type PeerRuntime
} from './peerTestSupport'
import { normaliseRemote, projectKeyFor } from './projectKey'
import { webSocketDialer } from './relaySocket'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const RELAY_ENTRY = join(REPO_ROOT, 'relay', 'dist', 'node', 'index.js')
const RELAY_BUILT = existsSync(RELAY_ENTRY)
const PTYS_WORK = canSpawnPty()
const ORIGIN = 'git@example.invalid:team/repo.git'

if (!RELAY_BUILT) {
  console.warn(
    `[peer] skipping the real-relay watch tests: ${RELAY_ENTRY} is not there.\n` +
      '[peer] build it with:  cd relay && npm install && npm run build'
  )
}
if (!PTYS_WORK) {
  console.warn('[peer] skipping the real-relay watch tests: this environment cannot fork a pty.')
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

async function startRelay(): Promise<RunningRelay> {
  const child = spawn(process.execPath, [RELAY_ENTRY], {
    cwd: join(REPO_ROOT, 'relay'),
    env: { ...process.env, RELAY_HOST: '127.0.0.1', RELAY_PORT: '0', RELAY_PAIR_TIMEOUT_MS: '60000' },
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
        child.kill('SIGTERM')
      })
  }
}

/**
 * Polls a condition the test cannot be woken for.
 *
 * The link's own changes fire `onChange`, but a byte arriving at a pane does
 * not, and neither does a PTY getting round to echoing it. The timeout is a
 * failure mode, not a delay.
 */
async function until(predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** One window's worth of subscriptions, as the IPC bridge would register them. */
type Window = {
  connectionId: string
  frames: StreamEvent[]
  eventsOn: (subscription: string) => unknown[]
  outputOn: (subscription: string) => string
}

function openWindow(runtime: PeerRuntime, connectionId: string): Window {
  const frames: StreamEvent[] = []
  runtime.subscriptions.openConnection(connectionId, (frame) => frames.push(frame))
  const eventsOn = (subscription: string): unknown[] =>
    frames.filter((frame) => frame.stream === subscription).map((frame) => frame.event)
  return {
    connectionId,
    frames,
    eventsOn,
    outputOn: (subscription) =>
      eventsOn(subscription)
        .filter((event): event is { type: 'data'; data: string } => (event as { type?: string }).type === 'data')
        .map((event) => event.data)
        .join('')
  }
}

describe.skipIf(!RELAY_BUILT || !PTYS_WORK)('watching a teammate’s pane over the real relay', () => {
  let relay: RunningRelay
  let alice: PeerRuntime
  let bob: PeerRuntime
  /** A third member on a raw link, so "two watchers" means two people. */
  let carol: PeerLink
  let carolPhase = 'connecting'
  let paneId: string
  let terminalId: string

  const aliceWatch = async (
    id: string,
    connectionId: string
  ): Promise<{ subscription: string; cols: number; rows: number; handle: string }> => {
    const response = await alice.dispatch(
      { id: `watch_${connectionId}_${id}`, method: 'teamwork.watch', params: { projectId: 'p_alice', paneId: id } },
      { connectionId }
    )
    if (!('ok' in response) || response.ok !== true) throw new Error(JSON.stringify(response))
    return response.result as { subscription: string; cols: number; rows: number; handle: string }
  }

  const aliceRelease = async (subscription: string, connectionId: string): Promise<void> => {
    await alice.dispatch(
      { id: `drop_${subscription}`, method: 'unsubscribe', params: { subscription } },
      { connectionId }
    )
  }

  /** A pane of Bob's, waited for until Alice can name it. */
  const openPane = async (command: string): Promise<{ terminalId: string; paneId: string }> => {
    const created = await bob.terminals?.handlers['terminal.create']({ worktreeId: 'wt_b1', command })
    const id = created?.id ?? ''
    const namespaced = `${paneId.slice(0, paneId.lastIndexOf(':') + 1)}${id}`
    bob.changed()
    await until(
      () =>
        alice.service
          .presence({ projectId: 'p_alice' })
          .worktrees.some((row) => row.panes.some((pane) => pane.id === namespaced)),
      `the pane ${id} to reach Alice`
    )
    return { terminalId: id, paneId: namespaced }
  }

  /** Makes the pane say something a test can look for, through a real pty. */
  const say = (what: string): void => {
    bob.terminals?.manager.write(terminalId, `${what}\n`)
  }

  beforeAll(async () => {
    relay = await startRelay()

    const aliceData = await makeProjectDir([])
    const bobData = await makeProjectDir([])
    const carolData = await makeProjectDir([])
    const aliceKey = (await loadIdentity(aliceData)).publicKey
    const bobKey = (await loadIdentity(bobData)).publicKey
    const carolKey = (await loadIdentity(carolData)).publicKey
    const roster = [
      { handle: 'alice', publicKey: aliceKey },
      { handle: 'bob', publicKey: bobKey },
      { handle: 'carol', publicKey: carolKey }
    ]

    const shared = {
      dial: webSocketDialer,
      scheduler: realScheduler,
      env: { TEAMREE_RELAY_URL: relay.url },
      runner: fixedRemoteRunner(ORIGIN),
      onChange: () => {}
    }

    alice = await createPeerRuntime({
      ...shared,
      dataDir: aliceData,
      workspace: { projects: [project('p_alice', await makeProjectDir(roster))], worktrees: [], terminals: [] }
    })
    bob = await createPeerRuntime({
      ...shared,
      dataDir: bobData,
      withTerminals: true,
      workspace: {
        projects: [project('p_bob', await makeProjectDir(roster))],
        worktrees: [worktree('wt_b1', 'p_bob', 'flaky test', 'fix/flake')],
        terminals: []
      }
    })

    await Promise.all([alice.service.start(), bob.service.start()])

    // A pane that says back whatever is written to it, with the tty's own echo
    // turned off so what arrives is exactly what the test asked for.
    const created = await bob.terminals?.handlers['terminal.create']({
      worktreeId: 'wt_b1',
      command: 'stty -echo 2>/dev/null; cat'
    })
    terminalId = created?.id ?? ''
    // The namespace `teamwork.presence` puts on a teammate's ids, rebuilt here
    // rather than read out of a snapshot, so a change to either is a failure
    // and not a test that quietly agrees with itself.
    paneId = `peer:${bobKey.slice(0, 12)}:${terminalId}`
    bob.changed()

    // Carol is a link and not a runtime: she is here to ask for things, and
    // what she is allowed to ask is the whole point of her. She still answers
    // presence, because Bob's own link to her subscribes to it the moment it
    // confirms and would tear the session down if nobody were home.
    const carolHub = new SubscriptionHub()
    const carolRegistry = new MethodRegistry(
      createRuntimeContext({ version: 'test', store: {} as never, subscriptions: carolHub })
    )
    carolRegistry.register('peer.presence', Params.peerPresence, () => ({
      revision: 1,
      handle: 'carol',
      projects: []
    }))
    carolRegistry.register('peer.subscribe', Params.peerSubscribe, (_params, call) => ({
      subscription: carolHub.subscribe(call.connectionId, () => () => {})
    }))
    const carolDispatch = createDispatcher(carolRegistry)

    carol = createPeerLink({
      remotePublicKey: bobKey,
      handle: 'carol',
      projectKey: projectKeyFor(normaliseRemote(ORIGIN) ?? ''),
      staticPrivateKey: await loadStaticPrivateKey(carolData),
      relayUrl: relay.url,
      connectionId: 'carol_link',
      dial: webSocketDialer,
      dispatch: carolDispatch,
      subscriptions: carolHub,
      scheduler: realScheduler,
      onStatusChange: (status) => {
        carolPhase = status.phase
      },
      onPresence: () => {}
    })
    carol.start()

    await until(() => carolPhase === 'connected', 'Carol’s raw link to connect')
    await until(
      () => alice.service.presence({ projectId: 'p_alice' }).worktrees.some((row) => row.panes.length > 0),
      'Bob’s pane to reach Alice'
    )
  }, 60_000)

  afterAll(async () => {
    carol?.stop()
    alice?.service.stop()
    bob?.service.stop()
    await bob?.terminals?.shutdown()
    await relay?.stop()
  })

  it('sends no output at all until somebody opens the pane', async () => {
    const window = openWindow(alice, 'window_quiet')
    say('before anybody was looking')
    // Long enough that a runtime that streamed by default would have.
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(window.frames).toEqual([])
    expect(bob.service.watchers({ projectId: 'p_bob' }).panes).toEqual([])
  })

  it('carries the scrollback and then the live tail, each line exactly once', async () => {
    const window = openWindow(alice, 'window_join')
    const opened = await aliceWatch(paneId, 'window_join')

    // The scrollback contains what the pane said while nobody was watching,
    // which is the point of reading it at all.
    await until(() => window.outputOn(opened.subscription).includes('before anybody was looking'), 'the scrollback')

    say('and this is live')
    await until(() => window.outputOn(opened.subscription).includes('and this is live'), 'the live tail')

    const seen = window.outputOn(opened.subscription)
    // Once. A join that replayed the overlap would show the scrollback's last
    // lines twice, which is the failure this seam exists to avoid.
    expect(seen.split('before anybody was looking').length - 1).toBe(1)
    expect(seen.split('and this is live').length - 1).toBe(1)

    await aliceRelease(opened.subscription, 'window_join')
  })

  it('letterboxes to the owner’s dimensions rather than resizing their pty', async () => {
    const before = bob.terminals?.manager.list('wt_b1')[0]
    const window = openWindow(alice, 'window_size')
    const opened = await aliceWatch(paneId, 'window_size')

    expect(opened.handle).toBe('bob')
    expect(opened.cols).toBe(before?.cols)
    expect(opened.rows).toBe(before?.rows)

    // And nothing a watcher did changed them. There is no method through which
    // it could: `terminal.resize` is not on the teammate's allow-list.
    const after = bob.terminals?.manager.list('wt_b1')[0]
    expect(after?.cols).toBe(before?.cols)
    expect(after?.rows).toBe(before?.rows)

    // And output does reach this window, so the sizes above are not the answer
    // to a watch that never opened.
    await until(() => window.outputOn(opened.subscription).length > 0, 'the scrollback')
    await aliceRelease(opened.subscription, 'window_size')
  })

  it('stops sending bytes the moment the last watcher closes the pane', async () => {
    const window = openWindow(alice, 'window_stop')
    const opened = await aliceWatch(paneId, 'window_stop')
    say('while it is open')
    await until(() => window.outputOn(opened.subscription).includes('while it is open'), 'output while open')

    await aliceRelease(opened.subscription, 'window_stop')
    await until(() => bob.service.watchers({ projectId: 'p_bob' }).panes.length === 0, 'Bob to see nobody reading')

    const afterClose = window.outputOn(opened.subscription)
    say('after it was closed')
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(window.outputOn(opened.subscription)).toBe(afterClose)
    expect(window.outputOn(opened.subscription)).not.toContain('after it was closed')
  })

  it('tells the owner who is reading the pane, by name, while they read it', async () => {
    const window = openWindow(alice, 'window_named')
    const opened = await aliceWatch(paneId, 'window_named')
    await until(() => bob.service.watchers({ projectId: 'p_bob' }).panes.length === 1, 'Bob to see Alice reading')

    const [pane] = bob.service.watchers({ projectId: 'p_bob' }).panes
    expect(pane?.terminalId).toBe(terminalId)
    expect(pane?.watchers.map((watcher) => watcher.handle)).toEqual(['alice'])

    expect(pane?.watchers[0]?.since).toBeGreaterThan(0)

    // Waited for rather than assumed: this says the row above was a real watch
    // and not a name Bob filed against a stream that never carried anything,
    // and frames arrive over a socket rather than in the turn that asked.
    await until(() => window.frames.length > 0, 'the watch to deliver something')

    await aliceRelease(opened.subscription, 'window_named')
    await until(() => bob.service.watchers({ projectId: 'p_bob' }).panes.length === 0, 'Bob to see Alice leave')
  })

  it('names both of them when two teammates read one pane, and the right one when one leaves', async () => {
    openWindow(alice, 'window_two')
    const opened = await aliceWatch(paneId, 'window_two')
    const carolStream = await carol.call('terminal.subscribe', { terminalId })

    await until(
      () => (bob.service.watchers({ projectId: 'p_bob' }).panes[0]?.watchers.length ?? 0) === 2,
      'Bob to see two readers'
    )
    expect(bob.service.watchers({ projectId: 'p_bob' }).panes[0]?.watchers.map((w) => w.handle)).toEqual([
      'alice',
      'carol'
    ])

    await carol.call('unsubscribe', { subscription: carolStream.subscription })
    await until(
      () => bob.service.watchers({ projectId: 'p_bob' }).panes[0]?.watchers.length === 1,
      'Bob to see one reader'
    )
    expect(bob.service.watchers({ projectId: 'p_bob' }).panes[0]?.watchers.map((w) => w.handle)).toEqual(['alice'])

    await aliceRelease(opened.subscription, 'window_two')
  })

  it('refuses a teammate’s keystroke, because typing into a pane is not a method they can call', async () => {
    await expect(carol.call('terminal.write', { terminalId, data: 'rm -rf /\n' })).rejects.toMatchObject({
      code: ErrorCode.UnknownMethod
    })
    // And the rest of the surface a reader must not have either.
    await expect(carol.call('terminal.resize', { terminalId, cols: 10, rows: 5 })).rejects.toMatchObject({
      code: ErrorCode.UnknownMethod
    })
    await expect(carol.call('terminal.close', { terminalId })).rejects.toMatchObject({
      code: ErrorCode.UnknownMethod
    })
    await expect(carol.call('worktree.remove', { worktreeId: 'wt_b1' })).rejects.toMatchObject({
      code: ErrorCode.UnknownMethod
    })

    // The pane is still there and still says what it is told to.
    expect(bob.terminals?.manager.list('wt_b1')).toHaveLength(1)
  })

  it('shows the owner’s own pane and a teammate’s reading of it at the same time', async () => {
    const theirs = openWindow(bob, 'bob_window')
    const mine = openWindow(alice, 'window_both')
    const opened = await aliceWatch(paneId, 'window_both')

    const own = await bob.dispatch(
      { id: 'own', method: 'terminal.subscribe', params: { terminalId } },
      { connectionId: 'bob_window' }
    )
    const ownStream = (own as { result: { subscription: string } }).result.subscription

    say('both of us are looking')
    await until(() => mine.outputOn(opened.subscription).includes('both of us are looking'), 'Alice to see it')
    await until(() => theirs.outputOn(ownStream).includes('both of us are looking'), 'Bob to see his own pane')

    await aliceRelease(opened.subscription, 'window_both')
  })

  it('tells a watcher the pane exited rather than leaving them on a window that stopped', async () => {
    // It ends when its input does, so the exit happens while somebody is
    // already reading rather than before they arrive.
    const mortal = await openPane('stty -echo 2>/dev/null; cat; exit 7')

    const window = openWindow(alice, 'window_exit')
    const opened = await aliceWatch(mortal.paneId, 'window_exit')
    // Bob's own books are the only honest evidence the watch is live: this pane
    // has said nothing yet, so waiting on its output would be waiting on a
    // condition that is already true and therefore on nothing at all.
    await until(
      () => bob.service.watchers({ projectId: 'p_bob' }).panes.some((row) => row.terminalId === mortal.terminalId),
      'Bob to see the reader'
    )

    bob.terminals?.manager.write(mortal.terminalId, '\u0004')
    await until(
      () => window.eventsOn(opened.subscription).some((event) => (event as { type?: string }).type === 'exit'),
      'the exit to reach Alice'
    )

    const exit = window.eventsOn(opened.subscription).find((event) => (event as { type?: string }).type === 'exit')
    expect(exit).toMatchObject({ type: 'exit', exitCode: 7 })
    await aliceRelease(opened.subscription, 'window_exit')
  })

  it('tells a watcher when the owner closes the pane out from under them', async () => {
    const doomed = await openPane('stty -echo 2>/dev/null; cat')

    const window = openWindow(alice, 'window_closed')
    const opened = await aliceWatch(doomed.paneId, 'window_closed')
    await until(
      () => bob.service.watchers({ projectId: 'p_bob' }).panes.some((row) => row.terminalId === doomed.terminalId),
      'Bob to see the reader'
    )

    await bob.terminals?.handlers['terminal.close']({ terminalId: doomed.terminalId })

    await until(
      () => window.eventsOn(opened.subscription).some((event) => (event as { type?: string }).type === 'lost'),
      'Alice to be told the pane went'
    )
    expect(window.eventsOn(opened.subscription)).toContainEqual({
      type: 'lost',
      reason: 'the owner closed this pane'
    })
  })

  it('ends a watch when the link drops, and lets a fresh one open when it is back', async () => {
    const window = openWindow(alice, 'window_drop')
    const opened = await aliceWatch(paneId, 'window_drop')
    say('before the drop')
    await until(() => window.outputOn(opened.subscription).includes('before the drop'), 'output before the drop')

    // Bob's machine goes away, which is what a closed laptop is from here.
    bob.service.stop()
    await until(
      () => window.eventsOn(opened.subscription).some((event) => (event as { type?: string }).type === 'lost'),
      'Alice to be told the link went'
    )

    // And it comes back. A new watch on the same pane works; the old one is
    // over, because the subscription it was made of is gone on both machines.
    await bob.service.start()
    bob.changed()
    await until(() => {
      try {
        return alice.service.status({ projectId: 'p_alice' }).links[0]?.phase === 'connected'
      } catch {
        return false
      }
    }, 'the link to come back')
    await until(
      () => alice.service.presence({ projectId: 'p_alice' }).worktrees.some((row) => row.panes.length > 0),
      'Bob’s panes to reach Alice again'
    )

    const again = openWindow(alice, 'window_again')
    const reopened = await aliceWatch(paneId, 'window_again')
    say('after the drop')
    await until(() => again.outputOn(reopened.subscription).includes('after the drop'), 'output after the drop')
    await aliceRelease(reopened.subscription, 'window_again')
  }, 40_000)
})
