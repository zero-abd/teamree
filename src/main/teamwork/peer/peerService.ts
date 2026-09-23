// Teamwork's live half: one link per teammate per project, the latest snapshot
// each peer sent (kept by revision), and the revision this runtime pushes to
// subscribed peers. The roster is checked in both directions, per project.

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import {
  CONSENT_WINDOW_MS,
  TYPING_WINDOW_MS,
  type ConsentGrant,
  type ConsentScope,
  type PaneConsent,
  type PaneTypist,
  type PaneWatcher,
  type PaneWatchers,
  type PeerLink as PeerLinkStatus,
  type PeerPane,
  type PeerPresence,
  type PeerProject,
  type PeerWorktree,
  type Project,
  type ConsentRequest,
  type RemoteWrite,
  type RemoteWriteLog,
  type RemoteWriteOutcome,
  type TeammatePresence,
  type TeammateStanding,
  type TeammateWorktree,
  type TeamworkRead,
  type TeamworkStatus,
  type Terminal,
  type WatchedPane,
  type Worktree
} from '../../../shared/entities'
import type { ParamsOf, ResultOf } from '../../../shared/methods'
import { createGitRunner, type GitRunner } from '../../git/gitProcess'
import type { Dispatcher } from '../../runtime/dispatcher'
import { defaultMonotonicNow } from '../../runtime/elapsed'
import {
  PANE_CLOSED,
  PeerCallError,
  type RemoteReadVerdict,
  type RemoteWriteDecision,
  type RemoteWriteRequest,
  type RemoteWriteVerdict
} from '../../runtime/peerTransport'
import type { SubscriptionChannel, SubscriptionHub } from '../../runtime/subscriptionHub'
import { notFound } from '../../runtime/runtimeError'
import { ErrorCode } from '../../../shared/protocol'
import {
  MAX_CACHED_PANES,
  MAX_CACHED_TEXT,
  MAX_CACHED_WORKTREES,
  TeammateCacheStore,
  TEAMMATE_CACHE_FILE,
  type TeammateCache
} from '../../store/teammateCache'
import { AGENT_KINDS } from '../../terminals/agent-command'
import { badPaneId, TeamworkError } from '../errors'
import { createRemoteWriteLog, returnsIn, type RemoteWriteRecorder } from './writeLog'
import { previewOf } from './writePreview'
import { loadIdentity, loadStaticPrivateKey } from '../identity'
import { readRoster } from '../roster'
import { watchPane } from './paneWatch'
import { createPeerLink, type LinkScheduler, type PeerLink } from './peerLink'
import { presenceFor, type PresenceProject, type PresenceSource } from './presence'
import { originMark, readProjectKey } from './projectKey'
import { readRelayConfig, type RelayLocation } from './relayUrl'
import { watchForWake, type WakeWatch } from './wakeWatch'
import { webSocketDialer, type RelayDialer } from './relaySocket'

/**
 * How long a burst of workspace changes is gathered before peers are told.
 * Longer than the local stream's window, because the reader is across a relay.
 */
export const PRESENCE_COALESCE_MS = 150

/**
 * How many of a project's pane ids are remembered after the panes have gone, so
 * a pane that closes under a reader can be named as closed. Bounded because it
 * is a memory of everything that ever ran.
 */
export const REMEMBERED_PANES_PER_PROJECT = 256

/** What the service needs of the workspace, so a test can hand it three arrays. */
export type PeerWorkspace = {
  listProjects: () => Project[]
  listWorktrees: (projectId?: string) => Worktree[]
  listTerminals: (worktreeId: string) => Terminal[]
}

export type PeerServiceOptions = {
  workspace: PeerWorkspace
  /** The app's own data directory: where the private key is, never a repository. */
  dataDir: string
  subscriptions: SubscriptionHub
  runner?: GitRunner
  dial?: RelayDialer
  scheduler?: LinkScheduler
  /** How this machine hears that it has woken up: Electron's `powerMonitor` by default. */
  watchWake?: WakeWatch
  env?: NodeJS.ProcessEnv
  /** What each teammate last showed, across a drop and across a restart. */
  cache?: TeammateCache
  /**
   * Where the owner's mutes live between runs: read once at startup, written
   * through on change. Left out, mutes last as long as the runtime.
   */
  mutes?: MuteStore
  /**
   * Where `always` grants live between runs, on the same bargain as the mutes.
   * Left out, an `always` grant lasts as long as the runtime.
   */
  consent?: ConsentStore
  /** Publishes `{ type: 'teammates' }` so the window re-reads. */
  onChange: () => void
  onError?: (error: unknown) => void
}

/** The durable half of a mute, kept beside the terminal records so removing the pane removes it. */
export type MuteStore = {
  list: () => readonly string[]
  set: (terminalId: string, muted: boolean) => void
}

/**
 * The durable half of an `always` grant, kept beside the terminal records so
 * removing the pane removes it. Keyed by pane AND person: pane alone would be
 * "anyone may type here".
 */
export type ConsentStore = {
  list: () => readonly { terminalId: string; publicKey: string; since: number }[]
  /** `since` is when the owner gave it, and `null` takes it back. A time, so the owner can weigh its age. */
  set: (terminalId: string, publicKey: string, since: number | null) => void
}

type ProjectFacts = {
  projectId: string
  /** The checkout, kept so a read can ask whether `origin` has moved since. */
  path: string
  projectKey: string | undefined
  /**
   * What git's config looked like when `projectKey` was read from it. `origin`
   * is not watched the way `.teamree` is, so this tells a cached key from a stale one.
   */
  originMark: string | undefined
  rosterKeys: string[]
  /** Public key to the handle the roster files it under, for display. */
  handles: Map<string, string>
  relay: RelayLocation | null
  /** Whether this machine's own key is among `rosterKeys`. */
  enrolled: boolean
  /** Why teamwork is not running for this project, or null when it is. */
  disabledReason: string | null
  /** Whether `origin` gave a key, kept apart from `disabledReason`, which names only the first thing to fix. */
  origin: TeamworkRead['origin']
}

type LinkRecord = {
  link: PeerLink
  status: PeerLinkStatus
  relayUrl: string
}

const defaultScheduler: LinkScheduler = {
  now: () => Date.now(),
  // A clock a closing lid cannot move, so a deadline can tell this machine's
  // sleep from a teammate's silence. See `elapsed.ts`.
  monotonicNow: defaultMonotonicNow,
  setTimer: (run, delayMs) => {
    const timer = setTimeout(run, delayMs)
    // A pending reconnect must never be the reason a process stays alive.
    timer.unref?.()
    return () => clearTimeout(timer)
  }
}

export class PeerService {
  readonly #options: PeerServiceOptions
  readonly #runner: GitRunner
  readonly #scheduler: LinkScheduler
  readonly #dial: RelayDialer

  readonly #projects = new Map<string, ProjectFacts>()
  readonly #links = new Map<string, LinkRecord>()
  /** Which teammate and which project a peer connection is. Set before it can call. */
  readonly #peerByConnection = new Map<string, { publicKey: string; projectKey: string }>()
  /**
   * The latest snapshot per *link* (one teammate in one project), so a snapshot
   * heard on one repository's session is never read out under another.
   */
  readonly #heard = new Map<string, HeardPresence>()
  readonly #subscribers = new Map<string, SubscriptionChannel>()
  /** Which of this machine's panes each link's teammate has open, and since when. Per link, so per project. */
  readonly #watchers = new Map<string, Map<string, number>>()
  /**
   * Pane ids this machine has resolved inside a project, kept after the pane
   * closed. Per project, never global: `remoteRead` must not answer "is there a
   * pane with this id somewhere on your machine".
   */
  readonly #panesHeld = new Map<string, Set<string>>()
  /** Panes *this* machine is reading, by link, so a link going down can say so instead of freezing. */
  readonly #watching = new Map<string, Set<SubscriptionChannel>>()
  /**
   * Who has typed into each of this machine's panes, keyed by pane then by key.
   * The owner's question: two people typing into one pane must not look like one.
   */
  readonly #typists = new Map<string, Map<string, PaneTypist>>()
  /** Per link, how many unaimed keystrokes were filed in full and how many only counted. See `#recordUnaimed`. */
  readonly #unaimed = new Map<string, UnaimedBurst>()
  /**
   * When each teammate was last heard typing anywhere, by key. The clock the
   * window's throttle is decided against; per person, not per pane, because the
   * pane is named by the caller and a burst is one burst however many ids it names.
   */
  readonly #lastTypedAt = new Map<string, number>()
  /**
   * Panes the owner has muted, by this machine's own terminal id. In memory
   * because a keystroke is judged in one synchronous task; written through to
   * `options.mutes` because `session-restore.ts` keeps the id across a restart.
   * Pruned by the terminal record's removal, not here.
   */
  readonly #muted = new Set<string>()
  /**
   * Standing permissions, by pane and teammate. `always` grants are written
   * through to `options.consent`; `session` grants end with this runtime or that link.
   */
  readonly #standing = new Map<string, StandingGrant>()
  /**
   * Keystrokes held at one of this machine's panes, waiting for the owner.
   * NOTHING IN HERE HAS RUN: a write reaches the pty only through the verdict
   * returned into the task that dispatches it, and a held write has none.
   */
  readonly #pending = new Map<string, PendingRequest>()
  /**
   * Which request a teammate's next keystroke at a pane joins, by `#consentKey`.
   * One per teammate per pane, so `npm test` is one question rather than eight prompts.
   */
  readonly #pendingByPane = new Map<string, string>()
  #requestSeq = 0
  /** When the window was last told a request grew, so a burst is not a flood. */
  #requestsToldAt = 0
  readonly #log: RemoteWriteRecorder

  #cache: TeammateCache | undefined
  #dispatch: Dispatcher | undefined
  #identityKey: string | null = null
  #privateKey: Uint8Array | undefined
  #revision = 0
  #started = false
  #cancelCoalesce: (() => void) | undefined
  /** Stops listening for "this machine woke up", once there is something to stop. */
  #unwatchWake: (() => void) | undefined
  /** When the window was last told about typing, so a burst is not a flood of reads. */
  #typingToldAt = 0
  #cancelTypingIdle: (() => void) | undefined
  /** The same, for a held burst that is still growing while the owner reads it. */
  #cancelRequestsIdle: (() => void) | undefined

  constructor(options: PeerServiceOptions) {
    this.#options = options
    this.#runner = options.runner ?? createGitRunner()
    this.#scheduler = options.scheduler ?? defaultScheduler
    this.#dial = options.dial ?? webSocketDialer
    this.#log = createRemoteWriteLog({
      dataDir: options.dataDir,
      now: () => this.#scheduler.now(),
      ...(options.onError ? { onError: options.onError } : {})
    })
  }

  /** The dispatcher is built after the handlers are registered; until it arrives no peer can be answered. */
  attach(dispatch: Dispatcher): void {
    this.#dispatch = dispatch
  }

  /** Reads the rosters and relays, then brings every link it finds up. */
  async start(): Promise<void> {
    this.#started = true
    // Before anything can be typed at, so the first keystroke of the session
    // meets the decisions the owner made in the last one.
    for (const terminalId of this.#options.mutes?.list() ?? []) this.#muted.add(terminalId)
    for (const grant of this.#options.consent?.list() ?? []) {
      this.#standing.set(consentKeyOf(grant.terminalId, grant.publicKey), {
        terminalId: grant.terminalId,
        publicKey: grant.publicKey,
        scope: 'always',
        since: grant.since
      })
    }
    // Before the links, so the sidebar has last night's picture from the first
    // frame it paints rather than after the first teammate answers.
    this.#cache ??=
      this.#options.cache ?? (await TeammateCacheStore.open(join(this.#options.dataDir, TEAMMATE_CACHE_FILE)))
    // Before the links, so a wake during startup finds them already listening.
    this.#unwatchWake ??= await (this.#options.watchWake ?? watchForWake)(() => this.#wake())
    await this.reconcile()
  }

  /**
   * This machine slept, so every link withdraws its verdict and goes to find out
   * again. Each link also notices from its own clocks (no Electron in the CLI);
   * this is the same conclusion arriving at wake rather than at the next deadline.
   */
  #wake(): void {
    for (const record of this.#links.values()) record.link.wake()
  }

  stop(): void {
    this.#started = false
    this.#cancelCoalesce?.()
    this.#cancelCoalesce = undefined
    this.#unwatchWake?.()
    this.#unwatchWake = undefined
    // What was heard is kept, but with no link behind it none of it is live.
    for (const entry of this.#heard.values()) entry.live = false
    // A remembered worktree is honest; a remembered keystroke is not.
    this.#cancelTypingIdle?.()
    this.#cancelTypingIdle = undefined
    this.#flushEveryUnaimed()
    this.#unaimed.clear()
    // A held keystroke nothing ever settles is the failure this path exists to
    // prevent. An expiry, not a denial: the owner decided nothing.
    for (const request of [...this.#pending.values()]) {
      this.#settle(request, request.held.length, 'expired', 'this runtime stopped while the owner was being asked')
    }
    // Session grants end with this runtime; the durable ones are read back by the next `start`.
    for (const [key, grant] of [...this.#standing]) {
      if (grant.scope === 'session') this.#standing.delete(key)
    }
    for (const record of this.#links.values()) record.link.stop()
    this.#links.clear()
    this.#peerByConnection.clear()
    this.#subscribers.clear()
    this.#watchers.clear()
    for (const linkId of Array.from(this.#watching.keys())) this.#endWatches(linkId, 'teamwork stopped')
  }

  /**
   * Re-reads what the repositories say and makes the links agree with it: the
   * key leaves the directory, the next read drops the link.
   */
  async reconcile(): Promise<void> {
    if (!this.#started) return
    const identity = await loadIdentity(this.#options.dataDir)
    this.#identityKey = identity.publicKey

    const facts = await Promise.all(
      this.#options.workspace.listProjects().map((project) => this.#readProject(project, identity.publicKey))
    )
    this.#projects.clear()
    for (const fact of facts) this.#projects.set(fact.projectId, fact)

    // One link per (teammate, project) with a relay and a project key, each with
    // its own rendezvous and session.
    const wanted = new Map<string, WantedLink>()
    for (const fact of [...this.#projects.values()].sort((a, b) => a.projectId.localeCompare(b.projectId))) {
      if (!fact.relay || fact.disabledReason !== null || fact.projectKey === undefined) continue
      for (const key of fact.rosterKeys) {
        if (key === identity.publicKey) continue
        wanted.set(linkIdFor(key, fact.projectKey), {
          publicKey: key,
          projectKey: fact.projectKey,
          handle: this.#handleIn(fact, key),
          relayUrl: fact.relay.url
        })
      }
    }

    for (const [linkId, record] of [...this.#links]) {
      const want = wanted.get(linkId)
      // A relay that moved is a different link, not the same one reconnecting.
      if (want && want.relayUrl === record.relayUrl) continue
      // Read before it is dropped: a revoked link still has to name whose it was.
      const peer = this.#peerByConnection.get(linkId)
      record.link.stop()
      this.#links.delete(linkId)
      this.#peerByConnection.delete(linkId)
      // Whatever this link was still only counting goes down now.
      const burst = this.#unaimed.get(linkId)
      if (burst) {
        this.#flushUnaimed(linkId, burst)
        this.#unaimed.delete(linkId)
      }
      // A revoked teammate's rows go now; a link whose relay merely moved keeps
      // what it was showing. The disk copy ages out: "removed from the roster"
      // cannot be told from "the roster could not be read this once".
      if (!want) this.#heard.delete(linkId)
      // Anything read across the link stops either way; "watched by ana" after
      // the link went would be wrong in the reassuring direction.
      this.#watchers.delete(linkId)
      this.#endWatches(
        linkId,
        want ? 'the link to this teammate is being remade' : 'this teammate is no longer on the project’s roster'
      )
      // A revoked teammate must not leave a question naming them on the owner's
      // screen, nor a permission a re-added key would inherit.
      for (const request of this.#requestsFor((candidate) => candidate.linkId === linkId)) {
        this.#settle(
          request,
          request.held.length,
          'expired',
          want ? 'the link to this teammate is being remade' : 'this teammate is no longer on the project’s roster'
        )
      }
      for (const grant of this.#grantsFor(
        (candidate) => candidate.scope === 'session' && candidate.publicKey === peer?.publicKey
      )) {
        this.#forget(grant)
      }
    }

    if (wanted.size > 0) this.#privateKey ??= await loadStaticPrivateKey(this.#options.dataDir)

    // What was last heard, before anything dials, so a sidebar painted during
    // the handshake is not empty. It enters stale until a frame decrypts.
    for (const [linkId, want] of wanted) {
      if (this.#heard.has(linkId)) continue
      const cached = this.#cache?.get(want.publicKey, want.projectKey)
      if (!cached) continue
      this.#heard.set(linkId, {
        publicKey: want.publicKey,
        presence: {
          revision: 0,
          handle: cached.handle,
          projects: [{ projectKey: want.projectKey, worktrees: cached.worktrees }]
        },
        heardAt: cached.heardAt,
        live: false
      })
    }

    for (const [linkId, want] of wanted) {
      if (this.#links.has(linkId)) continue
      this.#open(linkId, want)
    }

    this.#options.onChange()
  }

  /**
   * Whether teamwork is running here: a synchronous read of the last reconcile,
   * because the window asks per project per refresh (the handler awaits
   * `refreshIfOriginMoved` first). `unread` is the beat between `project.add`
   * and its reconcile, or startup before `start()` finishes; the workspace is
   * asked whether the project exists at all, since "not read yet" and "no such
   * project" are different answers.
   */
  status(params: ParamsOf<'teamwork.status'>): TeamworkStatus {
    const facts = this.#projects.get(params.projectId)
    if (!facts) {
      const known = this.#options.workspace.listProjects().some((project) => project.id === params.projectId)
      if (!known) throw notFound(`no project with id ${params.projectId}`)
      return { state: 'unread', projectId: params.projectId, readAt: this.#scheduler.now() }
    }

    const links = facts.rosterKeys
      .filter((key) => key !== this.#identityKey)
      .map((key) =>
        facts.projectKey === undefined ? undefined : this.#links.get(linkIdFor(key, facts.projectKey))?.status
      )
      .filter((status): status is PeerLinkStatus => status !== undefined)

    return {
      state: 'read',
      projectId: facts.projectId,
      relay: facts.relay,
      disabledReason: facts.disabledReason,
      origin: facts.origin,
      enrolled: facts.enrolled,
      links,
      readAt: this.#scheduler.now()
    }
  }

  /**
   * Re-reads a project if `origin` has moved since the last reconcile. Nothing
   * watches git's config, and "no origin" is the state the runbook's step two
   * fixes, so the read that reports it checks it. A `stat`, so it can sit in
   * front of every refresh. A whole reconcile, because a new key means new links.
   */
  async refreshIfOriginMoved(projectId: string): Promise<void> {
    const facts = this.#projects.get(projectId)
    if (!facts || originMark(facts.path) === facts.originMark) return
    await this.reconcile()
  }

  /**
   * Every teammate's worktrees in one project, live or as last heard. Machine
   * away: rows with `live: false`. Worktree missing from the newest snapshot:
   * no row, the cache replaces rather than accumulates. Never heard: no rows,
   * which is why `teammates` lists the roster separately. Project not read yet:
   * `unread`, never an empty roster, which would be a finding.
   */
  presence(params: ParamsOf<'teamwork.presence'>): TeammatePresence {
    const facts = this.#projects.get(params.projectId)
    if (!facts) {
      const known = this.#options.workspace.listProjects().some((project) => project.id === params.projectId)
      if (!known) throw notFound(`no project with id ${params.projectId}`)
      return { state: 'unread', projectId: params.projectId, readAt: this.#scheduler.now() }
    }

    const now = this.#scheduler.now()
    const worktrees: TeammateWorktree[] = []
    const teammates: TeammateStanding[] = []
    // No relay means nobody is reported unheard from: that would read as a fault.
    const projectKey = facts.disabledReason === null ? facts.projectKey : undefined
    // Through this project's own links, and still roster-checked: a project key
    // is only a hash of a remote, computable by anybody who knows it exists.
    if (projectKey !== undefined) {
      for (const publicKey of facts.rosterKeys) {
        if (publicKey === this.#identityKey) continue
        const linkId = linkIdFor(publicKey, projectKey)
        const entry = this.#heard.get(linkId)
        const connected = this.#links.get(linkId)?.status.phase === 'connected'
        const handle = facts.handles.get(publicKey) ?? entry?.presence.handle ?? publicKey.slice(0, SHORT_KEY_LENGTH)
        teammates.push({ handle, publicKey, connected, heardAt: entry?.heardAt ?? null })
        if (!entry) continue
        const project = entry.presence.projects.find((candidate) => candidate.projectKey === projectKey)
        if (!project) continue
        // Both halves: live only if a frame decrypted on it and the link is still up.
        const live = entry.live && connected
        for (const worktree of project.worktrees) {
          worktrees.push({
            ...worktree,
            // Namespaced, because a teammate's worktree id is theirs and two
            // installations can and do generate the same one.
            id: `peer:${publicKey.slice(0, 12)}:${worktree.id}`,
            panes: worktree.panes.map((pane) => ({
              ...pane,
              id: `peer:${publicKey.slice(0, 12)}:${pane.id}`
            })),
            handle,
            publicKey,
            heardAt: entry.heardAt,
            live
          })
        }
      }
    }

    worktrees.sort((a, b) => a.handle.localeCompare(b.handle) || a.name.localeCompare(b.name))
    teammates.sort((a, b) => a.handle.localeCompare(b.handle))
    return { state: 'read', projectId: facts.projectId, worktrees, teammates, readAt: now }
  }

  /**
   * Opens one of a teammate's panes for reading. Two steps because the caller
   * needs the owner's dimensions with the subscription id; nothing is asked of
   * the teammate until `start` runs.
   */
  openWatch(params: ParamsOf<'teamwork.watch'>): OpenedWatch {
    const { record, handle, terminalId, pane, linkId } = this.#resolvePeerPane(params.projectId, params.paneId, 'read')
    return {
      handle,
      // The owner's, never negotiated: a smaller watcher letterboxes rather
      // than resizing a pty under a program that is only being read.
      cols: pane.cols ?? DEFAULT_COLS,
      rows: pane.rows ?? DEFAULT_ROWS,
      start: (channel) => {
        const stop = watchPane({
          target: record.link,
          terminalId,
          channel,
          ...(this.#options.onError ? { onError: this.#options.onError } : {})
        })
        const open = this.#watching.get(linkId) ?? new Set<SubscriptionChannel>()
        open.add(channel)
        this.#watching.set(linkId, open)
        return () => {
          open.delete(channel)
          if (open.size === 0) this.#watching.delete(linkId)
          stop()
        }
      }
    }
  }

  /**
   * Types into one of a teammate's panes: `terminal.write`, answered by their
   * terminal service, gated by their machine. A refusal is rethrown with the
   * code they gave it, never flattened: "muted" and "gone" are what the typist needs.
   */
  async type(params: ParamsOf<'teamwork.type'>): Promise<ResultOf<'teamwork.type'>> {
    const { record, terminalId } = this.#resolvePeerPane(params.projectId, params.paneId, 'type into')
    try {
      return await record.link.call('terminal.write', { terminalId, data: params.data })
    } catch (error) {
      throw error instanceof PeerCallError ? new TeamworkError(error.code, error.message) : notFound(reasonFor(error))
    }
  }

  /**
   * Who is reading this machine's panes, who has typed into them, and which the
   * owner has muted. A pane appears for any of the three: a mute nobody can see
   * is a mute nobody can lift. Answers for a project teamwork has not read yet:
   * watchers and typists arrive over links, and mutes are read back in
   * `start()`, so a restored window is never told its project does not exist.
   */
  watchers(params: ParamsOf<'teamwork.watchers'>): PaneWatchers {
    // Only that the project exists; the facts add rows where they have any.
    if (!this.#options.workspace.listProjects().some((project) => project.id === params.projectId)) {
      throw notFound(`no project with id ${params.projectId}`)
    }
    const facts = this.#projects.get(params.projectId)

    const byPane = new Map<string, PaneWatcher[]>()
    if (facts !== undefined && facts.projectKey !== undefined) {
      for (const publicKey of facts.rosterKeys) {
        if (publicKey === this.#identityKey) continue
        const linkId = linkIdFor(publicKey, facts.projectKey)
        const held = this.#watchers.get(linkId)
        if (!held || held.size === 0) continue
        const handle = this.#handleIn(facts, publicKey)
        for (const [terminalId, since] of held) {
          const watchers = byPane.get(terminalId) ?? []
          watchers.push({ handle, publicKey, since })
          byPane.set(terminalId, watchers)
        }
      }
    }

    // Every pane of this project plus every pane read over its links, so a mute
    // or typist nobody is watching still shows. All three halves are scoped to
    // the project; typists keyed by pane id alone once put a refused keystroke's
    // sender on an unrelated project's row.
    const named = new Set([...byPane.keys(), ...this.#panesOf(params.projectId)])

    const panes: WatchedPane[] = [...named]
      .map((terminalId) => ({
        terminalId,
        watchers: (byPane.get(terminalId) ?? []).sort((a, b) => a.handle.localeCompare(b.handle)),
        typists: [...(this.#typists.get(typistKey(params.projectId, terminalId))?.values() ?? [])]
          .map((typist) => ({ ...typist }))
          .sort((a, b) => a.handle.localeCompare(b.handle)),
        muted: this.#muted.has(terminalId)
      }))
      .filter((pane) => pane.watchers.length > 0 || pane.typists.length > 0 || pane.muted)
      .sort((a, b) => a.terminalId.localeCompare(b.terminalId))

    return { projectId: params.projectId, panes, readAt: this.#scheduler.now() }
  }

  /**
   * Stops, or restarts, remote keystrokes reaching one of this machine's panes.
   * Instant and local: the check and the pty write share one task, so it holds
   * for every keystroke not already written. Written through to `options.mutes`
   * so it survives the restart `session-restore.ts` keeps ids across. Resolved
   * via the workspace, not the facts, so it works before the first reconcile,
   * when `watchers` already draws the row with the mute on it.
   */
  mute(params: ParamsOf<'teamwork.mute'>): PaneWatchers {
    const projectId = this.#projectOfPane(params.terminalId)
    if (projectId === undefined) throw notFound(`no pane of this machine with id ${params.terminalId}`)
    if (params.muted) {
      this.#muted.add(params.terminalId)
      // A mute answers everything narrower that was outstanding: prompts settle
      // and standing permissions go, or the mute lasts only until the next unmute.
      for (const request of this.#requestsFor((candidate) => candidate.terminalId === params.terminalId)) {
        this.#settle(request, request.held.length, 'muted', 'the owner has muted this pane')
      }
      for (const grant of this.#grantsFor((candidate) => candidate.terminalId === params.terminalId)) {
        this.#forget(grant)
      }
    } else this.#muted.delete(params.terminalId)
    this.#options.mutes?.set(params.terminalId, params.muted)
    this.#options.onChange()
    return this.watchers({ projectId })
  }

  /**
   * What is waiting on the owner in one project, and what they already allowed.
   * Answered before the first reconcile, on `watchers`' argument: held bursts
   * arrive over links, standing permissions are restored in `start()`, and
   * `#handleIn` falls back to the key for a roster not read yet.
   */
  requests(params: ParamsOf<'teamwork.requests'>): PaneConsent {
    if (!this.#options.workspace.listProjects().some((project) => project.id === params.projectId)) {
      throw notFound(`no project with id ${params.projectId}`)
    }
    const facts = this.#projects.get(params.projectId)

    const requests = [...this.#pending.values()]
      .filter((request) => request.projectId === params.projectId)
      .sort((a, b) => a.since - b.since || a.id.localeCompare(b.id))
      .map((request) => describeRequest(request))

    // Only for panes this project still has: a grant outlives a runtime but not its pane.
    const standing: ConsentGrant[] = [...this.#standing.values()]
      .filter((grant) => this.#paneOf(params.projectId, grant.terminalId) !== undefined)
      .map((grant) => ({
        terminalId: grant.terminalId,
        handle: this.#handleIn(facts, grant.publicKey),
        publicKey: grant.publicKey,
        scope: grant.scope,
        since: grant.since
      }))
      .sort((a, b) => a.terminalId.localeCompare(b.terminalId) || a.handle.localeCompare(b.handle))

    return { projectId: params.projectId, requests, standing, readAt: this.#scheduler.now() }
  }

  /**
   * The owner's answer to one held burst. `through` is the length as the owner
   * saw it: keystrokes arrive while the question is up, and an "allow once" on
   * four must not let the fourteenth through. Leftovers are re-asked under a
   * fresh request. A standing permission is about the person, not the bytes.
   */
  decide(params: ParamsOf<'teamwork.decide'>): PaneConsent {
    const request = this.#pending.get(params.requestId)
    // The owner's own call, answered plainly: no teammate here to be told anything.
    if (!request) throw notFound(`no keystrokes are waiting under id ${params.requestId}`)
    const projectId = request.projectId

    if (params.decision === 'deny') {
      this.#settle(request, request.held.length, 'denied', 'the owner did not allow this')
      this.#options.onChange()
      return this.requests({ projectId })
    }

    if (params.decision !== 'once') {
      this.#grant(request, params.decision)
      // Everything held: a standing permission is about the person, not the bytes.
      this.#settle(request, request.held.length, 'allowed', undefined)
      this.#options.onChange()
      return this.requests({ projectId })
    }

    this.#settle(request, Math.min(params.through ?? request.held.length, request.held.length), 'allowed', undefined)
    this.#options.onChange()
    return this.requests({ projectId })
  }

  /**
   * Takes back a standing permission. Instant and local like the mute, effective
   * on the next keystroke, and answerable before the first reconcile for the
   * same reasons: `requests` lists a permission restored in `start()`.
   */
  revoke(params: ParamsOf<'teamwork.revoke'>): PaneConsent {
    const projectId = this.#projectOfPane(params.terminalId)
    if (projectId === undefined) throw notFound(`no pane of this machine with id ${params.terminalId}`)
    const grant = this.#standing.get(consentKeyOf(params.terminalId, params.publicKey))
    if (grant) this.#forget(grant)
    this.#options.onChange()
    return this.requests({ projectId })
  }

  /** The owner's record of every remote write, from their own disk. */
  writeLog(params: ParamsOf<'teamwork.writeLog'>): Promise<RemoteWriteLog> {
    // Whatever a burst is still only counting goes down before the read.
    this.#flushEveryUnaimed()
    return this.#log.read(params.limit)
  }

  /**
   * The projects a teammate reached this machine through, if they may use them:
   * the roster is membership, the project key stops one repository's session
   * reaching into another's. PLURAL: the key hashes the repository, which may
   * be checked out twice as two projects sharing one link; resolving only the
   * first made half the offered panes answer as panes that do not exist.
   */
  #projectsForPeer(peer: { publicKey: string; projectKey: string | undefined }): ProjectFacts[] {
    return [...this.#projects.values()].filter(
      (fact) =>
        fact.projectKey === peer.projectKey && fact.disabledReason === null && fact.rosterKeys.includes(peer.publicKey)
    )
  }

  /** One of this machine's panes, in whichever of those projects has it. */
  #paneForPeer(
    projects: readonly ProjectFacts[],
    terminalId: string
  ): { project: ProjectFacts; pane: Terminal } | undefined {
    for (const project of projects) {
      const pane = this.#paneOf(project.projectId, terminalId)
      if (pane) return { project, pane }
    }
    return undefined
  }

  /**
   * Whether a teammate may read one of this machine's panes: the same scoping
   * `remoteWrite` puts on typing. A pane in another project is reported exactly
   * as one that does not exist, so nobody can ask "is there a pane with this id
   * somewhere on your machine".
   */
  remoteRead(connectionId: string, terminalId: string): RemoteReadVerdict {
    const peer = this.#peerByConnection.get(connectionId)
    if (!peer) {
      return { ok: false, code: ErrorCode.NotFound, message: 'this connection is not a peer link' }
    }
    const projects = this.#projectsForPeer(peer)
    if (projects.length === 0) {
      return {
        ok: false,
        code: ErrorCode.NotFound,
        message: 'you are not on this project’s roster'
      }
    }
    if (!this.#paneForPeer(projects, terminalId)) {
      // A pane of *this* project that has since gone is named as closed, in the
      // words the stream ends with: a watcher subscribes then reads, and an owner
      // closing between the two is ordinary. Only for a pane this peer was
      // already answered for, and asked of every project the peer holds, since
      // one repository checked out twice is one link.
      if (projects.some((project) => this.#panesHeld.get(project.projectId)?.has(terminalId))) {
        return { ok: false, code: ErrorCode.NotFound, message: PANE_CLOSED }
      }
      return {
        ok: false,
        code: ErrorCode.NotFound,
        message: `there is no pane ${terminalId} in this project`
      }
    }
    return { ok: true }
  }

  /**
   * Whether one teammate's keystroke may reach one of this machine's panes, and
   * the record of it either way. THE ORDER IS THE POINT: attribution and record
   * land before the verdict returns into the task that dispatches the write, so
   * bytes never reach a pty unattributed. Everything is checked against what
   * this machine believes, never what the caller said; without a standing
   * permission the answer is `held` and the owner is asked. See `#hold`.
   */
  remoteWrite(connectionId: string, write: RemoteWriteRequest): RemoteWriteVerdict {
    return this.#judge(connectionId, write, false)
  }

  /**
   * The judgment. `consented` is true only on the path out of `#decide` and
   * skips exactly the asking; every other check runs again at dispatch time, so
   * a pane that exited, a mute, or a dropped roster still refuses a write the
   * owner said yes to.
   */
  #judge(connectionId: string, write: RemoteWriteRequest, consented: boolean): RemoteWriteVerdict {
    const at = this.#scheduler.now()
    const peer = this.#peerByConnection.get(connectionId)
    if (!peer) {
      // A connection the peer service never opened.
      return this.#refuse(
        connectionId,
        {
          at,
          handle: 'unknown',
          publicKey: '',
          projectId: '',
          terminalId: strangePaneId(write.terminalId),
          known: false
        },
        write,
        'not-a-member',
        'this connection is not a peer link',
        undefined
      )
    }

    const projects = this.#projectsForPeer(peer)
    const first = projects[0]
    if (!first) {
      // No roster here names this key, so no handle to file them under either.
      return this.#refuse(
        connectionId,
        {
          at,
          handle: peer.publicKey.slice(0, SHORT_KEY_LENGTH),
          publicKey: peer.publicKey,
          projectId: '',
          // Until a pane of this machine answers to it, the id is a string the
          // caller chose and is filed as one — see `strangePaneId`.
          terminalId: strangePaneId(write.terminalId),
          known: false
        },
        write,
        'not-a-member',
        'you are not on this project’s roster',
        undefined
      )
    }

    // Resolved from this machine's own list, never from anything the caller named.
    const found = this.#paneForPeer(projects, write.terminalId)
    if (!found) {
      // Filed under the first of the peer's projects and attributed nowhere: no
      // pane of theirs to attribute it to. Worded without the caller's id, since
      // a refusal that quotes its input lets anyone write to the owner's disk,
      // and it stays the same answer a pane in another project gets.
      return this.#refuse(
        connectionId,
        {
          at,
          handle: this.#handleIn(first, peer.publicKey),
          publicKey: peer.publicKey,
          projectId: first.projectId,
          terminalId: strangePaneId(write.terminalId),
          known: false
        },
        write,
        'no-pane',
        'there is no such pane in this project',
        undefined
      )
    }

    // Named by the roster of the project the pane is in, and by this machine's
    // own pane id, never by the string on the wire.
    const stamp: WriteStamp = {
      at,
      handle: this.#handleIn(found.project, peer.publicKey),
      publicKey: peer.publicKey,
      projectId: found.project.projectId,
      terminalId: found.pane.id,
      known: true
    }
    // `running` alone is not "can take a keystroke": a reaped child stays running
    // while its output drains and the pty refuses writes throughout. Recording
    // one as `written` would put an invented entry in the owner's evidence.
    if (!found.pane.running || found.pane.draining === true) {
      return this.#refuse(connectionId, stamp, write, 'no-pane', 'that pane’s process has exited', found.project)
    }

    // Before the owner is asked: a mute is the answer they already gave.
    // Instant and silent, nothing a teammate gets a vote on.
    if (this.#muted.has(write.terminalId)) {
      return this.#refuse(connectionId, stamp, write, 'muted', 'the owner has muted this pane', found.project)
    }

    // Last, and closest to the write, because it is the one that has to be
    // freshest: a permission lifted a microsecond ago holds this keystroke.
    if (!consented && !this.#standing.has(consentKeyOf(found.pane.id, peer.publicKey))) {
      return this.#hold(connectionId, stamp, write, found.project)
    }

    this.#recordWrite(connectionId, stamp, write, 'written', undefined, found.project)
    return { ok: true }
  }

  /**
   * PEER-ONLY. What this runtime is doing, for the teammate identified by the
   * key their handshake authenticated, never by anything they said in a message.
   */
  peerPresence(connectionId: string): PeerPresence {
    const peer = this.#peerByConnection.get(connectionId)
    if (peer === undefined) throw notFound('this connection is not a peer link')
    // Narrowed to the one project this session is for, on top of the roster filter.
    return presenceFor(
      { source: this.#presenceSource(peer.projectKey), now: this.#scheduler.now },
      peer.publicKey,
      this.#ownHandleIn(peer.projectKey),
      this.#revision
    )
  }

  /**
   * PEER-ONLY. The same snapshot, now and on every change. One per connection:
   * a second subscribe *replaces* the first, and closing the old one is what
   * makes that true of the hub and not just of this map.
   */
  peerSubscribe(connectionId: string, channel: SubscriptionChannel): () => void {
    const snapshot = this.peerPresence(connectionId)
    const previous = this.#subscribers.get(connectionId)
    this.#subscribers.set(connectionId, channel)
    // After the new one is filed, so the teardown the close runs leaves it alone.
    previous?.close()
    // Immediately, so there is no separate first read for the stream to race.
    channel.emit(snapshot)
    return () => {
      if (this.#subscribers.get(connectionId) === channel) this.#subscribers.delete(connectionId)
    }
  }

  /** Something in the workspace moved: bump the revision and tell the peers once per burst. */
  notifyWorkspaceChanged(): void {
    if (!this.#started || this.#subscribers.size === 0) return
    if (this.#cancelCoalesce) return
    this.#cancelCoalesce = this.#scheduler.setTimer(() => {
      this.#cancelCoalesce = undefined
      this.#revision += 1
      for (const [connectionId, channel] of this.#subscribers) {
        try {
          channel.emit(this.peerPresence(connectionId))
        } catch (error) {
          this.#options.onError?.(error)
        }
      }
    }, PRESENCE_COALESCE_MS)
  }

  #open(linkId: string, want: WantedLink): void {
    const privateKey = this.#privateKey
    const dispatch = this.#dispatch
    if (!privateKey || !dispatch) return

    // Before the link can dial, so the first `peer.presence` knows whose it is.
    // The link id is also the connection id: one name for one session.
    this.#peerByConnection.set(linkId, { publicKey: want.publicKey, projectKey: want.projectKey })

    const link = createPeerLink({
      remotePublicKey: want.publicKey,
      handle: want.handle,
      projectKey: want.projectKey,
      staticPrivateKey: privateKey,
      relayUrl: want.relayUrl,
      connectionId: linkId,
      dial: this.#dial,
      dispatch,
      subscriptions: this.#options.subscriptions,
      scheduler: this.#scheduler,
      onStatusChange: (status) => {
        const record = this.#links.get(linkId)
        if (record) record.status = status
        // Anything but `connected` means nothing has confirmed, so what it last
        // showed stops being live but stays on screen, stale and dated: a row
        // vanishing reads as a worktree deleted. A dropped link must keep
        // nothing that claims to be happening now.
        if (status.phase !== 'connected') {
          const entry = this.#heard.get(linkId)
          if (entry) entry.live = false
          // A link that is not up carries nobody's eyes.
          this.#watchers.delete(linkId)
          // And whatever this machine was reading over it has stopped arriving.
          this.#endWatches(linkId, `the link to ${want.handle} dropped`)
          // The bytes go with the question: a burst that outlived its link and
          // ran on reconnect would be a command arriving minutes after it was typed.
          for (const request of this.#requestsFor((candidate) => candidate.linkId === linkId)) {
            this.#settle(request, request.held.length, 'expired', `the link to ${want.handle} dropped`)
          }
          // A session grant ends with the session; the next link asks again.
          for (const grant of this.#grantsFor(
            (candidate) => candidate.scope === 'session' && candidate.publicKey === want.publicKey
          )) {
            this.#forget(grant)
          }
        }
        this.#options.onChange()
      },
      onPresence: (presence) => this.#record(linkId, want.publicKey, presence),
      onWatchersChange: (terminalIds) => this.#recordWatchers(linkId, terminalIds),
      onRemoteWrite: (write) => this.remoteWrite(linkId, write),
      onRemoteRead: (terminalId) => this.remoteRead(linkId, terminalId),
      onError: this.#options.onError
    })

    this.#links.set(linkId, { link, status: link.status, relayUrl: want.relayUrl })
    link.start()
  }

  /**
   * Drops a snapshot behind the one already held for this link. Only reached
   * once the session has confirmed key possession, so this is the one door
   * through which anything becomes live, not the link coming up.
   */
  #record(linkId: string, publicKey: string, incoming: unknown): void {
    // Only the project this session is for: ten invented project keys would
    // otherwise take ten cache slots and push out every real one.
    const projectKey = this.#peerByConnection.get(linkId)?.projectKey
    const presence = parsePeerPresence(incoming, projectKey)
    if (!presence) {
      // Said out loud: a snapshot that is not one is a build mismatch or a
      // probe, and silence here is what turned this into a sidebar that froze.
      this.#options.onError?.(
        new Error(
          `a presence snapshot from ${this.#links.get(linkId)?.status.handle ?? publicKey.slice(0, SHORT_KEY_LENGTH)} was not a snapshot`
        )
      )
      return
    }
    const held = this.#heard.get(linkId)
    if (!isNewerPresence(held?.live === true ? held.presence : undefined, presence)) return
    const heardAt = this.#scheduler.now()
    this.#heard.set(linkId, { publicKey, presence, heardAt, live: true })
    const [project] = presence.projects
    if (projectKey !== undefined && project) {
      this.#cache?.put({
        publicKey,
        projectKey,
        handle: presence.handle,
        heardAt,
        worktrees: project.worktrees
      })
    }
    this.#options.onChange()
  }

  /** Tells everything reading over one link that it has stopped, then ends it. */
  #endWatches(linkId: string, reason: string): void {
    const open = this.#watching.get(linkId)
    if (!open) return
    // Copied first: closing a channel runs the teardown that mutates this set.
    for (const channel of Array.from(open)) {
      channel.emit({ type: 'lost', reason })
      channel.close()
    }
    this.#watching.delete(linkId)
  }

  /**
   * One of a teammate's panes, resolved the way the roster says it may be.
   * `intent` is only words for the error. Refuses for a project not read yet
   * (no roster, no link) but with the right refusal: "not read yet" means try
   * again, "no project with id" means a stale id.
   */
  #resolvePeerPane(projectId: string, paneId: string, intent: string): ResolvedPeerPane {
    const facts = this.#projects.get(projectId)
    if (!facts) {
      const known = this.#options.workspace.listProjects().some((project) => project.id === projectId)
      if (!known) throw notFound(`no project with id ${projectId}`)
      throw notFound(`teamree has not read project ${projectId} yet, so no teammate’s pane can be ${intent}`)
    }
    if (facts.projectKey === undefined) throw notFound(`project ${projectId} is not shared with anyone`)

    const target = parsePeerPaneId(paneId)
    if (!target) throw badPaneId(`${paneId} is not a teammate’s pane id`)

    // Through the roster and this project's own links, exactly as `presence` is.
    for (const publicKey of facts.rosterKeys) {
      if (publicKey === this.#identityKey) continue
      if (publicKey.slice(0, KEY_PREFIX_LENGTH) !== target.keyPrefix) continue
      const linkId = linkIdFor(publicKey, facts.projectKey)
      const record = this.#links.get(linkId)
      const heard = this.#heard.get(linkId)
      if (!record || !heard) continue
      const pane = findPane(heard.presence, facts.projectKey, target.terminalId)
      if (!pane) continue
      if (record.status.phase !== 'connected') {
        throw notFound(`${record.status.handle} is not connected, so their pane cannot be ${intent}`)
      }
      return {
        record,
        linkId,
        publicKey,
        handle: facts.handles.get(publicKey) ?? heard.presence.handle ?? publicKey.slice(0, SHORT_KEY_LENGTH),
        terminalId: target.terminalId,
        pane
      }
    }

    throw notFound(`no teammate pane with id ${paneId} in this project`)
  }

  /** Files a refused keystroke and turns it into the answer the teammate gets. */
  #refuse(
    connectionId: string,
    stamp: WriteStamp,
    write: RemoteWriteRequest,
    outcome: RemoteWriteOutcome,
    reason: string,
    /** The project the pane was found in, or undefined when none was. */
    project: ProjectFacts | undefined
  ): RemoteWriteVerdict {
    this.#recordWrite(connectionId, stamp, write, outcome, reason, project)
    // `conflict` for a mute, because the owner put the pane in that state;
    // `not_found` for the rest, because there is nothing there to type at.
    const code = outcome === 'muted' ? ErrorCode.Conflict : ErrorCode.NotFound
    return { ok: false, code, message: reason }
  }

  /**
   * Holds a keystroke until the owner says, giving the caller a promise rather
   * than a verdict: the write does not reach the dispatcher until it settles,
   * and the teammate's request stays open (see `PEER_WRITE_TIMEOUT_MS`).
   * Nothing is recorded here: a held keystroke has not happened. The bounds
   * are memory spent on somebody else's say-so; past them it is refused with the reason.
   */
  #hold(connectionId: string, stamp: WriteStamp, write: RemoteWriteRequest, project: ProjectFacts): RemoteWriteVerdict {
    const key = consentKeyOf(stamp.terminalId, stamp.publicKey)
    const openId = this.#pendingByPane.get(key)
    let request = openId === undefined ? undefined : this.#pending.get(openId)
    const joining = request !== undefined

    if (request === undefined) {
      const open = [...this.#pending.values()].filter((candidate) => candidate.linkId === connectionId).length
      if (open >= MAX_PENDING_PER_LINK) {
        return this.#refuse(
          connectionId,
          stamp,
          write,
          'denied',
          `keystrokes of yours are already waiting at ${MAX_PENDING_PER_LINK} of this machine’s panes`,
          project
        )
      }
      this.#requestSeq += 1
      request = {
        id: `ask_${this.#requestSeq}`,
        linkId: connectionId,
        publicKey: stamp.publicKey,
        handle: stamp.handle,
        projectId: stamp.projectId,
        terminalId: stamp.terminalId,
        since: stamp.at,
        at: stamp.at,
        expiresAt: stamp.at + CONSENT_WINDOW_MS,
        bytes: 0,
        held: [],
        cancelExpiry: () => {}
      }
      this.#openRequest(request)
    } else if (request.held.length >= MAX_HELD_WRITES || request.bytes + write.bytes > MAX_HELD_BYTES) {
      return this.#refuse(
        connectionId,
        stamp,
        write,
        'denied',
        'the owner has not answered yet, and this pane is already holding as much of your typing as it will hold',
        project
      )
    }

    // Re-read from the roster on every keystroke, as the stamp is, so a renamed
    // roster entry shows under the name the project uses now.
    request.handle = stamp.handle
    request.at = stamp.at
    request.bytes += write.bytes
    const held: Promise<RemoteWriteDecision> = new Promise((resolve) => {
      // `request` is narrowed above and cannot be undefined here; the local is
      // what keeps that true inside the closure.
      const open = request as PendingRequest
      open.held.push({ write, settle: resolve })
    })
    this.#tellWindowAboutRequests(stamp.at, !joining)
    return { held }
  }

  /** Files a new request and starts the clock the teammate is owed an end from. */
  #openRequest(request: PendingRequest): void {
    this.#pending.set(request.id, request)
    this.#pendingByPane.set(consentKeyOf(request.terminalId, request.publicKey), request.id)
    request.cancelExpiry = this.#scheduler.setTimer(() => {
      // Re-read rather than closed over, because a partly answered burst
      // continues under a new id and this timer is armed again for it.
      const open = this.#pending.get(request.id)
      if (!open) return
      this.#settle(
        open,
        open.held.length,
        'expired',
        `nobody answered on the owner’s machine, so this expired after ${CONSENT_WINDOW_MS / 1000} seconds`
      )
      this.#options.onChange()
    }, CONSENT_WINDOW_MS)
  }

  /**
   * Answers the front of a held burst and leaves the rest held. Every allowed
   * keystroke goes back through `#judge`, so consent is never a bypass; refusals
   * are recorded here because no verdict path runs for a keystroke never dispatched.
   */
  #settle(request: PendingRequest, count: number, how: SettledAs, reason: string | undefined): void {
    const taken = request.held.splice(0, count)
    const at = this.#scheduler.now()
    for (const item of taken) {
      request.bytes -= item.write.bytes
      if (how === 'allowed') {
        item.settle(decisionOf(this.#judge(request.linkId, item.write, true)))
        continue
      }
      const outcome: RemoteWriteOutcome = how === 'muted' ? 'muted' : how
      const words = reason ?? 'the owner did not allow this'
      this.#recordWrite(
        request.linkId,
        {
          at,
          handle: request.handle,
          publicKey: request.publicKey,
          projectId: request.projectId,
          terminalId: request.terminalId,
          known: true
        },
        item.write,
        outcome,
        words,
        this.#projects.get(request.projectId)
      )
      // `conflict` for the same reason a mute gets it.
      item.settle({ ok: false, code: ErrorCode.Conflict, message: words })
    }

    request.cancelExpiry()
    this.#pending.delete(request.id)
    const key = consentKeyOf(request.terminalId, request.publicKey)
    if (this.#pendingByPane.get(key) === request.id) this.#pendingByPane.delete(key)
    if (request.held.length === 0) return

    // What the owner was not shown starts again under a fresh id: reusing the
    // old one would let a second click answer bytes nobody has looked at.
    this.#requestSeq += 1
    request.id = `ask_${this.#requestSeq}`
    request.since = at
    request.expiresAt = at + CONSENT_WINDOW_MS
    this.#openRequest(request)
  }

  /** Writes down a standing permission, and the durable copy when it is one. */
  #grant(request: PendingRequest, scope: ConsentScope): void {
    const since = this.#scheduler.now()
    this.#standing.set(consentKeyOf(request.terminalId, request.publicKey), {
      terminalId: request.terminalId,
      publicKey: request.publicKey,
      scope,
      since
    })
    if (scope === 'always') this.#options.consent?.set(request.terminalId, request.publicKey, since)
  }

  /** Drops one, from memory and from the file when it was in the file. */
  #forget(grant: StandingGrant): void {
    this.#standing.delete(consentKeyOf(grant.terminalId, grant.publicKey))
    if (grant.scope === 'always') this.#options.consent?.set(grant.terminalId, grant.publicKey, null)
  }

  /** Pending requests matching a predicate, copied so settling can mutate the map. */
  #requestsFor(match: (request: PendingRequest) => boolean): PendingRequest[] {
    return [...this.#pending.values()].filter(match)
  }

  /** The same, for standing permissions. */
  #grantsFor(match: (grant: StandingGrant) => boolean): StandingGrant[] {
    return [...this.#standing.values()].filter(match)
  }

  /**
   * Wakes the window for a question. A new request is told at once; a growing
   * one at the typing pulse and once more when it stops, so the count the owner
   * sees is the count their "allow once" admits.
   */
  #tellWindowAboutRequests(at: number, fresh: boolean): void {
    this.#cancelRequestsIdle?.()
    this.#cancelRequestsIdle = this.#scheduler.setTimer(() => {
      this.#cancelRequestsIdle = undefined
      this.#options.onChange()
    }, TYPING_WINDOW_MS)

    if (!fresh && at - this.#requestsToldAt < TYPING_PULSE_MS) return
    this.#requestsToldAt = at
    this.#options.onChange()
  }

  /**
   * The attribution and the record, in that order, both before the caller has
   * an answer. `project` separates a keystroke at one of the owner's panes from
   * one at an invented id: the second is logged in a form a flood cannot use
   * and never attributed, because `#typists` evicts by count and the log
   * rotates at a byte cap, so a few hundred invented ids used to bury a real keystroke.
   */
  #recordWrite(
    connectionId: string,
    stamp: WriteStamp,
    write: RemoteWriteRequest,
    outcome: RemoteWriteOutcome,
    reason: string | undefined,
    project: ProjectFacts | undefined
  ): void {
    const entry: RemoteWrite = {
      at: stamp.at,
      handle: stamp.handle,
      publicKey: stamp.publicKey,
      projectId: stamp.projectId,
      terminalId: stamp.terminalId,
      bytes: write.bytes,
      returns: returnsIn(write.data),
      outcome
    }
    if (reason !== undefined) entry.reason = reason
    if (project === undefined) {
      this.#recordUnaimed(connectionId, entry)
      return
    }
    this.#log.record(entry)
    // Attributed only for a pane this machine has: a made-up id here was a map
    // the far end chose the keys of, and a window woken once per made-up id.
    if (stamp.known) this.#attribute(entry)
  }

  /**
   * Files a keystroke that reached no pane of this machine, collapsed.
   * `writeLog.ts` keeps some ten thousand entries and a refusal needs no valid
   * pane, so a sender could roll the owner's real record off the end of the
   * file. The first few of a burst are filed in full, the rest become one entry
   * carrying the count. Refusals that did reach a pane are not collapsed.
   */
  #recordUnaimed(connectionId: string, entry: RemoteWrite): void {
    const at = entry.at
    const burst = this.#unaimed.get(connectionId) ?? { since: at, logged: 0, collapsed: 0, bytes: 0 }
    if (at - burst.since >= UNAIMED_BURST_MS) {
      this.#flushUnaimed(connectionId, burst)
      burst.since = at
      burst.logged = 0
    }
    if (burst.logged < UNAIMED_LOGGED_PER_BURST) {
      burst.logged += 1
      this.#log.record(entry)
    } else {
      burst.collapsed += 1
      burst.bytes += entry.bytes
      burst.last = entry
    }
    this.#unaimed.set(connectionId, burst)
  }

  /** Files the one entry a collapsed burst leaves behind, if there is one. */
  #flushUnaimed(connectionId: string, burst: UnaimedBurst): void {
    const last = burst.last
    if (burst.collapsed === 0 || last === undefined) return
    this.#log.record({
      ...last,
      bytes: burst.bytes,
      reason:
        `${burst.collapsed} further keystrokes from this link reached no pane of this project ` +
        'and were counted rather than filed one by one'
    })
    burst.collapsed = 0
    burst.bytes = 0
    burst.last = undefined
    this.#unaimed.set(connectionId, burst)
  }

  /** Everything a collapsed burst is still holding, before the owner reads. */
  #flushEveryUnaimed(): void {
    for (const [connectionId, burst] of this.#unaimed) this.#flushUnaimed(connectionId, burst)
  }

  /** Who is typing in which pane, kept live so the owner is never in doubt. */
  #attribute(entry: RemoteWrite): void {
    const pane = typistKey(entry.projectId, entry.terminalId)
    const held = this.#typists.get(pane) ?? new Map<string, PaneTypist>()
    const existing = held.get(entry.publicKey)
    // Fresh is about the *person*, not the pane: per pane, varying the id turned
    // the throttle off from the other end of a relay.
    const lastHeard = this.#lastTypedAt.get(entry.publicKey)
    const fresh = lastHeard === undefined || entry.at - lastHeard > TYPING_WINDOW_MS
    this.#noteTypedAt(entry.publicKey, entry.at)
    const typist: PaneTypist = existing ?? {
      handle: entry.handle,
      publicKey: entry.publicKey,
      since: entry.at,
      at: entry.at,
      writes: 0,
      bytes: 0,
      refused: 0
    }
    typist.handle = entry.handle
    typist.at = entry.at
    if (entry.outcome === 'written') {
      typist.writes += 1
      typist.bytes += entry.bytes
    } else {
      typist.refused += 1
    }
    held.set(entry.publicKey, typist)
    this.#typists.set(pane, held)

    // Bounded: a pane nobody's keystroke ever reached goes before one somebody
    // typed into, then least recently typed first.
    while (this.#typists.size > MAX_TYPED_PANES) {
      const oldest = [...this.#typists].sort(
        (a, b) => Number(everLanded(a[1])) - Number(everLanded(b[1])) || lastTypedAt(a[1]) - lastTypedAt(b[1])
      )[0]
      if (!oldest) break
      this.#typists.delete(oldest[0])
    }

    this.#tellWindowAboutTyping(entry.at, fresh)
  }

  /**
   * Remembers when somebody last typed, and forgets whoever has stopped.
   * Bounded by the same argument as `#typists`: a key is a string from a handshake.
   */
  #noteTypedAt(publicKey: string, at: number): void {
    this.#lastTypedAt.set(publicKey, at)
    if (this.#lastTypedAt.size <= MAX_TYPED_PANES) return
    for (const [key, last] of this.#lastTypedAt) {
      if (at - last > TYPING_WINDOW_MS) this.#lastTypedAt.delete(key)
    }
  }

  /**
   * Wakes the window for a burst rather than a keystroke: announced when it
   * starts, pulsed while it goes on, and once more when it stops, or the window
   * keeps saying somebody is typing after they have walked away.
   */
  #tellWindowAboutTyping(at: number, fresh: boolean): void {
    this.#cancelTypingIdle?.()
    this.#cancelTypingIdle = this.#scheduler.setTimer(() => {
      this.#cancelTypingIdle = undefined
      this.#options.onChange()
    }, TYPING_WINDOW_MS)

    if (!fresh && at - this.#typingToldAt < TYPING_PULSE_MS) return
    this.#typingToldAt = at
    this.#options.onChange()
  }

  /** This machine's own pane, in one project, or undefined when it is not there. */
  #paneOf(projectId: string, terminalId: string): Terminal | undefined {
    for (const worktree of this.#options.workspace.listWorktrees(projectId)) {
      const pane = this.#options.workspace.listTerminals(worktree.id).find((entry) => entry.id === terminalId)
      if (pane) {
        this.#remember(projectId, terminalId)
        return pane
      }
    }
    return undefined
  }

  /**
   * Files a pane under the project it was found in, so it can still be named
   * once it is gone. Here, because the only ids worth keeping are the ones
   * something has already asked about.
   */
  #remember(projectId: string, terminalId: string): void {
    const held = this.#panesHeld.get(projectId) ?? new Set<string>()
    this.#panesHeld.set(projectId, held)
    if (held.has(terminalId)) return
    held.add(terminalId)
    // Insertion order: the id dropped is the one longest since first seen.
    if (held.size > REMEMBERED_PANES_PER_PROJECT) {
      const oldest = held.values().next()
      if (!oldest.done) held.delete(oldest.value)
    }
  }

  /** Every pane id this machine has in one project. */
  #panesOf(projectId: string): string[] {
    return this.#options.workspace
      .listWorktrees(projectId)
      .flatMap((worktree) => this.#options.workspace.listTerminals(worktree.id).map((pane) => pane.id))
  }

  /**
   * Which project one of this machine's panes is in. Walked over the workspace
   * rather than the facts, because before the first reconcile the facts are
   * empty and the workspace is not: resolving `mute` and `revoke` through the
   * facts let a restored window draw a muted pane and then refuse to lift it.
   */
  #projectOfPane(terminalId: string): string | undefined {
    for (const project of this.#options.workspace.listProjects()) {
      if (this.#paneOf(project.id, terminalId)) return project.id
    }
    return undefined
  }

  /** Keeps the moment each watch started, so a row can say how long. */
  #recordWatchers(linkId: string, terminalIds: readonly string[]): void {
    const held = this.#watchers.get(linkId) ?? new Map<string, number>()
    const next = new Map<string, number>()
    for (const terminalId of terminalIds) next.set(terminalId, held.get(terminalId) ?? this.#scheduler.now())
    if (next.size === 0) this.#watchers.delete(linkId)
    else this.#watchers.set(linkId, next)
    this.#options.onChange()
  }

  /**
   * What this machine calls itself to a teammate on one project, read at send
   * time: the handle announced over a session is a claim about that repository's roster.
   */
  #ownHandleIn(projectKey: string | undefined): string | null {
    const identityKey = this.#identityKey
    if (identityKey === null || projectKey === undefined) return null
    for (const fact of this.#projects.values()) {
      if (fact.projectKey !== projectKey) continue
      const handle = fact.handles.get(identityKey)
      if (handle !== undefined) return handle
    }
    return null
  }

  /**
   * What ONE PROJECT'S roster files a key under. Per project, because a key can
   * be `mallory` in one and `ana` in another (two checkouts, two `user.email`s).
   * Falls back to the key, never to another project's word; a project not read
   * yet lands in the same case.
   */
  #handleIn(facts: ProjectFacts | undefined, publicKey: string): string {
    return facts?.handles.get(publicKey) ?? publicKey.slice(0, SHORT_KEY_LENGTH)
  }

  /** `onlyProjectKey` narrows the source to the one repository a session is for. */
  #presenceSource(onlyProjectKey?: string): PresenceSource {
    return {
      projects: (): PresenceProject[] =>
        [...this.#projects.values()]
          .filter((fact) => onlyProjectKey === undefined || fact.projectKey === onlyProjectKey)
          .map((fact) => ({
            projectId: fact.projectId,
            projectKey: fact.disabledReason === null ? fact.projectKey : undefined,
            rosterKeys: fact.rosterKeys
          })),
      worktrees: (projectId) => this.#options.workspace.listWorktrees(projectId),
      terminals: (worktreeId) => this.#options.workspace.listTerminals(worktreeId)
    }
  }

  async #readProject(project: Project, identityKey: string): Promise<ProjectFacts> {
    // Stamped before git is asked: a remote added mid-read then costs one
    // re-read rather than losing the change.
    const mark = originMark(project.path)
    const [read, relay, key] = await Promise.all([
      // Kept as a failure rather than flattened into an empty roster: "nobody"
      // is a statement about the team, not about a read.
      readRoster(project.path).then(
        (roster) => ({ ok: true as const, roster }),
        (error: unknown) => ({ ok: false as const, reason: reasonFor(error) })
      ),
      readRelayConfig(project.path, this.#options.env),
      readProjectKey(this.#runner, project.path)
    ])
    const roster = read.ok ? read.roster : { entries: [], problems: [] }

    const handles = new Map(roster.entries.map((entry) => [entry.publicKey, entry.handle]))
    const facts: ProjectFacts = {
      projectId: project.id,
      path: project.path,
      projectKey: key.ok ? key.key : undefined,
      originMark: mark,
      rosterKeys: roster.entries.map((entry) => entry.publicKey),
      relay: relay.configured ? relay.location : null,
      enrolled: roster.entries.some((entry) => entry.publicKey === identityKey),
      disabledReason: null,
      origin: key.ok ? { ok: true, url: key.url } : { ok: false, reason: key.reason },
      handles
    }

    // Ordered from the thing a user fixes first: "no relay" is the ordinary
    // state, and saying it first stops the row reading as a fault.
    if (!relay.configured) facts.disabledReason = relay.reason
    else if (!key.ok) facts.disabledReason = key.reason
    else if (!read.ok) {
      // Still off, which is the safe direction; the sentence says the read
      // failed, not that the team is empty.
      facts.disabledReason = `this project’s roster could not be read: ${read.reason}`
    } else if (roster.entries.length === 0) {
      facts.disabledReason = 'nobody has joined this project yet, so there is no roster to meet anyone from'
    }
    return facts
  }
}

/** How often a burst of typing wakes the window while it is still going: twice a second. */
export const TYPING_PULSE_MS = 500

/**
 * How many panes' typists are remembered. A gone pane keeps its record, but a
 * month-long run must not accumulate one per pane it ever had; the log is durable.
 */
export const MAX_TYPED_PANES = 512

/** One teammate's pane, resolved through the roster to the link that reaches it. */
type ResolvedPeerPane = {
  record: LinkRecord
  linkId: string
  publicKey: string
  handle: string
  /** The pane's id **on the owner's machine**, never the namespaced one. */
  terminalId: string
  pane: PeerPane
}

/**
 * How many panes of this machine one link may have keystrokes waiting at.
 * Eight is past anything anybody does and short of a prompt at every pane.
 */
export const MAX_PENDING_PER_LINK = 8

/**
 * How much of one burst is held while the owner is asked. A minute of fast
 * typing is some six hundred keystrokes; the byte cap is the real bound, since
 * a paste is sixty-four kilobytes. Past either, refused with the reason.
 */
export const MAX_HELD_WRITES = 1_000
export const MAX_HELD_BYTES = 262_144

/** One teammate's held keystrokes at one pane, and the promises owed for them. */
type PendingRequest = {
  id: string
  /** The link they arrived on, which is also the connection the answer is judged against. */
  linkId: string
  publicKey: string
  handle: string
  projectId: string
  /** This machine's own pane id, from this machine's own list. */
  terminalId: string
  since: number
  at: number
  expiresAt: number
  bytes: number
  /** In arrival order, which is the order they will reach the pty in. */
  held: HeldWrite[]
  cancelExpiry: () => void
}

/** One keystroke that has not happened yet, and the caller waiting to hear. */
type HeldWrite = {
  write: RemoteWriteRequest
  settle: (decision: RemoteWriteDecision) => void
}

/** How a held keystroke ended. `allowed` is the only one that reaches a pty. */
type SettledAs = 'allowed' | 'denied' | 'expired' | 'muted'

/** A standing permission as this runtime holds it. */
type StandingGrant = {
  terminalId: string
  publicKey: string
  scope: ConsentScope
  since: number
}

/**
 * How a permission and a held burst are keyed: one pane, one person. Pane alone
 * would be "anyone may type here", person alone "ana may type anywhere". NUL
 * separator, as for the typists: neither an id nor a base64 key can contain one.
 */
function consentKeyOf(terminalId: string, publicKey: string): string {
  return `${terminalId}\u0000${publicKey}`
}

/** One pending request, in the shape the owner's window and the CLI read. */
function describeRequest(request: PendingRequest): ConsentRequest {
  const { preview, clipped } = previewOf(request.held.map((item) => item.write.data))
  return {
    id: request.id,
    projectId: request.projectId,
    terminalId: request.terminalId,
    handle: request.handle,
    publicKey: request.publicKey,
    since: request.since,
    at: request.at,
    expiresAt: request.expiresAt,
    writes: request.held.length,
    bytes: request.bytes,
    preview,
    clipped
  }
}

/**
 * A verdict that has to be a decision. `#judge` is given `consented` on this
 * path so the branch below is unreachable today; it is written out rather than
 * cast away so no keystroke's promise is ever left unsettled.
 */
function decisionOf(verdict: RemoteWriteVerdict): RemoteWriteDecision {
  if (!('held' in verdict)) return verdict
  return {
    ok: false,
    code: ErrorCode.Conflict,
    message: 'the owner’s machine held this keystroke twice, so it was not run'
  }
}

/** Everything about a write that is known before it is judged. */
type WriteStamp = {
  at: number
  handle: string
  publicKey: string
  projectId: string
  terminalId: string
  /** Whether `terminalId` is a pane of this machine rather than a string the caller made up; only the first is attributed. */
  known: boolean
}

/** What `openWatch` resolved, and the start the subscription hub drives. */
export type OpenedWatch = {
  handle: string
  cols: number
  rows: number
  start: (channel: SubscriptionChannel) => () => void
}

/**
 * How much of a public key a namespaced id carries: seventy-two bits, not an
 * identity (the roster it is matched against is) but enough to pick one row.
 */
const KEY_PREFIX_LENGTH = 12

/** How much of a key stands in for a name when no roster has one. */
const SHORT_KEY_LENGTH = 8

/** What a watcher letterboxes to when a teammate's runtime sends no dimensions. */
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

/** Splits `peer:<key prefix>:<the owner's own terminal id>`. */
export function parsePeerPaneId(paneId: string): { keyPrefix: string; terminalId: string } | undefined {
  const match = /^peer:([A-Za-z0-9+/=_-]+):(.+)$/.exec(paneId)
  const keyPrefix = match?.[1]
  const terminalId = match?.[2]
  if (keyPrefix === undefined || terminalId === undefined) return undefined
  if (keyPrefix.length !== KEY_PREFIX_LENGTH) return undefined
  return { keyPrefix, terminalId }
}

/** The pane as the teammate last described it, in the project this link is for. */
function findPane(presence: PeerPresence, projectKey: string, terminalId: string): PeerPane | undefined {
  const project = presence.projects.find((candidate) => candidate.projectKey === projectKey)
  if (!project) return undefined
  for (const worktree of project.worktrees) {
    const pane = worktree.panes.find((candidate) => candidate.id === terminalId)
    if (pane) return pane
  }
  return undefined
}

/**
 * One teammate in one repository. Keyed by the project *key*, not the local id:
 * two clones of one repository would otherwise open two links on one rendezvous
 * and displace each other. Both keys whole: this is also the connection id, and
 * a shared one would let a session answer under somebody else's name.
 */
export function linkIdFor(publicKey: string, projectKey: string): string {
  return `peer_${publicKey}_${projectKey}`
}

type WantedLink = {
  publicKey: string
  projectKey: string
  handle: string
  relayUrl: string
}

/** What one link last said, and whether that is still a live claim. */
type HeardPresence = {
  publicKey: string
  presence: PeerPresence
  /** This machine's clock when it arrived, or when the cache recorded it. */
  heardAt: number
  /** True only between a frame decrypting on this session and that session ending. */
  live: boolean
}

/**
 * Whether a snapshot is worth applying over the one held. Revisions only
 * increase within one session; a restarted peer begins again at 1, so the
 * caller stops offering the old one the moment its session ends.
 */
export function isNewerPresence(held: PeerPresence | undefined, incoming: PeerPresence): boolean {
  return held === undefined || incoming.revision > held.revision
}

/**
 * How a pane id that is not this machine's is written down: a digest, never the
 * caller's string, because the record is the owner's evidence rotated at a size
 * and a verbatim copy lets the sender choose what fits. Short: a label, not a commitment.
 */
export function strangePaneId(terminalId: string): string {
  return `unknown:${createHash('sha256').update(terminalId, 'utf8').digest('hex').slice(0, 12)}`
}

/** The most recent keystroke in one pane, whoever sent it. */
function lastTypedAt(typists: Map<string, PaneTypist>): number {
  let latest = 0
  for (const typist of typists.values()) latest = Math.max(latest, typist.at)
  return latest
}

/** Whether anybody's keystroke ever actually reached this pane. */
function everLanded(typists: Map<string, PaneTypist>): boolean {
  for (const typist of typists.values()) if (typist.writes > 0) return true
  return false
}

/** How the live record of who typed is keyed: project as well as pane, since a pane id is a string a teammate can name. */
function typistKey(projectId: string, terminalId: string): string {
  return `${projectId}\u0000${terminalId}`
}

/** What one link has sent at ids that are no pane of this machine's. */
type UnaimedBurst = {
  /** When this burst started, by this machine's clock. */
  since: number
  /** How many of it have been filed in full. */
  logged: number
  /** How many have only been counted. */
  collapsed: number
  /** How much those carried between them. */
  bytes: number
  /** The last of them, which is what the collapsed entry is shaped from. */
  last?: RemoteWrite
}

/**
 * How long unaimed keystrokes are gathered before the count restarts, and how
 * many are filed in full first. A minute and twenty: an honest teammate is
 * never collapsed, and a flood costs the log one entry a minute.
 */
export const UNAIMED_BURST_MS = 60_000
export const UNAIMED_LOGGED_PER_BURST = 20

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A snapshot from a teammate's runtime, as it arrived. A schema rather than the
 * type in `src/shared/entities.ts`, because these bytes are somebody else's.
 */
const PanePayload = z.object({
  id: z.string().min(1),
  title: z.string(),
  shell: z.string(),
  agent: z.enum(AGENT_KINDS as [string, ...string[]]).optional(),
  running: z.boolean(),
  exitCode: z.number().optional(),
  busy: z.boolean(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  quietForMs: z.number().nonnegative()
})

const WorktreePayload = z.object({
  id: z.string().min(1),
  name: z.string(),
  branch: z.string(),
  state: z.enum(['creating', 'ready', 'removing', 'failed']),
  panes: z.array(PanePayload)
})

const ProjectPayload = z.object({
  projectKey: z.string().min(1),
  worktrees: z.array(WorktreePayload)
})

const PresencePayload = z.object({
  revision: z.number(),
  // Nullish rather than nullable: a runtime older than the field sends nothing
  // rather than null, and refusing that would blank a working teammate.
  handle: z.string().nullish(),
  projects: z.array(ProjectPayload)
})

/**
 * Whether a snapshot is one at all, and how much of it is kept. Refusing: a
 * two-field check let `{revision, projects: [null]}` through and the throw in
 * the delivery path poisoned the entry, freezing the sidebar. Bounding: the
 * numbers are `store/teammateCache.ts`'s, so memory and disk agree. Narrowed
 * to `onlyProjectKey`: a session is for one repository.
 */
export function parsePeerPresence(value: unknown, onlyProjectKey: string | undefined): PeerPresence | undefined {
  const parsed = PresencePayload.safeParse(value)
  if (!parsed.success) return undefined
  const project = parsed.data.projects.find((candidate) => candidate.projectKey === onlyProjectKey)
  return {
    revision: parsed.data.revision,
    handle: parsed.data.handle ?? null,
    // `AGENT_KINDS` is an array rather than a tuple, so `z.enum` over it widens
    // the agent to `string`; the cast puts it back, as in `store/teammateCache.ts`.
    projects: project ? [boundProject(project as PeerProject)] : []
  }
}

function boundProject(project: PeerProject): PeerProject {
  return {
    projectKey: project.projectKey,
    worktrees: project.worktrees.slice(0, MAX_CACHED_WORKTREES).map(boundWorktree)
  }
}

function boundWorktree(worktree: PeerWorktree): PeerWorktree {
  return {
    ...worktree,
    id: clip(worktree.id),
    name: clip(worktree.name),
    branch: clip(worktree.branch),
    panes: worktree.panes.slice(0, MAX_CACHED_PANES).map(boundPane)
  }
}

function boundPane(pane: PeerPane): PeerPane {
  return { ...pane, id: clip(pane.id), title: clip(pane.title), shell: clip(pane.shell) }
}

function clip(text: string): string {
  return text.length <= MAX_CACHED_TEXT ? text : text.slice(0, MAX_CACHED_TEXT)
}
