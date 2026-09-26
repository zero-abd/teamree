// Two runtimes on one machine, and something in the middle: `createFakeRelay` speaks the documented
// protocol in-process so failure paths are testable; `relayProcess.ts` runs the real relay.
// Everything is driven by a manual clock and timer queue. Nothing here sleeps.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project, TeammatePresenceRead, TeamworkRead, Terminal, Worktree } from '../../../shared/entities'
import type { GitRunner } from '../../git/gitProcess'
import type { TeammateCache } from '../../store/teammateCache'
import { formatMemberFile, MEMBER_FILE_SUFFIX, MEMBERS_DIR_SEGMENTS } from '../memberFile'
import { createDispatcher, type Dispatcher } from '../../runtime/dispatcher'
import { MethodRegistry } from '../../runtime/methodRegistry'
import { createRuntimeContext } from '../../runtime/runtimeContext'
import { SubscriptionHub } from '../../runtime/subscriptionHub'
import { createTerminalService, registerTerminalHandlers, type TerminalService } from '../../terminals/method-handlers'
import { registerUnsubscribeHandler } from '../../runtime/handlers/unsubscribeHandler'
import type { RemoteWriteDecision, RemoteWriteVerdict } from '../../runtime/peerTransport'
import { registerPeerHandlers } from './handlers'
import type { LinkScheduler } from './peerLink'
import { PeerService, type ConsentStore, type MuteStore, type PeerServiceOptions } from './peerService'
import type { RelayDialer, RelaySocketHandlers } from './relaySocket'
import type { WakeWatch } from './wakeWatch'

// ---------------------------------------------------------------- the clock

export type ManualScheduler = LinkScheduler & {
  /** Runs every timer due at or before `now + ms`, advancing as it goes. */
  advance: (ms: number) => Promise<void>
  /**
   * A machine suspended for `ms`: no timer ran, and the clocks come back disagreeing. Platforms split on
   * whether the monotonic source counts suspended time (macOS's does), so both shapes are offered.
   */
  sleep: (ms: number, monotonic?: 'counted' | 'uncounted') => Promise<void>
  /** Lets queued microtasks and promise callbacks run without moving the clock. */
  settle: () => Promise<void>
  pending: () => number
}

export function createManualScheduler(startAt = 1_700_000_000_000): ManualScheduler {
  let current = startAt
  /** The clock timers run on, apart from the wall clock: the whole sleep problem lives in the gap. */
  let monotonic = 0
  let sequence = 0
  const timers = new Map<number, { at: number; run: () => void }>()

  const settle = async (): Promise<void> => {
    // Several turns, because one peer's reply schedules the other's work, which
    // schedules the reply to that.
    for (let turn = 0; turn < 64; turn += 1) await Promise.resolve()
  }

  /** Everything due by `target` on the monotonic clock, in order, then settled. */
  const runDue = async (target: number): Promise<void> => {
    await settle()
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])
      const next = due[0]
      if (!next) break
      timers.delete(next[0])
      const step = Math.max(0, next[1].at - monotonic)
      monotonic += step
      current += step
      next[1].run()
      await settle()
    }
  }

  return {
    now: () => current,
    monotonicNow: () => monotonic,
    // Fixed rather than random: jitter is the point in production and the enemy
    // in a test, and `scheduleRetry` multiplies by whatever this returns.
    random: () => 1,
    setTimer: (run, delayMs) => {
      sequence += 1
      const id = sequence
      timers.set(id, { at: monotonic + Math.max(0, delayMs), run })
      return () => {
        timers.delete(id)
      }
    },
    advance: async (ms) => {
      const target = monotonic + ms
      const wallTarget = current + ms
      await runDue(target)
      monotonic = target
      current = wallTarget
      await settle()
    },
    sleep: async (ms, monotonicCounts = 'counted') => {
      // Nothing runs while suspended: the wall clock moves without a single timer firing.
      current += ms
      if (monotonicCounts === 'counted') monotonic += ms
      // And on waking, whatever is now overdue fires.
      await runDue(monotonic)
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
  /** Stops forwarding content while still pairing: the shape a replayer leaves a peer in. */
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
 * The relay's rules, as `relay/README.md` states them: first hello parks, second pairs; a third on a live
 * rendezvous ends that session with `4002` for both and parks the newcomer; a peer that goes closes its
 * partner with `4001`.
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
      // Two anonymous connections presented the same token, so ending the session is right whichever came back.
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
       * Everything the relay says is queued, never called in place: calling in place lets one peer's
       * reaction reach the other before it is told it is paired. Microtasks are FIFO, so order is kept.
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
  /** Real PTYs, when built with them: a watch test needs a pane that actually exists on the owner's machine. */
  terminals?: TerminalService
  /** Fires the change the workspace bus would have fired. */
  changed: () => void
  changes: () => number
  /** Everything reported through `onError`, in order. Always collected: a swallowed failure looks like none. */
  errors: () => readonly unknown[]
}

export type PeerRuntimeOptions = {
  workspace: FakeWorkspace
  dial: RelayDialer
  scheduler: LinkScheduler
  env?: NodeJS.ProcessEnv
  /** Ready-made keypair directory; one is created when this is left out. */
  dataDir?: string
  /** Stands in for git; only the origin remote is asked of it, so a fixed answer keeps the test on the transport. */
  runner?: GitRunner
  /** Lets a test drive the cache directly, and flush it before a restart. */
  cache?: TeammateCache
  /** Settings › Teamwork › Share Task Details, as the workspace answers it. */
  shareTaskDetails?: () => boolean
  /** Stands in for git's changed paths and commits ahead. */
  readTaskGit?: PeerServiceOptions['readTaskGit']
  /** Standing permissions this machine already holds at start, as a real runtime reads them from the workspace. */
  consent?: ConsentStore
  /** Panes this machine already has silenced when it starts; the mutes' half of `consent`. */
  mutes?: MuteStore
  /** Lets a test wait on a condition instead of on the clock. */
  onChange?: () => void
  /** Hears each note a teammate shares, as the app's notifications do. */
  onNote?: PeerServiceOptions['onNote']
  /** Stands in for Electron's power monitor, which no test process has. */
  watchWake?: WakeWatch
  /** Registers the real terminal service, with real PTYs. Off by default: most peer tests have no use for a process. */
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
 * One runtime, assembled in the real order — registry, handlers, dispatcher, peer service — so a peer
 * reaching a half-built registry is not told a method does not exist when it merely did not yet.
 */
export async function createPeerRuntime(options: PeerRuntimeOptions): Promise<PeerRuntime> {
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'teamree-peer-')))
  const subscriptions = new SubscriptionHub()
  const context = createRuntimeContext({
    version: 'test',
    // The peer service reads the workspace through its own port; the store is only here for the shape.
    store: {} as never,
    subscriptions
  })
  const registry = new MethodRegistry(context)

  // Registered before the dispatcher exists, as the real runtime does.
  const terminals = options.withTerminals
    ? createTerminalService({
        subscriptions,
        resolveWorktreeCwd: () => tmpdir()
      })
    : undefined
  if (terminals) registerTerminalHandlers(registry, terminals)
  // Transport-level and always present in the real runtime; without it every stream a test opened stays open.
  registerUnsubscribeHandler(registry)

  let changes = 0
  const errors: unknown[] = []
  const service = new PeerService({
    workspace: {
      listProjects: () => options.workspace.projects,
      listWorktrees: (projectId) =>
        options.workspace.worktrees.filter((worktree) => projectId === undefined || worktree.projectId === projectId),
      // Real panes when there are real panes, so a snapshot describes a process genuinely running.
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
    ...(options.shareTaskDetails ? { shareTaskDetails: options.shareTaskDetails } : {}),
    ...(options.readTaskGit ? { readTaskGit: options.readTaskGit } : {}),
    ...(options.consent ? { consent: options.consent } : {}),
    ...(options.mutes ? { mutes: options.mutes } : {}),
    ...(options.watchWake ? { watchWake: options.watchWake } : {}),
    onChange: () => {
      changes += 1
      options.onChange?.()
    },
    ...(options.onNote ? { onNote: options.onNote } : {}),
    onError: (error) => errors.push(error)
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
    changes: () => changes,
    errors: () => errors
  }
}

/**
 * What teamwork has read about one project. Every caller has let the service reconcile first, so an
 * unread answer is the service failing, said here rather than as an absent link three assertions later.
 */
export function statusOf(service: PeerService, projectId: string): TeamworkRead {
  const status = service.status({ projectId })
  if (status.state !== 'read') throw new Error(`teamwork has not read ${projectId} yet`)
  return status
}

/** The roster and the rows on it, for a test that has already reconciled. */
export function presenceOf(service: PeerService, projectId: string): TeammatePresenceRead {
  const presence = service.presence({ projectId })
  // `statusOf`'s argument, for the other half of the same reconcile.
  if (presence.state !== 'read') throw new Error(`teamwork has not read ${projectId}’s roster yet`)
  return presence
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

/**
 * The owner's standing "yes" for one teammate on one pane, in the shape `PeerServiceOptions.consent`
 * wants. `set` records what a test asked for so a test about the durable half can read it back.
 */
export function standingConsent(
  grants: readonly { terminalId: string; publicKey: string }[] = []
): ConsentStore & { written: { terminalId: string; publicKey: string; since: number | null }[] } {
  const held = new Map(grants.map((grant) => [`${grant.terminalId}\u0000${grant.publicKey}`, { ...grant, since: 1 }]))
  const written: { terminalId: string; publicKey: string; since: number | null }[] = []
  return {
    list: () => [...held.values()],
    set: (terminalId, publicKey, since) => {
      written.push({ terminalId, publicKey, since })
      const key = `${terminalId}\u0000${publicKey}`
      if (since === null) held.delete(key)
      else held.set(key, { terminalId, publicKey, since })
    },
    written
  }
}

/** Panes the owner has already silenced, in the shape `PeerServiceOptions.mutes` wants; `standingConsent`'s twin. */
export function standingMutes(terminalIds: readonly string[] = []): MuteStore {
  const held = new Set(terminalIds)
  return {
    list: () => [...held],
    set: (terminalId, muted) => {
      if (muted) held.add(terminalId)
      else held.delete(terminalId)
    }
  }
}

/**
 * A verdict the owner's machine was expected to reach on its own. A throw, so a write suddenly held fails
 * a test about something else with a sentence rather than `undefined is not true`.
 */
export function decided(verdict: RemoteWriteVerdict): RemoteWriteDecision {
  if ('held' in verdict) throw new Error('this keystroke was held for the owner rather than decided')
  return verdict
}

/** The promise a held write is owed, or a failure naming what happened instead. */
export function heldBy(verdict: RemoteWriteVerdict): Promise<RemoteWriteDecision> {
  if (!('held' in verdict)) throw new Error(`this keystroke was decided outright: ${JSON.stringify(verdict)}`)
  return verdict.held
}
