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

import { join } from 'node:path'
import {
  TYPING_WINDOW_MS,
  type PaneTypist,
  type PaneWatcher,
  type PaneWatchers,
  type PeerLink as PeerLinkStatus,
  type PeerPane,
  type PeerPresence,
  type Project,
  type RemoteWrite,
  type RemoteWriteLog,
  type RemoteWriteOutcome,
  type TeammatePresence,
  type TeammateStanding,
  type TeammateWorktree,
  type TeamworkStatus,
  type Terminal,
  type WatchedPane,
  type Worktree
} from '../../../shared/entities'
import type { ParamsOf, ResultOf } from '../../../shared/methods'
import { createGitRunner, type GitRunner } from '../../git/gitProcess'
import type { Dispatcher } from '../../runtime/dispatcher'
import { PeerCallError, type RemoteWriteRequest, type RemoteWriteVerdict } from '../../runtime/peerTransport'
import type { SubscriptionChannel, SubscriptionHub } from '../../runtime/subscriptionHub'
import { notFound } from '../../runtime/runtimeError'
import { ErrorCode } from '../../../shared/protocol'
import { TeammateCacheStore, TEAMMATE_CACHE_FILE, type TeammateCache } from '../../store/teammateCache'
import { badPaneId, TeamworkError } from '../errors'
import { createRemoteWriteLog, returnsIn, type RemoteWriteRecorder } from './writeLog'
import { loadIdentity, loadStaticPrivateKey } from '../identity'
import { readRoster } from '../roster'
import { watchPane } from './paneWatch'
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
  /** What each teammate last showed, across a drop and across a restart. */
  cache?: TeammateCache
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
  readonly #heard = new Map<string, HeardPresence>()
  readonly #subscribers = new Map<string, SubscriptionChannel>()
  /**
   * Which of this machine's panes each link's teammate has open, and since
   * when.
   *
   * Keyed by the link, so the answer is per teammate per project and a watcher
   * on one repository is never reported on another's row.
   */
  readonly #watchers = new Map<string, Map<string, number>>()
  /**
   * Panes *this* machine is reading, by the link they are read over.
   *
   * Kept so a link going down can say so. A stream that simply stopped would
   * leave a reader looking at a window that no longer updates, which reads as a
   * teammate who went quiet rather than a teammate who went away.
   */
  readonly #watching = new Map<string, Set<SubscriptionChannel>>()
  /**
   * Who has typed into each of this machine's panes, keyed by pane and then by
   * the key that typed.
   *
   * Keyed by the pane rather than by the link, unlike the watchers above,
   * because this is the owner's question and not the teammate's: what the owner
   * needs in front of them is "whose keystrokes are in this pane", and two
   * people typing into one pane is exactly the case that must not be able to
   * look like one.
   */
  readonly #typists = new Map<string, Map<string, PaneTypist>>()
  /**
   * Panes the owner has muted, by this machine's own terminal id.
   *
   * In memory, for the life of this runtime, and deliberately not on disk. A
   * mute is the owner's answer to something happening now; a mute file would
   * outlive the pane it named and would have to be pruned at startup, which is
   * the one moment pruning is least reliable — panes are being restored while
   * it runs. The cost is that a restart lifts every mute, and the reason that
   * is survivable is that a restart also rebuilds every link from nothing:
   * there is no stream in flight for a restored mute to catch, and the pane
   * says in the window whether it is muted.
   */
  readonly #muted = new Set<string>()
  readonly #log: RemoteWriteRecorder

  #cache: TeammateCache | undefined
  #dispatch: Dispatcher | undefined
  #identityKey: string | null = null
  #handle: string | null = null
  #privateKey: Uint8Array | undefined
  #revision = 0
  #started = false
  #cancelCoalesce: (() => void) | undefined
  /** When the window was last told about typing, so a burst is not a flood of reads. */
  #typingToldAt = 0
  #cancelTypingIdle: (() => void) | undefined

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
    // Before the links, so the sidebar has last night's picture from the first
    // frame it paints rather than after the first teammate answers.
    this.#cache ??=
      this.#options.cache ?? (await TeammateCacheStore.open(join(this.#options.dataDir, TEAMMATE_CACHE_FILE)))
    await this.reconcile()
  }

  stop(): void {
    this.#started = false
    this.#cancelCoalesce?.()
    this.#cancelCoalesce = undefined
    // What was heard is kept — that is the whole of milestone E — but with no
    // link behind it none of it is live any longer.
    for (const entry of this.#heard.values()) entry.live = false
    // A remembered worktree is honest; a remembered keystroke is not. Whoever
    // was mid-sentence is not typing into anything now, so the timer that would
    // have let their name fade on its own has nothing left to fade.
    this.#cancelTypingIdle?.()
    this.#cancelTypingIdle = undefined
    for (const record of this.#links.values()) record.link.stop()
    this.#links.clear()
    this.#peerByConnection.clear()
    this.#subscribers.clear()
    this.#watchers.clear()
    for (const linkId of Array.from(this.#watching.keys())) this.#endWatches(linkId, 'teamwork stopped')
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
      // A link the roster no longer wants is a revocation, and a revoked
      // teammate's rows go now rather than at the next restart. A link the
      // roster still wants — one whose relay merely moved — keeps what it was
      // showing, because it is about to come back to the same teammate. The
      // copy on disk is left to age out: telling "removed from the roster" from
      // "the roster could not be read this once" is not something this can do,
      // and wiping a cache on a transient read is the worse of the two.
      if (!want) this.#heard.delete(linkId)
      // The link is going either way, so anything being read across it stops
      // either way — a row that kept saying "watched by ana" after the link
      // went would be wrong in the reassuring direction, which is the one
      // direction this display must never be wrong in.
      this.#watchers.delete(linkId)
      this.#endWatches(
        linkId,
        want ? 'the link to this teammate is being remade' : 'this teammate is no longer on the project’s roster'
      )
    }

    if (wanted.size > 0) this.#privateKey ??= await loadStaticPrivateKey(this.#options.dataDir)

    // What was last heard, for every link the roster still wants, before
    // anything dials. A sidebar painted during the handshake then shows what
    // this machine knew instead of an empty project. It enters stale: a cached
    // snapshot has confirmed nothing, and everything downstream reads it that
    // way until a frame from the far end decrypts.
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

  /**
   * Every teammate's worktrees in one project, live or as last heard.
   *
   * Three things a reader has to be able to tell apart, and they are three
   * different shapes here rather than three readings of one:
   *
   *   * **Their machine is away.** Rows, with `live: false` and the age of what
   *     is on them. They are still working on that branch; you simply cannot
   *     see what it is doing this second.
   *   * **They are here and that worktree is gone.** No row. A snapshot is the
   *     whole of what a teammate has, so what is missing from the newest one is
   *     removed — the cache replaces rather than accumulates, and a worktree
   *     they deleted stops being shown the moment they say so.
   *   * **Nothing has ever been heard from them.** No rows and no cache, which
   *     is why `teammates` lists the roster separately: a colleague whose app
   *     has never been up while yours was is not a colleague with no worktrees.
   */
  presence(params: ParamsOf<'teamwork.presence'>): TeammatePresence {
    const facts = this.#projects.get(params.projectId)
    if (!facts) throw notFound(`no project with id ${params.projectId}`)

    const now = this.#scheduler.now()
    const worktrees: TeammateWorktree[] = []
    const teammates: TeammateStanding[] = []
    // Nothing is expected of a project teamwork is not running on, so nobody is
    // reported unheard from either: "nothing heard from ana" where there is no
    // relay would read as a fault rather than as a thing nobody has set up.
    const projectKey = facts.disabledReason === null ? facts.projectKey : undefined
    // Reached through this project's own links, so a snapshot heard on another
    // repository's session cannot be read out here however it is shaped. Being
    // on the roster is still required: it is what makes a project key — which
    // is only a hash of a remote, computable by anybody who knows the
    // repository exists — mean something when it is claimed.
    if (projectKey !== undefined) {
      for (const publicKey of facts.rosterKeys) {
        if (publicKey === this.#identityKey) continue
        const linkId = linkIdFor(publicKey, projectKey)
        const entry = this.#heard.get(linkId)
        const connected = this.#links.get(linkId)?.status.phase === 'connected'
        const handle = this.#handleFor(publicKey) ?? entry?.presence.handle ?? publicKey.slice(0, 8)
        teammates.push({ handle, publicKey, connected, heardAt: entry?.heardAt ?? null })
        if (!entry) continue
        const project = entry.presence.projects.find((candidate) => candidate.projectKey === projectKey)
        if (!project) continue
        // Both halves, because either one alone would be a way for a cached
        // snapshot to be read as a live one: the entry is only live if a frame
        // decrypted on it, and only while the link it decrypted on is still up.
        const live = entry.live && connected
        for (const worktree of project.worktrees) {
          worktrees.push({
            ...worktree,
            // Namespaced, because a teammate's worktree id is theirs and two
            // installations can and do generate the same one.
            id: `peer:${publicKey.slice(0, 12)}:${worktree.id}`,
            panes: worktree.panes.map((pane) => ({ ...pane, id: `peer:${publicKey.slice(0, 12)}:${pane.id}` })),
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
    return { projectId: facts.projectId, worktrees, teammates, readAt: now }
  }

  /**
   * Opens one of a teammate's panes for reading.
   *
   * Two steps rather than one, because the caller needs the owner's dimensions
   * in the same answer as the subscription id: this resolves the pane and the
   * link now, and hands back the start the subscription hub calls once it has a
   * channel. Nothing has been asked of the teammate until that runs, and
   * everything asked of them is released when it is torn down.
   */
  openWatch(params: ParamsOf<'teamwork.watch'>): OpenedWatch {
    const { record, handle, terminalId, pane, linkId } = this.#resolvePeerPane(params.projectId, params.paneId, 'read')
    return {
      handle,
      // The owner's, and never negotiated. `docs/teamwork.md`: a watcher with
      // a smaller window letterboxes rather than resizing a pty under a
      // program that is only being read.
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
   * Types into one of a teammate's panes.
   *
   * The same resolution `openWatch` does, for the same reason: a pane id is a
   * string a caller can type, and what makes it mean somebody is their key
   * being on this project's roster and their session being confirmed. What
   * crosses the wire is `terminal.write`, answered by their own terminal
   * service, gated by their own machine.
   *
   * A refusal from the far end is rethrown with the code they gave it, never
   * flattened into a generic failure: "that pane is muted" and "that pane is
   * gone" are what the person who typed needs, and are the difference between
   * a feature that is honest about failing and one that swallows keystrokes.
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
   * Who is reading this machine's panes and who has typed into them, right now,
   * and which of them the owner has muted.
   *
   * The owner's half of "everyone sees everything": both halves of it are
   * visible while they happen, in the same list the panes are in, because the
   * argument in `docs/teamwork.md` for why any of this is survivable is that
   * none of it can be done invisibly. A pane appears here for any of the three
   * reasons and not only for the first — a mute nobody can see is a mute nobody
   * can lift.
   */
  watchers(params: ParamsOf<'teamwork.watchers'>): PaneWatchers {
    const facts = this.#projects.get(params.projectId)
    if (!facts) throw notFound(`no project with id ${params.projectId}`)

    const byPane = new Map<string, PaneWatcher[]>()
    if (facts.projectKey !== undefined) {
      for (const publicKey of facts.rosterKeys) {
        if (publicKey === this.#identityKey) continue
        const linkId = linkIdFor(publicKey, facts.projectKey)
        const held = this.#watchers.get(linkId)
        if (!held || held.size === 0) continue
        const handle = this.#handleFor(publicKey) ?? publicKey.slice(0, 8)
        for (const [terminalId, since] of held) {
          const watchers = byPane.get(terminalId) ?? []
          watchers.push({ handle, publicKey, since })
          byPane.set(terminalId, watchers)
        }
      }
    }

    // Every pane of this project as well as every pane being read over one of
    // its links, so a mute or a typist on a pane nobody is watching is still
    // reported. Both halves are already scoped to this project — the watchers
    // by the link they arrived on, the panes by this machine's own list — so
    // one project's answer still cannot carry another's rows.
    const named = new Set([...byPane.keys(), ...this.#panesOf(facts.projectId)])

    const panes: WatchedPane[] = [...named]
      .map((terminalId) => ({
        terminalId,
        watchers: (byPane.get(terminalId) ?? []).sort((a, b) => a.handle.localeCompare(b.handle)),
        typists: [...(this.#typists.get(terminalId)?.values() ?? [])]
          .map((typist) => ({ ...typist }))
          .sort((a, b) => a.handle.localeCompare(b.handle)),
        muted: this.#muted.has(terminalId)
      }))
      .filter((pane) => pane.watchers.length > 0 || pane.typists.length > 0 || pane.muted)
      .sort((a, b) => a.terminalId.localeCompare(b.terminalId))

    return { projectId: facts.projectId, panes, readAt: this.#scheduler.now() }
  }

  /**
   * Stops, or restarts, remote keystrokes reaching one of this machine's panes.
   *
   * Instant, local, and nobody's business but the owner's: no round trip, no
   * agreement, and no way for a teammate to refuse it or to know it happened
   * except by being told their keystroke went nowhere. It takes effect on the
   * next keystroke to arrive, which — because the check and the pty write are
   * in one task with nothing awaited between them — is every keystroke that has
   * not already been written.
   */
  mute(params: ParamsOf<'teamwork.mute'>): PaneWatchers {
    const projectId = this.#projectOfPane(params.terminalId)
    if (projectId === undefined) throw notFound(`no pane of this machine with id ${params.terminalId}`)
    if (params.muted) this.#muted.add(params.terminalId)
    else this.#muted.delete(params.terminalId)
    this.#options.onChange()
    return this.watchers({ projectId })
  }

  /** The owner's record of every remote write, from their own disk. */
  writeLog(params: ParamsOf<'teamwork.writeLog'>): Promise<RemoteWriteLog> {
    return this.#log.read(params.limit)
  }

  /**
   * Whether one teammate's keystroke may reach one of this machine's panes, and
   * the record of it either way.
   *
   * THE ORDER IS THE POINT. The attribution and the record are updated before
   * the verdict is returned, and the verdict is returned into the same task
   * that dispatches the write — so there is no arrangement of events in which
   * bytes reach a pty and the owner cannot see whose they were. The disk copy
   * follows on its own; losing it would cost history, never attribution.
   *
   * Everything is checked against what this machine currently believes rather
   * than against anything the caller said: the key comes from the handshake,
   * the roster from the last read of the repository, and the pane from this
   * runtime's own list. A teammate whose key left the roster is refused at the
   * next keystroke, which is what "revocation at fetch speed" means here.
   */
  remoteWrite(connectionId: string, write: RemoteWriteRequest): RemoteWriteVerdict {
    const at = this.#scheduler.now()
    const peer = this.#peerByConnection.get(connectionId)
    if (!peer) {
      // Nothing to attribute it to, which is itself the reason to refuse: this
      // is a connection the peer service never opened.
      return this.#refuse(
        { at, handle: 'unknown', publicKey: '', projectId: '', terminalId: write.terminalId },
        write,
        'not-a-member',
        'this connection is not a peer link'
      )
    }

    const handle = this.#handleFor(peer.publicKey) ?? peer.publicKey.slice(0, 8)
    const stamp = { at, handle, publicKey: peer.publicKey, projectId: '', terminalId: write.terminalId }

    // On the roster of a project this session is actually for. Both halves
    // matter: the roster is membership, and the project key is what stops a
    // teammate reached over one repository's session typing into another's.
    const project = [...this.#projects.values()].find(
      (fact) =>
        fact.projectKey === peer.projectKey && fact.disabledReason === null && fact.rosterKeys.includes(peer.publicKey)
    )
    if (!project) {
      return this.#refuse(stamp, write, 'not-a-member', 'you are not on this project’s roster')
    }
    stamp.projectId = project.projectId

    // A pane of that project, and one that is still running. Resolved from this
    // machine's own list rather than from anything the caller named, which is
    // the same scoping `teamwork.watch` puts on reading.
    const pane = this.#paneOf(project.projectId, write.terminalId)
    if (!pane) {
      return this.#refuse(stamp, write, 'no-pane', `there is no pane ${write.terminalId} in this project`)
    }
    if (!pane.running) {
      return this.#refuse(stamp, write, 'no-pane', 'that pane’s process has exited')
    }

    // Last, and closest to the write, because it is the one that has to be
    // freshest: a mute applied a microsecond ago stops this keystroke.
    if (this.#muted.has(write.terminalId)) {
      return this.#refuse(stamp, write, 'muted', 'the owner has muted this pane')
    }

    this.#recordWrite(stamp, write, 'written')
    return { ok: true }
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
        // so what it last showed stops being live — and stays on screen, marked
        // stale and dated, because a row vanishing reads as a worktree deleted.
        // Not deleted, either: the revision it was heard at goes with it, so a
        // peer that restarted and began again at 1 is not mistaken for a reply
        // that arrived late.
        //
        // What a dropped link must never keep is anything that claims to be
        // happening now. A remembered worktree is honest; a remembered pair of
        // eyes is not.
        if (status.phase !== 'connected') {
          const entry = this.#heard.get(linkId)
          if (entry) entry.live = false
          // A link that is not up is not carrying anybody's eyes either, and a
          // row that kept saying "watched by ana" after her machine went would
          // be the one thing this display must never be: wrong in the
          // reassuring direction.
          this.#watchers.delete(linkId)
          // And the other direction: whatever this machine was reading over
          // that link has stopped arriving, so say so rather than freezing.
          this.#endWatches(linkId, `the link to ${want.handle} dropped`)
        }
        this.#options.onChange()
      },
      onPresence: (presence) => this.#record(linkId, want.publicKey, presence),
      onWatchersChange: (terminalIds) => this.#recordWatchers(linkId, terminalIds),
      onRemoteWrite: (write) => this.remoteWrite(linkId, write),
      onError: this.#options.onError
    })

    this.#links.set(linkId, { link, status: link.status, relayUrl: want.relayUrl })
    link.start()
  }

  /**
   * Drops a snapshot that is behind the one already held for this link.
   *
   * Only ever reached for a session that has confirmed key possession — the
   * link will not forward a stream event before that — so this is also the one
   * door through which anything becomes live. A cached entry is stale, and
   * what makes it live again is this, not the link coming up.
   */
  #record(linkId: string, publicKey: string, presence: PeerPresence): void {
    if (!isPresence(presence)) return
    const held = this.#heard.get(linkId)
    if (!isNewerPresence(held?.live === true ? held.presence : undefined, presence)) return
    const heardAt = this.#scheduler.now()
    this.#heard.set(linkId, { publicKey, presence, heardAt, live: true })
    // Only the project this session is for, out of everything the snapshot
    // happens to carry. A peer that named ten project keys it invented would
    // otherwise get ten cache slots for them and push out every real one.
    const projectKey = this.#peerByConnection.get(linkId)?.projectKey
    const project = presence.projects.find((candidate) => candidate.projectKey === projectKey)
    if (projectKey !== undefined && project) {
      this.#cache?.put({ publicKey, projectKey, handle: presence.handle, heardAt, worktrees: project.worktrees })
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
   *
   * `intent` is only ever words for the error, and it is a parameter because
   * "cannot be read" and "cannot be typed into" are two different sentences to
   * be told at the moment a link is down.
   */
  #resolvePeerPane(projectId: string, paneId: string, intent: string): ResolvedPeerPane {
    const facts = this.#projects.get(projectId)
    if (!facts) throw notFound(`no project with id ${projectId}`)
    if (facts.projectKey === undefined) throw notFound(`project ${projectId} is not shared with anyone`)

    const target = parsePeerPaneId(paneId)
    if (!target) throw badPaneId(`${paneId} is not a teammate’s pane id`)

    // Resolved through the roster and this project's own links, exactly as
    // `presence` is: a pane id is a string a caller can type, and the thing
    // that makes it mean somebody is their key being on this project's roster.
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
        handle: this.#handleFor(publicKey) ?? heard.presence.handle ?? publicKey.slice(0, 8),
        terminalId: target.terminalId,
        pane
      }
    }

    throw notFound(`no teammate pane with id ${paneId} in this project`)
  }

  /** Files a refused keystroke and turns it into the answer the teammate gets. */
  #refuse(
    stamp: WriteStamp,
    write: RemoteWriteRequest,
    outcome: RemoteWriteOutcome,
    reason: string
  ): RemoteWriteVerdict {
    this.#recordWrite(stamp, write, outcome, reason)
    // `conflict` for a mute because the pane is in a state the owner put it in
    // and a different argument would not help; `not_found` for the rest,
    // because from where the teammate stands there is nothing there to type at.
    const code = outcome === 'muted' ? ErrorCode.Conflict : ErrorCode.NotFound
    return { ok: false, code, message: reason }
  }

  /**
   * The attribution and the record, in that order and both before the caller
   * has an answer.
   *
   * The attribution is in memory and cannot fail, which is why it is the thing
   * the owner's guarantee rests on. The log is the durable copy of the same
   * fact and is allowed to be slower.
   */
  #recordWrite(stamp: WriteStamp, write: RemoteWriteRequest, outcome: RemoteWriteOutcome, reason?: string): void {
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
    this.#log.record(entry)
    this.#attribute(entry)
  }

  /** Who is typing in which pane, kept live so the owner is never in doubt. */
  #attribute(entry: RemoteWrite): void {
    const held = this.#typists.get(entry.terminalId) ?? new Map<string, PaneTypist>()
    const existing = held.get(entry.publicKey)
    const fresh = existing === undefined || entry.at - existing.at > TYPING_WINDOW_MS
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
    this.#typists.set(entry.terminalId, held)

    // Bounded, because this is a map keyed by something a long-running app
    // accumulates. The pane typed into least recently is the one to forget.
    while (this.#typists.size > MAX_TYPED_PANES) {
      const oldest = [...this.#typists].sort((a, b) => lastTypedAt(a[1]) - lastTypedAt(b[1]))[0]
      if (!oldest) break
      this.#typists.delete(oldest[0])
    }

    this.#tellWindowAboutTyping(entry.at, fresh)
  }

  /**
   * Wakes the window for a burst rather than for a keystroke.
   *
   * A read per keypress would be a refetch of three collections per keypress,
   * so a burst is announced when it starts, kept alive at a pulse while it goes
   * on, and announced once more when it has stopped — that last one matters
   * most, because a window that was never told is a window still saying
   * somebody is typing after they have walked away.
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
      if (pane) return pane
    }
    return undefined
  }

  /** Every pane id this machine has in one project. */
  #panesOf(projectId: string): string[] {
    return this.#options.workspace
      .listWorktrees(projectId)
      .flatMap((worktree) => this.#options.workspace.listTerminals(worktree.id).map((pane) => pane.id))
  }

  /** Which project one of this machine's panes is in. */
  #projectOfPane(terminalId: string): string | undefined {
    for (const fact of this.#projects.values()) {
      if (this.#paneOf(fact.projectId, terminalId)) return fact.projectId
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
 * How often a burst of typing wakes the window while it is still going.
 *
 * Twice a second. Fast enough that "ana is typing" is never a claim about a
 * second ago, slow enough that a paste or a fast typist is not a refetch per
 * keystroke.
 */
export const TYPING_PULSE_MS = 500

/**
 * How many panes' typists are remembered.
 *
 * A pane that is gone is not forgotten with it — the record of who typed in it
 * is the point — but a machine left running for a month must not accumulate
 * one of these per pane it has ever had. The durable record is the log.
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

/** Everything about a write that is known before it is judged. */
type WriteStamp = {
  at: number
  handle: string
  publicKey: string
  projectId: string
  terminalId: string
}

/** What `openWatch` resolved, and the start the subscription hub drives. */
export type OpenedWatch = {
  handle: string
  cols: number
  rows: number
  start: (channel: SubscriptionChannel) => () => void
}

/**
 * How much of a public key a namespaced id carries. Twelve base64 characters is
 * seventy-two bits, which is not an identity — the roster it is matched against
 * is — but is plenty to pick one row out of a team.
 */
const KEY_PREFIX_LENGTH = 12

/**
 * What a watcher letterboxes to when a teammate's runtime predates milestone C
 * and sends no dimensions. Eighty by twenty-four because that is what a pty
 * with nothing better to say is.
 */
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
 * Whether a snapshot is worth applying over the one already held.
 *
 * Revisions are per sender and only ever increase, so "behind" is an answer and
 * not a guess — but only within one session. A peer that restarted begins again
 * at 1, and the snapshot kept from before their laptop closed is not something
 * a fresh one can be behind, so the caller stops offering it as a comparison
 * the moment its session ends.
 */
export function isNewerPresence(held: PeerPresence | undefined, incoming: PeerPresence): boolean {
  return held === undefined || incoming.revision > held.revision
}

/** The most recent keystroke in one pane, whoever sent it. */
function lastTypedAt(typists: Map<string, PaneTypist>): number {
  let latest = 0
  for (const typist of typists.values()) latest = Math.max(latest, typist.at)
  return latest
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A peer's own runtime produced this, but it still arrived over a wire. */
function isPresence(value: unknown): value is PeerPresence {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.revision === 'number' && Array.isArray(record.projects)
}
