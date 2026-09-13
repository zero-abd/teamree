// Two runtimes on one machine, and something in the middle of them.
//
// There are two middles here and the difference matters. `createFakeRelay`
// speaks the documented protocol in this process, which is what makes the
// failure paths testable at all: a relay that restarts mid-session, a peer that
// vanishes, a rendezvous claimed twice. `relayProcess.ts` runs the real relay
// and is what stops any of that being a story about a mock.
//
// Everything is driven by a manual clock and a manual timer queue. Nothing here
// sleeps: a test that waits on wall-clock time is a test that fails on a busy
// machine and passes on a quiet one, and the relay's own suite already holds
// that line.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project, Terminal, Worktree } from '../../../shared/entities'
import type { GitRunner } from '../../git/gitProcess'
import type { TeammateCache } from '../../store/teammateCache'
import { formatMemberFile, MEMBER_FILE_SUFFIX, MEMBERS_DIR_SEGMENTS } from '../memberFile'
import { createDispatcher, type Dispatcher } from '../../runtime/dispatcher'
import { MethodRegistry } from '../../runtime/methodRegistry'
import { createRuntimeContext } from '../../runtime/runtimeContext'
import { SubscriptionHub } from '../../runtime/subscriptionHub'
import { createTerminalService, registerTerminalHandlers, type TerminalService } from '../../terminals/method-handlers'
import { registerUnsubscribeHandler } from '../../runtime/handlers/unsubscribeHandler'
import { registerPeerHandlers } from './handlers'
import type { LinkScheduler } from './peerLink'
import { PeerService } from './peerService'
import type { RelayDialer, RelaySocketHandlers } from './relaySocket'

// ---------------------------------------------------------------- the clock

export type ManualScheduler = LinkScheduler & {
  /** Runs every timer due at or before `now + ms`, advancing as it goes. */
  advance: (ms: number) => Promise<void>
  /** Lets queued microtasks and promise callbacks run without moving the clock. */
  settle: () => Promise<void>
  pending: () => number
}

export function createManualScheduler(startAt = 1_700_000_000_000): ManualScheduler {
  let current = startAt
  let sequence = 0
  const timers = new Map<number, { at: number; run: () => void }>()

  const settle = async (): Promise<void> => {
    // Several turns, because one peer's reply schedules the other's work, which
    // schedules the reply to that.
    for (let turn = 0; turn < 64; turn += 1) await Promise.resolve()
  }

  return {
    now: () => current,
    // Fixed rather than random: jitter is the point in production and the enemy
    // in a test, and `scheduleRetry` multiplies by whatever this returns.
    random: () => 1,
    setTimer: (run, delayMs) => {
      sequence += 1
      const id = sequence
      timers.set(id, { at: current + Math.max(0, delayMs), run })
      return () => {
        timers.delete(id)
      }
    },
    advance: async (ms) => {
      const target = current + ms
      await settle()
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])
        const next = due[0]
        if (!next) break
        timers.delete(next[0])
        current = Math.max(current, next[1].at)
        next[1].run()
        await settle()
      }
      current = target
      await settle()
    },
    settle,
    pending: () => timers.size
  }
}

// ------------------------------------------------------------- the fake relay

export type FakeRelay = {
  dial: RelayDialer
  /** Closes every live connection with a code, the way a real one does. */
  closeAll: (code: number, reason: string) => void
  /** Refuses new connections until `resume`, so "relay unreachable" is testable. */
  pause: () => void
  resume: () => void
  connections: () => number
  /** Every rendezvous token that has been presented, in order. */
  greetings: () => readonly string[]
  /**
   * Stops forwarding content while still pairing, which is the shape a peer is
   * left in by a replayer: the handshake completes and nothing can ever be said
   * over it.
   */
  holdContent: () => void
  releaseContent: () => void
}

type FakePeer = {
  token: string
  handlers: RelaySocketHandlers
  partner: FakePeer | undefined
  open: boolean
  close: (code: number, reason: string) => void
  /** Queued, never immediate: see `deliver` below for why that is the point. */
  sayTo: (deliver: () => void) => void
  text: (frame: string) => void
  deliver: (payload: Uint8Array) => void
}

/**
 * The relay's rules, as `relay/README.md` states them and only those.
 *
 * Registration is one synchronous step, so whichever hello is read first parks
 * and the second pairs with it; a third connection on a live rendezvous ends
 * that session with `4002` for both and parks the newcomer; a peer that goes
 * closes its partner with `4001`.
 */
export function createFakeRelay(): FakeRelay {
  const waiting = new Map<string, FakePeer>()
  const sessions = new Map<string, [FakePeer, FakePeer]>()
  const live = new Set<FakePeer>()
  const seen: string[] = []
  let paused = false
  let holding = false
  let sessionSeq = 0
  const held: (() => void)[] = []

  const unregister = (peer: FakePeer): void => {
    live.delete(peer)
    if (waiting.get(peer.token) === peer) waiting.delete(peer.token)
    const pair = sessions.get(peer.token)
    if (pair && (pair[0] === peer || pair[1] === peer)) {
      sessions.delete(peer.token)
      const other = pair[0] === peer ? pair[1] : pair[0]
      if (other.open) other.close(4001, 'partner disconnected')
    }
  }

  const register = (peer: FakePeer): void => {
    seen.push(peer.token)
    const existing = sessions.get(peer.token)
    if (existing) {
      // It cannot tell the two apart — they are two anonymous connections that
      // presented the same token — so ending the session is the only answer
      // that is right whichever of them came back.
      sessions.delete(peer.token)
      for (const member of existing) if (member.open) member.close(4002, 'superseded')
    }
    const parked = waiting.get(peer.token)
    if (parked && parked.open && parked !== peer) {
      waiting.delete(peer.token)
      parked.partner = peer
      peer.partner = parked
      sessions.set(peer.token, [parked, peer])
      sessionSeq += 1
      const session = `s${sessionSeq}`
      parked.text(JSON.stringify({ t: 'paired', session, initiator: true }))
      peer.text(JSON.stringify({ t: 'paired', session, initiator: false }))
      return
    }
    waiting.set(peer.token, peer)
    peer.text('{"t":"waiting"}')
  }

  const dial: RelayDialer = (url, handlers) => {
    const peer: FakePeer = {
      token: '',
      handlers,
      partner: undefined,
      open: true,
      close: (code, reason) => {
        if (!peer.open) return
        peer.open = false
        unregister(peer)
        handlers.onClosed(code, reason)
      },
      /**
       * Everything the relay says to a peer is queued rather than called.
       *
       * A real relay writes frames onto a socket, and a peer reads them in the
       * order they were written and no sooner. Calling the handler in place
       * lets one peer's reaction to a frame reach the other before that other
       * has been told it is paired at all — which is not something the real
       * relay can do, so a fake that can is a fake that hides bugs and invents
       * others. Microtasks are FIFO, so order per connection is kept.
       */
      sayTo: (say) => queueMicrotask(say),
      text: (frame) => {
        peer.sayTo(() => {
          if (peer.open) handlers.onText(frame)
        })
      },
      deliver: (payload) => {
        const hand = (): void => {
          if (peer.open) handlers.onBinary(payload)
        }
        if (holding) held.push(hand)
        else peer.sayTo(hand)
      }
    }

    if (paused) {
      // No close code at all, which is what a socket that never opened gives.
      queueMicrotask(() => peer.close(0, 'the relay could not be reached'))
      return { sendText: () => {}, sendBinary: () => {}, close: () => {} }
    }
    if (!/\/[0-9a-f]{64}$/.test(url)) {
      queueMicrotask(() => peer.close(4000, 'the rendezvous id is not in the path'))
      return { sendText: () => {}, sendBinary: () => {}, close: () => {} }
    }

    live.add(peer)
    queueMicrotask(() => {
      if (peer.open) handlers.onOpen()
    })

    return {
      sendText: (text) => {
        if (!peer.open) return
        let hello: { t?: unknown; version?: unknown; rendezvous?: unknown }
        try {
          hello = JSON.parse(text) as typeof hello
        } catch {
          peer.close(4000, 'hello is not JSON')
          return
        }
        if (hello.t === 'ping') {
          peer.text('{"t":"pong"}')
          return
        }
        if (peer.token) {
          peer.close(4008, 'a second hello')
          return
        }
        if (hello.version !== 1 || typeof hello.rendezvous !== 'string' || !/^[0-9a-f]{64}$/.test(hello.rendezvous)) {
          peer.close(4000, 'bad hello')
          return
        }
        peer.token = hello.rendezvous
        register(peer)
      },
      sendBinary: (payload) => {
        if (!peer.open) return
        // The whole splice, and the only place a payload goes.
        peer.partner?.deliver(payload)
      },
      close: (code = 1000, reason = '') => peer.close(code, reason)
    }
  }

  return {
    dial,
    closeAll: (code, reason) => {
      for (const peer of [...live]) peer.close(code, reason)
    },
    pause: () => {
      paused = true
    },
    resume: () => {
      paused = false
    },
    connections: () => live.size,
    greetings: () => seen,
    holdContent: () => {
      holding = true
    },
    releaseContent: () => {
      holding = false
      const queued = held.splice(0, held.length)
      for (const hand of queued) queueMicrotask(hand)
    }
  }
}

// --------------------------------------------------------------- two runtimes

export type FakeWorkspace = {
  projects: Project[]
  worktrees: Worktree[]
  terminals: Terminal[]
}

export type PeerRuntime = {
  service: PeerService
  dispatch: Dispatcher
  subscriptions: SubscriptionHub
  workspace: FakeWorkspace
  dataDir: string
  /**
   * Real PTYs, when the runtime was built with them.
   *
   * A watch test needs a pane that actually exists on the owner's machine: the
   * point of milestone C is that a teammate reaches `terminal.subscribe` and
   * `terminal.read` as the terminal service already implements them, and a
   * stand-in for that service would be testing the stand-in.
   */
  terminals?: TerminalService
  /** Fires the change the workspace bus would have fired. */
  changed: () => void
  changes: () => number
}

export type PeerRuntimeOptions = {
  workspace: FakeWorkspace
  dial: RelayDialer
  scheduler: LinkScheduler
  env?: NodeJS.ProcessEnv
  /** Ready-made keypair directory; one is created when this is left out. */
  dataDir?: string
  /**
   * Stands in for git. Real repositories are used where the question is about
   * git; everywhere else the only thing asked of it is the origin remote, and a
   * fixed answer keeps the test about the transport.
   */
  runner?: GitRunner
  /** Lets a test drive the cache directly, and flush it before a restart. */
  cache?: TeammateCache
  /** Lets a test wait on a condition instead of on the clock. */
  onChange?: () => void
  /**
   * Registers the real terminal service, with real PTYs, and reports its panes
   * as this runtime's terminals. Off by default: most peer tests are about the
   * transport and have no use for a process.
   */
  withTerminals?: boolean
}

/** One origin per checkout, for tests about two repositories at once. */
export function remoteRunner(byPath: Readonly<Record<string, string>>): GitRunner {
  return {
    binary: 'git',
    run: () => Promise.reject(new Error('not used')),
    tryRun: ({ args, cwd }) => {
      const remote = byPath[cwd ?? '']
      return Promise.resolve(
        args.join(' ') === 'remote get-url origin' && remote !== undefined
          ? { exitCode: 0, stdout: `${remote}\n`, stderr: '' }
          : { exitCode: 1, stdout: '', stderr: '' }
      )
    }
  }
}

/** Answers `git remote get-url origin` with one URL and refuses everything else. */
export function fixedRemoteRunner(originUrl: string): GitRunner {
  return {
    binary: 'git',
    run: () => Promise.reject(new Error('not used')),
    tryRun: ({ args }) =>
      Promise.resolve(
        args.join(' ') === 'remote get-url origin'
          ? { exitCode: 0, stdout: `${originUrl}\n`, stderr: '' }
          : { exitCode: 1, stdout: '', stderr: '' }
      )
  }
}

/** A project directory with a roster in it, which is all the peer path reads. */
export async function makeProjectDir(members: readonly { handle: string; publicKey: string }[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'teamree-project-'))
  await mkdir(join(root, ...MEMBERS_DIR_SEGMENTS), { recursive: true })
  await Promise.all(
    members.map((member) =>
      writeFile(
        join(root, ...MEMBERS_DIR_SEGMENTS, `${member.handle}${MEMBER_FILE_SUFFIX}`),
        formatMemberFile({ handle: member.handle, publicKey: member.publicKey, addedAt: '2026-01-01' }),
        'utf8'
      )
    )
  )
  return root
}

/**
 * One runtime, assembled the way `startRuntime` assembles the real one:
 * registry, then handlers, then the dispatcher, then the peer service — because
 * a peer that reached a half-built registry would be told a method does not
 * exist when it merely did not exist yet.
 */
export async function createPeerRuntime(options: PeerRuntimeOptions): Promise<PeerRuntime> {
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'teamree-peer-')))
  const subscriptions = new SubscriptionHub()
  const context = createRuntimeContext({
    version: 'test',
    // The peer service reads the workspace through its own narrow port, so the
    // store on the context is only here to satisfy the shape.
    store: {} as never,
    subscriptions
  })
  const registry = new MethodRegistry(context)

  // Registered before the dispatcher exists, exactly as the real runtime does
  // it, so a teammate that arrives early cannot be told a method is missing
  // when it merely was not registered yet.
  const terminals = options.withTerminals
    ? createTerminalService({
        subscriptions,
        resolveWorktreeCwd: () => tmpdir()
      })
    : undefined
  if (terminals) registerTerminalHandlers(registry, terminals)
  // Transport-level and always present in the real runtime. Without it every
  // stream a test opened would stay open, which is the opposite of what the
  // bytes-on-demand rule is for.
  registerUnsubscribeHandler(registry)

  let changes = 0
  const service = new PeerService({
    workspace: {
      listProjects: () => options.workspace.projects,
      listWorktrees: (projectId) =>
        options.workspace.worktrees.filter((worktree) => projectId === undefined || worktree.projectId === projectId),
      // Real panes when there are real panes, so a snapshot a watcher resolves
      // a pane id against describes a process that is genuinely running.
      listTerminals: (worktreeId) =>
        terminals
          ? terminals.manager.list(worktreeId)
          : options.workspace.terminals.filter((terminal) => terminal.worktreeId === worktreeId)
    },
    dataDir,
    subscriptions,
    dial: options.dial,
    scheduler: options.scheduler,
    env: options.env ?? {},
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.cache ? { cache: options.cache } : {}),
    onChange: () => {
      changes += 1
      options.onChange?.()
    }
  })

  registerPeerHandlers(registry, service)
  const dispatch = createDispatcher(registry)
  service.attach(dispatch)

  return {
    service,
    dispatch,
    subscriptions,
    workspace: options.workspace,
    dataDir,
    ...(terminals ? { terminals } : {}),
    changed: () => service.notifyWorkspaceChanged(),
    changes: () => changes
  }
}

// ------------------------------------------------------------- tiny builders

export function project(id: string, path: string): Project {
  return { id, name: id, path, baseRef: 'origin/main' }
}

export function worktree(id: string, projectId: string, name: string, branch: string): Worktree {
  return {
    id,
    projectId,
    name,
    branch,
    path: `/tmp/${id}`,
    startedFrom: 'origin/main',
    state: 'ready',
    createdAt: 0
  }
}

export function terminal(id: string, worktreeId: string, overrides: Partial<Terminal> = {}): Terminal {
  return {
    id,
    worktreeId,
    title: 'bash',
    cwd: `/tmp/${worktreeId}`,
    shell: '/bin/bash',
    cols: 80,
    rows: 24,
    running: true,
    busy: false,
    lastOutputAt: 0,
    ...overrides
  }
}
