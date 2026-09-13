// Teamwork's live half: one link per teammate, what they are showing, and what
// this runtime shows them.
//
// The service is the only thing that knows the whole picture, and it keeps
// three things in step:
//
//   * **Links.** One per teammate **per project**, because the rendezvous is
//     derived from the project as well as from the two keys. Two people who
//     share three repositories hold three sessions, each of which knows in its
//     own Noise transcript which project it is for. A link exists while that
//     key is on that project's roster and that project has a relay; it is
//     stopped the moment it is not, which is what makes revocation take effect
//     at fetch speed rather than at restart speed.
//
//   * **What they told us.** The latest snapshot per peer, kept by revision so
//     a reply overtaken in flight cannot put the sidebar back into a past its
//     sender has already left.
//
//   * **What we tell them.** A revision that moves whenever anything in the
//     workspace does, pushed to every subscribed peer, filtered per project by
//     that project's roster.
//
// The roster is still checked in both directions, and with per-project sessions
// that is now defence in depth rather than the only defence. Sending is
// filtered so a teammate on one repository is not shown another's worktrees.
// Receiving is filtered so a teammate cannot claim a project key they are not a
// member of — the key is a hash of a remote, and somebody who knows the
// repository exists can compute one.

import type {
  PeerLink as PeerLinkStatus,
  PeerPresence,
  Project,
  TeammatePresence,
  TeammateWorktree,
  TeamworkStatus,
  Terminal,
  Worktree
} from '../../../shared/entities'
import type { ParamsOf } from '../../../shared/methods'
import { createGitRunner, type GitRunner } from '../../git/gitProcess'
import type { Dispatcher } from '../../runtime/dispatcher'
import type { SubscriptionChannel, SubscriptionHub } from '../../runtime/subscriptionHub'
import { notFound } from '../../runtime/runtimeError'
import { loadIdentity, loadStaticPrivateKey } from '../identity'
import { readRoster } from '../roster'
import { createPeerLink, type LinkScheduler, type PeerLink } from './peerLink'
import { presenceFor, type PresenceProject, type PresenceSource } from './presence'
import { readProjectKey } from './projectKey'
import { readRelayConfig, type RelayLocation } from './relayUrl'
import { webSocketDialer, type RelayDialer } from './relaySocket'

/**
 * How long a burst of workspace changes is gathered before peers are told.
 *
 * One action fans out into several events, and a link with real latency should
 * not carry a snapshot per event. Longer than the local stream's window,
 * because the reader is across a relay rather than across a process boundary.
 */
export const PRESENCE_COALESCE_MS = 150

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
  env?: NodeJS.ProcessEnv
  /** Publishes `{ type: 'teammates' }` so the window re-reads. */
  onChange: () => void
  onError?: (error: unknown) => void
}

type ProjectFacts = {
  projectId: string
  projectKey: string | undefined
  rosterKeys: string[]
  /** Public key to the handle the roster files it under, for display. */
  handles: Map<string, string>
  relay: RelayLocation | null
  /** Why teamwork is not running for this project, or null when it is. */
  disabledReason: string | null
}

type LinkRecord = {
  link: PeerLink
  status: PeerLinkStatus
  relayUrl: string
}

const defaultScheduler: LinkScheduler = {
  now: () => Date.now(),
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
   * The latest snapshot per *link*, not per teammate.
   *
   * Keyed by the link, because a link is one teammate in one project: a
   * snapshot that arrived over the session for one repository can then never be
   * read out under another, whatever it claims to contain.
   */
  readonly #heard = new Map<string, { publicKey: string; presence: PeerPresence; heardAt: number }>()
  readonly #subscribers = new Map<string, SubscriptionChannel>()

  #dispatch: Dispatcher | undefined
  #identityKey: string | null = null
  #handle: string | null = null
  #privateKey: Uint8Array | undefined
  #revision = 0
  #started = false
  #cancelCoalesce: (() => void) | undefined

  constructor(options: PeerServiceOptions) {
    this.#options = options
    this.#runner = options.runner ?? createGitRunner()
    this.#scheduler = options.scheduler ?? defaultScheduler
    this.#dial = options.dial ?? webSocketDialer
  }

  /**
   * The dispatcher is built after the handlers are registered, so it arrives
   * here afterwards rather than in the constructor. Until it does, no peer can
   * be answered — which is correct, because there is nothing to answer with.
   */
  attach(dispatch: Dispatcher): void {
    this.#dispatch = dispatch
  }

  /** Reads the rosters and relays, then brings every link it finds up. */
  async start(): Promise<void> {
    this.#started = true
    await this.reconcile()
  }

  stop(): void {
    this.#started = false
    this.#cancelCoalesce?.()
    this.#cancelCoalesce = undefined
    for (const record of this.#links.values()) record.link.stop()
    this.#links.clear()
    this.#peerByConnection.clear()
    this.#subscribers.clear()
  }

  /**
   * Re-reads what the repositories say and makes the links agree with it.
   *
   * Called at startup and whenever a roster or a project list changes, which is
   * what "revocation happens at git-fetch speed" means in practice: the key
   * leaves the directory, the next read drops the link.
   */
  async reconcile(): Promise<void> {
    if (!this.#started) return
    const identity = await loadIdentity(this.#options.dataDir)
    this.#identityKey = identity.publicKey

    const facts = await Promise.all(this.#options.workspace.listProjects().map((project) => this.#readProject(project)))
    this.#projects.clear()
    for (const fact of facts) this.#projects.set(fact.projectId, fact)

    // One link per (teammate, project) that has a relay and a project key. Each
    // gets its own rendezvous and its own session, so nothing downstream has to
    // work out which repository a message was about.
    const wanted = new Map<string, WantedLink>()
    for (const fact of [...this.#projects.values()].sort((a, b) => a.projectId.localeCompare(b.projectId))) {
      if (!fact.relay || fact.disabledReason !== null || fact.projectKey === undefined) continue
      for (const key of fact.rosterKeys) {
        if (key === identity.publicKey) continue
        wanted.set(linkIdFor(key, fact.projectKey), {
          publicKey: key,
          projectKey: fact.projectKey,
          handle: this.#handleFor(key) ?? key.slice(0, 8),
          relayUrl: fact.relay.url
        })
      }
    }
    this.#handle = this.#handleFor(identity.publicKey) ?? null

    for (const [linkId, record] of [...this.#links]) {
      const want = wanted.get(linkId)
      // A relay that moved is a different link, not the same one reconnecting.
      if (want && want.relayUrl === record.relayUrl) continue
      record.link.stop()
      this.#links.delete(linkId)
      this.#peerByConnection.delete(linkId)
      this.#heard.delete(linkId)
    }

    if (wanted.size > 0) this.#privateKey ??= await loadStaticPrivateKey(this.#options.dataDir)

    for (const [linkId, want] of wanted) {
      if (this.#links.has(linkId)) continue
      this.#open(linkId, want)
    }

    this.#options.onChange()
  }

  /** Everything a window needs to say whether teamwork is running here. */
  status(params: ParamsOf<'teamwork.status'>): TeamworkStatus {
    const facts = this.#projects.get(params.projectId)
    if (!facts) throw notFound(`no project with id ${params.projectId}`)

    const links = facts.rosterKeys
      .filter((key) => key !== this.#identityKey)
      .map((key) =>
        facts.projectKey === undefined ? undefined : this.#links.get(linkIdFor(key, facts.projectKey))?.status
      )
      .filter((status): status is PeerLinkStatus => status !== undefined)

    return {
      projectId: facts.projectId,
      relay: facts.relay,
      disabledReason: facts.disabledReason,
      links,
      readAt: this.#scheduler.now()
    }
  }

  /** Every teammate's worktrees in one project, as last heard. */
  presence(params: ParamsOf<'teamwork.presence'>): TeammatePresence {
    const facts = this.#projects.get(params.projectId)
    if (!facts) throw notFound(`no project with id ${params.projectId}`)

    const now = this.#scheduler.now()
    const worktrees: TeammateWorktree[] = []
    if (facts.projectKey !== undefined) {
      // Reached through this project's own links, so a snapshot heard on
      // another repository's session cannot be read out here however it is
      // shaped. Being on the roster is still required: it is what makes a
      // project key — which is only a hash of a remote, computable by anybody
      // who knows the repository exists — mean something when it is claimed.
      for (const publicKey of facts.rosterKeys) {
        if (publicKey === this.#identityKey) continue
        const entry = this.#heard.get(linkIdFor(publicKey, facts.projectKey))
        if (!entry) continue
        const project = entry.presence.projects.find((candidate) => candidate.projectKey === facts.projectKey)
        if (!project) continue
        const handle = this.#handleFor(publicKey) ?? entry.presence.handle ?? publicKey.slice(0, 8)
        for (const worktree of project.worktrees) {
          worktrees.push({
            ...worktree,
            // Namespaced, because a teammate's worktree id is theirs and two
            // installations can and do generate the same one.
            id: `peer:${publicKey.slice(0, 12)}:${worktree.id}`,
            panes: worktree.panes.map((pane) => ({ ...pane, id: `peer:${publicKey.slice(0, 12)}:${pane.id}` })),
            handle,
            publicKey,
            heardAt: entry.heardAt
          })
        }
      }
    }

    worktrees.sort((a, b) => a.handle.localeCompare(b.handle) || a.name.localeCompare(b.name))
    return { projectId: facts.projectId, worktrees, readAt: now }
  }

  /**
   * PEER-ONLY. What this runtime is doing, for the teammate on the far end of
   * `connectionId` — identified by the key their handshake authenticated, never
   * by anything they said in a message.
   */
  peerPresence(connectionId: string): PeerPresence {
    const peer = this.#peerByConnection.get(connectionId)
    if (peer === undefined) throw notFound('this connection is not a peer link')
    // Narrowed to the one project this session is for, on top of the roster
    // filter. The session already cannot be about anything else — the project
    // is in its rendezvous and in its Noise prologue — and this is the same
    // fact enforced where the data is chosen rather than only where it met.
    return presenceFor(
      { source: this.#presenceSource(peer.projectKey), now: this.#scheduler.now },
      peer.publicKey,
      this.#handle,
      this.#revision
    )
  }

  /** PEER-ONLY. The same snapshot, now and on every change. */
  peerSubscribe(connectionId: string, channel: SubscriptionChannel): () => void {
    const snapshot = this.peerPresence(connectionId)
    this.#subscribers.set(connectionId, channel)
    // Immediately, so there is no separate first read for the stream to race.
    channel.emit(snapshot)
    return () => {
      this.#subscribers.delete(connectionId)
    }
  }

  /**
   * Something in the workspace moved. Bump the revision and tell the peers,
   * once for the burst rather than once per event.
   */
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

    // Before the link can dial, so the first `peer.presence` it answers already
    // knows whose it is and which project it is for. The link id is also the
    // connection id, so there is one name for one session rather than two that
    // can stop agreeing.
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
        // Anything but `connected` means nothing has confirmed on this session,
        // so what it last showed is no longer something this app will render as
        // live. Milestone E is what gives it a stale life instead.
        if (status.phase !== 'connected') this.#heard.delete(linkId)
        this.#options.onChange()
      },
      onPresence: (presence) => this.#record(linkId, want.publicKey, presence),
      onError: this.#options.onError
    })

    this.#links.set(linkId, { link, status: link.status, relayUrl: want.relayUrl })
    link.start()
  }

  /** Drops a snapshot that is behind the one already held for this link. */
  #record(linkId: string, publicKey: string, presence: PeerPresence): void {
    if (!isPresence(presence)) return
    if (!isNewerPresence(this.#heard.get(linkId)?.presence, presence)) return
    this.#heard.set(linkId, { publicKey, presence, heardAt: this.#scheduler.now() })
    this.#options.onChange()
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

  #handleFor(publicKey: string): string | undefined {
    for (const fact of this.#projects.values()) {
      const handle = fact.handles.get(publicKey)
      if (handle !== undefined) return handle
    }
    return undefined
  }

  async #readProject(project: Project): Promise<ProjectFacts> {
    const [roster, relay, key] = await Promise.all([
      readRoster(project.path).catch(() => ({ entries: [], problems: [] })),
      readRelayConfig(project.path, this.#options.env),
      readProjectKey(this.#runner, project.path)
    ])

    const handles = new Map(roster.entries.map((entry) => [entry.publicKey, entry.handle]))
    const facts: ProjectFacts = {
      projectId: project.id,
      projectKey: key.ok ? key.key : undefined,
      rosterKeys: roster.entries.map((entry) => entry.publicKey),
      relay: relay.configured ? relay.location : null,
      disabledReason: null,
      handles
    }

    // Ordered from the thing a user fixes first. "No relay" is the ordinary
    // state of a project nobody has set teamwork up on, and saying that before
    // anything else is what stops the row reading as a fault.
    if (!relay.configured) facts.disabledReason = relay.reason
    else if (!key.ok) facts.disabledReason = key.reason
    else if (roster.entries.length === 0) {
      facts.disabledReason = 'nobody has joined this project yet, so there is no roster to meet anyone from'
    }
    return facts
  }
}

/**
 * One teammate in one repository.
 *
 * Keyed by the project *key* rather than the local project id, because the key
 * is what the rendezvous is derived from. Two local clones of one repository
 * added as two projects would otherwise open two links on one rendezvous and
 * displace each other for as long as the app ran; sharing the link is both
 * correct and what the relay's own "a newer connection claimed this rendezvous"
 * rule would force anyway.
 */
export function linkIdFor(publicKey: string, projectKey: string): string {
  return `peer_${publicKey.slice(0, 12)}_${projectKey.slice(0, 16)}`
}

type WantedLink = {
  publicKey: string
  projectKey: string
  handle: string
  relayUrl: string
}

/**
 * Whether a snapshot is worth applying over the one already held.
 *
 * Revisions are per sender and only ever increase, so "behind" is an answer and
 * not a guess. A peer that restarted begins again at 1, which reads as behind —
 * and is, because its link was rebuilt and the old snapshot was dropped with
 * it, so there is nothing for a fresh one to be behind.
 */
export function isNewerPresence(held: PeerPresence | undefined, incoming: PeerPresence): boolean {
  return held === undefined || incoming.revision > held.revision
}

/** A peer's own runtime produced this, but it still arrived over a wire. */
function isPresence(value: unknown): value is PeerPresence {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.revision === 'number' && Array.isArray(record.projects)
}
