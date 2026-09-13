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
 *
 * One action fans out into several events, and a link with real latency should
 * not carry a snapshot per event. Longer than the local stream's window,
 * because the reader is across a relay rather than across a process boundary.
 */
export const PRESENCE_COALESCE_MS = 150

/**
 * How many of a project's pane ids are remembered after the panes have gone.
 *
 * This is a list of what this machine has already shown a teammate, kept so a
 * pane that closes under a reader can be named as closed rather than as never
 * having been theirs. Bounded because it is a memory of everything that ever
 * ran: a machine left open for a month would otherwise hold every id of it, and
 * nobody has had two hundred and fifty-six panes open in one repository.
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
  /**
   * How this machine hears that it has woken up. Electron's `powerMonitor` by
   * default, and nothing at all when there is no Electron to ask.
   */
  watchWake?: WakeWatch
  env?: NodeJS.ProcessEnv
  /** What each teammate last showed, across a drop and across a restart. */
  cache?: TeammateCache
  /**
   * Where the owner's mutes live between runs.
   *
   * A mute is answered from memory — it has to be instant, and instant is what
   * makes "anyone may type here" survivable — but it is the owner's standing
   * decision and not this process's, so it is read once at startup and written
   * through whenever it changes. Left out, mutes last as long as the runtime,
   * which is what a test that is not about restarts wants.
   */
  mutes?: MuteStore
  /**
   * Where the owner's standing permissions live between runs.
   *
   * The same bargain as the mutes above and the same reasoning: "always allow
   * ana on this pane" is a decision the owner took once, and a decision that
   * quietly lapsed at the next restart would be one they were never told they
   * had lost. Left out, an `always` grant lasts as long as the runtime — which
   * makes it a `session` grant wearing the wrong name, and is what a test that
   * is not about restarts wants.
   */
  consent?: ConsentStore
  /** Publishes `{ type: 'teammates' }` so the window re-reads. */
  onChange: () => void
  onError?: (error: unknown) => void
}

/**
 * The durable half of a mute, kept beside the terminal records so a mute is
 * dropped by the same removal that drops the pane it named.
 */
export type MuteStore = {
  list: () => readonly string[]
  set: (terminalId: string, muted: boolean) => void
}

/**
 * The durable half of an `always` grant, kept beside the terminal records for
 * exactly the reason a mute is: the permission is about one pane, so it is
 * dropped by the same removal that drops the pane, and there is nothing to
 * sweep at startup.
 *
 * A pair rather than an id, because this permission is about a person as well
 * as a pane. "Anyone may type here" is the thing the prompt exists to stop
 * being the default, and a grant that named only the pane would put it back.
 */
export type ConsentStore = {
  list: () => readonly { terminalId: string; publicKey: string; since: number }[]
  /**
   * `since` is when the owner gave it, and `null` takes it back. A time rather
   * than a flag because the owner is owed the date: a permission whose age
   * nothing knows is one nobody can weigh up when they come to review it.
   */
  set: (terminalId: string, publicKey: string, since: number | null) => void
}

type ProjectFacts = {
  projectId: string
  /** The checkout, kept so a read can ask whether `origin` has moved since. */
  path: string
  projectKey: string | undefined
  /**
   * What git's config looked like when `projectKey` was read from it.
   *
   * Everything else here comes out of `.teamree`, which is watched. `origin`
   * does not, so this is how a read tells a cached key from a stale one.
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
  /**
   * Whether `origin` gave a key, kept apart from `disabledReason` because a
   * project can be missing both a relay and an origin and only one of those
   * gets named as the first thing to fix.
   */
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
   * Pane ids this machine has resolved inside a project, kept after the pane
   * itself has closed.
   *
   * Per project and never global, because that is the whole of what it is safe
   * to say: a teammate on a project's roster is already shown that project's
   * panes in every presence snapshot, so telling them one of them has closed
   * adds nothing they did not have. Answering the same question about a project
   * they hold no key for would answer "is there a pane with this id somewhere
   * on your machine", which is the question `remoteRead` exists to refuse.
   */
  readonly #panesHeld = new Map<string, Set<string>>()
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
   * Per link, how many keystrokes that reached no pane of this machine have
   * been filed in full and how many have only been counted. See
   * `#recordUnaimed`.
   */
  readonly #unaimed = new Map<string, UnaimedBurst>()
  /**
   * When each teammate was last heard typing anywhere, by their key.
   *
   * A different question from `#unaimed`, which is about the durable log: this
   * is the clock the window's throttle is decided against, and it is per person
   * rather than per pane because the pane is named by the caller and the person
   * is named by their handshake. A burst is one burst however many pane ids it
   * mentions, and only the second of those two facts is one the far end gets a
   * vote on.
   */
  readonly #lastTypedAt = new Map<string, number>()
  /**
   * Panes the owner has muted, by this machine's own terminal id.
   *
   * Held in memory because a keystroke is judged against it in one synchronous
   * task and a file read is not — and written through to `options.mutes`,
   * because the decision is the owner's and not this process's. A pane comes
   * back from a restart under the id it had: `session-restore.ts` keeps it on
   * purpose, so the pane the owner silenced at six is, at nine, the same pane
   * with the same conversation in it. A mute that ended with the runtime would
   * be lifted at the one moment nothing on screen says it has been.
   *
   * Pruning is not a problem this has, because it is not this map's to do: the
   * mute is filed against the terminal record the pane is restored from, and
   * goes when that record does.
   */
  readonly #muted = new Set<string>()
  /**
   * Standing permissions, by pane and by the teammate they are for.
   *
   * The other side of the mute, and held in memory for the same reason: a
   * keystroke is judged against it in one synchronous task, and a file read is
   * not. `always` grants are written through to `options.consent`; `session`
   * grants are not, because their whole definition is that they end when this
   * runtime or that link does.
   */
  readonly #standing = new Map<string, StandingGrant>()
  /**
   * Keystrokes held at one of this machine's panes, waiting for the owner.
   *
   * NOTHING IN HERE HAS RUN, and that is the invariant the whole of this
   * feature rests on: a write reaches the pty from exactly one place — the
   * verdict returned into the task that dispatches it — and a held write has
   * not been given one. The bytes sit in this map, in this process's memory,
   * with the pty none the wiser.
   */
  readonly #pending = new Map<string, PendingRequest>()
  /**
   * Which request a teammate's next keystroke at a pane should join, by
   * `#consentKey`.
   *
   * One per teammate per pane, which is what makes a burst one question. A
   * person typing `npm test` sends eight keystrokes, and eight prompts is a
   * prompt nobody reads — and a prompt nobody reads is a prompt everybody
   * clicks through, which would be worse than no prompt at all.
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
    // Before anything can be typed at, so the first keystroke of the session
    // meets the decision the owner made in the last one.
    for (const terminalId of this.#options.mutes?.list() ?? []) this.#muted.add(terminalId)
    // And the permissions beside them, for the same reason and at the same
    // moment: the first keystroke of this session meets every decision the
    // owner has already taken, rather than asking them again for one they made
    // last week.
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
   * This machine slept, so nothing any link believes about a teammate is
   * current: every one of them withdraws its verdict and goes to find out
   * again.
   *
   * Each link also notices a sleep for itself, from its own clocks, and has to
   * — there is no Electron in the acceptance suite and none in the CLI. This is
   * the same conclusion arriving as soon as the machine is awake rather than at
   * the next deadline.
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
    // What was heard is kept — that is the whole of milestone E — but with no
    // link behind it none of it is live any longer.
    for (const entry of this.#heard.values()) entry.live = false
    // A remembered worktree is honest; a remembered keystroke is not. Whoever
    // was mid-sentence is not typing into anything now, so the timer that would
    // have let their name fade on its own has nothing left to fade.
    this.#cancelTypingIdle?.()
    this.#cancelTypingIdle = undefined
    this.#flushEveryUnaimed()
    this.#unaimed.clear()
    // Nobody is going to answer these now, and a held keystroke that nothing
    // ever settles is the failure this whole path exists to make impossible.
    // Said as an expiry rather than as a denial, because the owner did not
    // decide anything: their runtime went away underneath the question.
    for (const request of [...this.#pending.values()]) {
      this.#settle(request, request.held.length, 'expired', 'this runtime stopped while the owner was being asked')
    }
    // A session grant lasts as long as this runtime, which is exactly what this
    // is the end of. The durable ones stay: they are in a file, and they are
    // read back by the next `start`.
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

    const facts = await Promise.all(
      this.#options.workspace.listProjects().map((project) => this.#readProject(project, identity.publicKey))
    )
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
          handle: this.#handleIn(fact, key),
          relayUrl: fact.relay.url
        })
      }
    }

    for (const [linkId, record] of [...this.#links]) {
      const want = wanted.get(linkId)
      // A relay that moved is a different link, not the same one reconnecting.
      if (want && want.relayUrl === record.relayUrl) continue
      // Read before it is dropped, because a link that is going still has to be
      // able to name whose it was: what the roster no longer wants is exactly
      // the case with nothing left to look the key up in.
      const peer = this.#peerByConnection.get(linkId)
      record.link.stop()
      this.#links.delete(linkId)
      this.#peerByConnection.delete(linkId)
      // Whatever this link was still only counting goes down now, while there
      // is something left to name it by.
      const burst = this.#unaimed.get(linkId)
      if (burst) {
        this.#flushUnaimed(linkId, burst)
        this.#unaimed.delete(linkId)
      }
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
      // The same two clean-ups the phase change does, for the link that is
      // going away here rather than merely dropping. A revoked teammate must
      // not leave a question on the owner's screen that names them, and must
      // not leave a permission behind that a re-added key would inherit.
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

  /**
   * Everything a window needs to say whether teamwork is running here: a
   * synchronous read of what the last reconcile found.
   *
   * Staying synchronous is the point, because the window asks this for every
   * project on every refresh. The one fact behind it that nothing invalidates
   * is therefore checked by the handler, which awaits `refreshIfOriginMoved`
   * before asking.
   *
   * What that synchronous read cannot do is wait for a reconcile, and there are
   * two ordinary moments when the last one has not covered a project the
   * workspace already has: the beat between `project.add` writing it to the
   * store and the reconcile the resulting event sets off, and the whole of
   * startup before `start()` finishes. The facts are missing in both, and for
   * the same reason — nothing has read this project yet — so that is what is
   * answered. The workspace is asked directly, because it is the thing that
   * knows whether the project exists at all, and the difference between "not
   * read yet" and "no such project" is the entire point of asking: the first is
   * a project on screen whose row settles in a moment, and the second is a
   * caller holding an id for something this machine does not have.
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
   * Re-reads a project if `origin` has moved since the last reconcile.
   *
   * Every other fact behind `status` lives in `.teamree`, which is watched and
   * swept, so a change there reconciles on its own. The origin is git's own
   * config, nothing here watches it, and "no origin" is the state the runbook
   * says catches the person setting teamwork up for everybody else — the
   * example repository is created without a remote and adding one is step two.
   * So the read that reports it is the read that checks it.
   *
   * The check is a `stat`, which is why it can sit in front of a method the
   * window calls on every refresh; git is asked again only when that `stat`
   * says the answer could have changed.
   *
   * A whole reconcile rather than a re-read of the one project, because an
   * origin that has become usable gives the project a key, and the key is what
   * the links are made from: correcting the sentence on screen and leaving
   * nothing dialled would be a second way to be wrong.
   */
  async refreshIfOriginMoved(projectId: string): Promise<void> {
    const facts = this.#projects.get(projectId)
    if (!facts || originMark(facts.path) === facts.originMark) return
    await this.reconcile()
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
   *
   * And a fourth that is not about anybody: **this project has not been read**.
   * The window is `status`'s exactly — the beat between `project.add` and the
   * reconcile it sets off, and the whole of startup before `start()` finishes —
   * and it is answered the same way, by asking the workspace whether the
   * project exists at all. What it must not answer is an empty roster: that is
   * a finding, it says the repository was read and holds nobody but you, and it
   * would draw a project with four colleagues in it as a project with none.
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
        const handle = facts.handles.get(publicKey) ?? entry?.presence.handle ?? publicKey.slice(0, SHORT_KEY_LENGTH)
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
   *
   * The one read here that does not need a reconcile behind it, which is why it
   * answers for a project teamwork has not read yet rather than refusing one.
   * `presence` needs the roster and cannot honestly invent an empty one; this
   * needs nothing off the repository at all. A watcher and a typist both arrive
   * over a link, and a project with no facts has no links, so "nobody" is the
   * only thing that can be true of it — while the mutes are read back from the
   * owner's own decisions in `start()`, before the first reconcile, so a pane
   * silenced last week says so from the first frame after a restart. Losing
   * that to a `not_found` was the worst of the three: a restored window asking
   * about a pane it is already drawing, told the project it belongs to does not
   * exist.
   */
  watchers(params: ParamsOf<'teamwork.watchers'>): PaneWatchers {
    // Only that the project exists, which is all this answer rests on. The
    // facts are used where they have something to add and their absence is a
    // shorter answer rather than a wrong one.
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

    // Every pane of this project as well as every pane being read over one of
    // its links, so a mute or a typist on a pane nobody is watching is still
    // reported. All three halves are scoped to this project — the watchers by
    // the link they arrived on, the panes by this machine's own list, the
    // typists by the project the keystroke resolved in — so one project's
    // answer cannot carry another's rows. The typists were not, once: the map
    // was keyed by pane id alone, so a keystroke refused for naming a pane of
    // an unrelated project still put its sender's name on that project's row.
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
   *
   * Instant, local, and nobody's business but the owner's: no round trip, no
   * agreement, and no way for a teammate to refuse it or to know it happened
   * except by being told their keystroke went nowhere. It takes effect on the
   * next keystroke to arrive, which — because the check and the pty write are
   * in one task with nothing awaited between them — is every keystroke that has
   * not already been written.
   *
   * And it stands past this runtime. The decision goes to `options.mutes` on
   * its way through, so the pane the owner silenced is still silenced when it
   * comes back from a restart under the id `session-restore.ts` kept for it.
   *
   * It is also answerable from the first frame after that restart, before
   * teamwork has read a repository — which it has to be, because `watchers` is
   * answerable then and draws the row with the mute on it. Every half of this
   * is already this machine's own at that moment: the durable record keyed by
   * this machine's own terminal ids and read back in `start()`, the set beside
   * it, and the project, which `#projectOfPane` finds in the workspace rather
   * than in the facts. The only thing a reconcile would add is links, and the
   * prompts settled and permissions dropped below all arrive over one — so a
   * project with no facts has nothing for those two loops to find, rather than
   * something they would miss. Refusing the call for want of the project put
   * the owner one click from an error on a pane their own window was drawing as
   * muted, which is worse than a read that lies: a control that visibly does
   * nothing.
   */
  mute(params: ParamsOf<'teamwork.mute'>): PaneWatchers {
    const projectId = this.#projectOfPane(params.terminalId)
    if (projectId === undefined) throw notFound(`no pane of this machine with id ${params.terminalId}`)
    if (params.muted) {
      this.#muted.add(params.terminalId)
      // A mute is the widest answer there is, so it answers everything narrower
      // that was outstanding. Leaving a prompt up for a pane the owner has just
      // silenced would put a question on screen whose every answer is already
      // decided, and leaving a standing permission behind it would mean the
      // mute lasted exactly as long as the next unmute.
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
   * What is waiting on the owner in one project, and what they have already
   * allowed.
   *
   * Scoped to a project like everything else here, and for the same reason: a
   * pane id is a string, and what makes one mean somebody's pane is the project
   * it was resolved in. A request filed against a pane of another project
   * cannot be listed here, so it cannot be answered from here either.
   *
   * Answered for a project teamwork has not read yet, on `watchers`' argument
   * rather than `presence`'s, because both halves hold without a reconcile. A
   * held burst is a teammate's keystroke and arrives over a link, so a project
   * with no facts has nothing waiting; the standing permissions are the owner's
   * own and are restored in `start()` before the first reconcile runs. The one
   * thing the roster adds is the name to put beside a key — and `#handleIn`
   * already falls back to the key for a teammate the roster does not name, so a
   * roster that has not been read yet lands in a case this answer has always
   * had. A key where a handle will be is a shorter sentence; "no project with
   * id" was a false one, said to an owner whose pane is on screen with somebody
   * else's permission standing on it.
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

    // Only for panes this project still has. A grant outlives a runtime but not
    // its pane, and one whose pane has gone is a row the owner could not act on
    // — the pane it names is not on their screen to be found.
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
   * The owner's answer to one held burst.
   *
   * `through` is the length of the burst as the owner saw it, and honouring it
   * is the whole difference between a prompt and a rubber stamp: keystrokes
   * arrive while the question is on screen, and an "allow once" taken on four
   * of them must not let the fourteenth through. What is left over stays held,
   * under a new request with a fresh window, so the owner is asked about what
   * they have not seen rather than having it ride in on an answer about
   * something else.
   *
   * A standing permission is not bounded that way and does not need to be: it
   * is not an answer about these bytes at all, it is an answer about this
   * person and this pane.
   */
  decide(params: ParamsOf<'teamwork.decide'>): PaneConsent {
    const request = this.#pending.get(params.requestId)
    // The owner's own call, so it is answered plainly: a request that has
    // expired or been answered from another window is a thing they can see for
    // themselves, and there is no teammate here to be told anything.
    if (!request) throw notFound(`no keystrokes are waiting under id ${params.requestId}`)
    const projectId = request.projectId

    if (params.decision === 'deny') {
      this.#settle(request, request.held.length, 'denied', 'the owner did not allow this')
      this.#options.onChange()
      return this.requests({ projectId })
    }

    if (params.decision !== 'once') {
      this.#grant(request, params.decision)
      // Everything held, because a standing permission is about the person and
      // not about the bytes: there is nothing left for the owner to have not
      // seen once they have said "anything they type here".
      this.#settle(request, request.held.length, 'allowed', undefined)
      this.#options.onChange()
      return this.requests({ projectId })
    }

    this.#settle(request, Math.min(params.through ?? request.held.length, request.held.length), 'allowed', undefined)
    this.#options.onChange()
    return this.requests({ projectId })
  }

  /**
   * Takes back a standing permission.
   *
   * Instant and local, exactly like the mute, and it takes effect on the next
   * keystroke — which, because the check and the pty write are in one task with
   * nothing awaited between them, is every keystroke that has not already been
   * written. The teammate is not told; they find out the way they found out
   * they had permission in the first place, by typing.
   *
   * Answerable before the first reconcile for the same reasons the mute is, and
   * it is the same pairing: `requests` lists a standing permission restored in
   * `start()`, and a permission the owner can see and cannot lift is the one
   * thing that listing is for.
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
    // Whatever a burst is still only counting goes down before the read, so
    // what the owner is shown is never behind what this runtime knows.
    this.#flushEveryUnaimed()
    return this.#log.read(params.limit)
  }

  /**
   * The projects a teammate reached this machine through, if they may use them.
   *
   * Both halves matter and neither is enough alone: the roster is membership,
   * and the project key is what stops a teammate reached over one repository's
   * session reaching into another's. Push access to repository A says nothing
   * about repository B, and `docs/teamwork.md` scopes everything it grants to
   * "within a project" for exactly that reason.
   *
   * PLURAL, because the project key is a hash of the repository and a person
   * may have that repository checked out twice — a main checkout and a review
   * checkout, added as two projects, which is an ordinary thing to do. One
   * repository is one rendezvous and therefore one link, and the snapshot that
   * link carries already holds the panes of both checkouts: `#presenceSource`
   * takes every project with the key. Resolving to only the first of them here
   * is what made half the panes a teammate had been offered answer as panes
   * that do not exist — indistinguishable, deliberately, from a pane id that
   * names nothing, so it could not be diagnosed from either end.
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
   * Whether a teammate may read one of this machine's panes.
   *
   * The same scoping `remoteWrite` puts on typing, which reading did not have:
   * `terminal.read` and `terminal.subscribe` went to the dispatcher with
   * nothing but the id the caller named, so a teammate on one repository's
   * roster could stream a pane belonging to a project they hold no key for.
   * Every legitimate watcher takes the id out of a presence snapshot, which is
   * already scoped to the session's project, so nothing honest is refused by
   * checking.
   *
   * A pane in another project is reported exactly as a pane that does not
   * exist, deliberately: telling the two apart would answer "is there a pane
   * with this id somewhere on your machine", which is a question a teammate has
   * no business being able to ask.
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
      // A pane of *this* project that has since gone is named as closed, and
      // the words are the ones the stream itself ends with. A watcher joins by
      // subscribing and then reading, and an owner who closes the pane between
      // those two is the ordinary case, not a rare one: the subscription ends
      // with `lost: the owner closed this pane` while the read that follows it
      // is refused here. Refusing it with "there is no pane" made that reader's
      // window say the pane had never been theirs to see, which is the one
      // thing it must not say about a pane they were reading a moment ago.
      //
      // Only for a project this peer already holds the key to, and only for a
      // pane it has already been answered for. Everything else keeps the answer
      // below, which is deliberately the same answer a pane of another project
      // gets: telling those apart would answer "is there a pane with this id
      // somewhere on your machine".
      //
      // Asked of every project the peer holds, for the same reason the lookup
      // above is plural: one repository checked out twice is one link over
      // which the panes of both checkouts have been offered, and the memory is
      // filed under whichever of them the pane was actually found in. Narrowing
      // this to the first would give the watchers of the second checkout back
      // the very sentence it exists to remove.
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
   *
   * Every one of those checks is about a pane that can still take input, and
   * `running` is not that question on its own: a pane whose child has been
   * reaped goes on reporting itself as running for as long as its output is
   * still arriving, and refuses a write the whole time. That window is after
   * every exit, which made `written` an entry `writeLog.ts` would have called
   * invented — and an invented entry in an audit trail is worse than a missing
   * one, because it would be believed.
   *
   * AND THE LAST CHECK IS THE OWNER THEMSELVES. Everything above is a question
   * this machine can answer out of its own memory; whether a teammate may run
   * this particular thing in this particular pane is not, unless the owner has
   * already said so. Without a standing permission the answer is neither yes
   * nor no but `held`: the bytes stay here, the caller's request stays open,
   * and the owner is asked. See `#hold`.
   */
  remoteWrite(connectionId: string, write: RemoteWriteRequest): RemoteWriteVerdict {
    return this.#judge(connectionId, write, false)
  }

  /**
   * The judgment itself, with one extra fact: whether the owner has already
   * answered for these bytes.
   *
   * `consented` is true only on the path out of `#decide`, and it skips exactly
   * one step — the asking. Every other check is run again, at the moment the
   * keystroke actually goes to the pty rather than at the moment it arrived, so
   * a pane that exited, a mute applied, or a roster that dropped its sender
   * while the question was on screen all refuse a write the owner had said yes
   * to. Consent is permission to run; it is not a promise that running is still
   * possible.
   */
  #judge(connectionId: string, write: RemoteWriteRequest, consented: boolean): RemoteWriteVerdict {
    const at = this.#scheduler.now()
    const peer = this.#peerByConnection.get(connectionId)
    if (!peer) {
      // Nothing to attribute it to, which is itself the reason to refuse: this
      // is a connection the peer service never opened.
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
      // No roster of this machine's names this key on this repository, so
      // there is no handle to file them under either: whatever some other
      // project calls them is that project's word, not this one's.
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

    // A pane of one of those projects, and one that can still take input.
    // Resolved from this machine's own list rather than from anything the
    // caller named, which is the same scoping `teamwork.watch` puts on reading.
    const found = this.#paneForPeer(projects, write.terminalId)
    if (!found) {
      // Filed under the first of the peer's projects, because there is no pane
      // to say which — and not attributed anywhere, because there is no pane of
      // theirs to attribute it to. A refusal that put their name on a row of a
      // project they never reached would be a private project labelled as one
      // whose history is not the owner's alone.
      //
      // The reason is worded without the id the caller named, for two reasons:
      // it is recorded on the owner's disk, and a refusal that quotes its input
      // is a way to put whatever you like there. It stays the same answer a
      // pane in another project gets, which is the point of saying it this way.
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

    // Named by the roster of the project the pane is actually in, which is the
    // project this keystroke is about — and by this machine's own id for the
    // pane, from this machine's own list, never by the string on the wire.
    const stamp: WriteStamp = {
      at,
      handle: this.#handleIn(found.project, peer.publicKey),
      publicKey: peer.publicKey,
      projectId: found.project.projectId,
      terminalId: found.pane.id,
      known: true
    }
    // `running` alone is not "can take a keystroke": a pane whose child has
    // been reaped stays running for as long as its output is still arriving,
    // and the pty refuses a write throughout. Recording one as `written` would
    // put an invented entry in the owner's evidence.
    if (!found.pane.running || found.pane.draining === true) {
      return this.#refuse(connectionId, stamp, write, 'no-pane', 'that pane’s process has exited', found.project)
    }

    // Before the owner is asked, because a mute is the answer they have already
    // given to this question and asking again would be asking them to give it
    // twice. It stays instant and it stays silent: no prompt, no round trip,
    // and nothing about it that a teammate gets a vote on.
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
      this.#ownHandleIn(peer.projectKey),
      this.#revision
    )
  }

  /**
   * PEER-ONLY. The same snapshot, now and on every change.
   *
   * One per connection, and a second subscribe *replaces* the first rather than
   * displacing it. The map is keyed by connection, so an overwrite used to
   * leave the older subscription registered in the hub with nothing left
   * holding its channel: impossible to tear down, and dead until the link
   * dropped. Closing it here is what makes "one per connection" true of the hub
   * and not just of this map.
   */
  peerSubscribe(connectionId: string, channel: SubscriptionChannel): () => void {
    const snapshot = this.peerPresence(connectionId)
    const previous = this.#subscribers.get(connectionId)
    this.#subscribers.set(connectionId, channel)
    // After the new one is filed, so the teardown the close runs finds it there
    // and leaves it alone.
    previous?.close()
    // Immediately, so there is no separate first read for the stream to race.
    channel.emit(snapshot)
    return () => {
      if (this.#subscribers.get(connectionId) === channel) this.#subscribers.delete(connectionId)
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
          // A question about keystrokes that can no longer be answered to
          // anybody is a question the owner should not be left holding. The
          // bytes are dropped with it, which is the safe direction: a burst
          // that outlived its own link and ran when the link came back would be
          // a command arriving minutes after it was typed.
          for (const request of this.#requestsFor((candidate) => candidate.linkId === linkId)) {
            this.#settle(request, request.held.length, 'expired', `the link to ${want.handle} dropped`)
          }
          // And this is what "for this session" means in the half of the phrase
          // that is not about this runtime. A link going down ends the session
          // it was; the next one asks again.
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
   * Drops a snapshot that is behind the one already held for this link.
   *
   * Only ever reached for a session that has confirmed key possession — the
   * link will not forward a stream event before that — so this is also the one
   * door through which anything becomes live. A cached entry is stale, and
   * what makes it live again is this, not the link coming up.
   */
  #record(linkId: string, publicKey: string, incoming: unknown): void {
    // Only the project this session is for, out of everything the snapshot
    // happens to carry. A peer that named ten project keys it invented would
    // otherwise get ten cache slots for them and push out every real one.
    const projectKey = this.#peerByConnection.get(linkId)?.projectKey
    const presence = parsePeerPresence(incoming, projectKey)
    if (!presence) {
      // Said out loud rather than returned quietly. A snapshot that is not one
      // is either a teammate running something this build does not understand
      // or somebody probing, and both are things an operator wants to know
      // about; silence here is what turned this into a sidebar that froze.
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
   *
   * `intent` is only ever words for the error, and it is a parameter because
   * "cannot be read" and "cannot be typed into" are two different sentences to
   * be told at the moment a link is down.
   *
   * The only one of these reads that still fails for a project teamwork has not
   * read yet, and it is not the same defect the others had. This one is asked
   * to *act* on a named pane of a named teammate, and a project with no facts
   * has no roster to find them on and no link to reach them over: there is no
   * shorter true answer to give, so it refuses. What it owed the caller was the
   * right refusal. "No project with id" sends somebody to check the id they
   * typed, which is correct only in the second branch below; the first is a
   * project on screen whose links come up in a moment, and saying so is the
   * difference between "try again" and "you are holding a stale id".
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
    // `conflict` for a mute because the pane is in a state the owner put it in
    // and a different argument would not help; `not_found` for the rest,
    // because from where the teammate stands there is nothing there to type at.
    const code = outcome === 'muted' ? ErrorCode.Conflict : ErrorCode.NotFound
    return { ok: false, code, message: reason }
  }

  /**
   * Holds a keystroke until the owner says, and gives the caller a promise
   * rather than a verdict.
   *
   * The promise is what makes this safe to build on top of a transport whose
   * verdicts are otherwise synchronous: the write does not reach the dispatcher
   * at all until it settles, so there is no arrangement of events in which
   * bytes reach a pty before the answer. The teammate's own request stays open
   * across the wait — their runtime is more patient for a write than for
   * anything else precisely so that the answer they get is the owner's and not
   * their own stopwatch's. See `PEER_WRITE_TIMEOUT_MS`.
   *
   * Nothing is recorded here. A held keystroke has not happened to the pane,
   * and an audit log that filed it would be filing an event twice: once as
   * "held" and again as whatever it became. The owner's evidence that this is
   * going on is the question itself, which is on their screen.
   *
   * The two bounds are not politeness. Every byte held is this process's memory
   * spent on somebody else's say-so for up to a minute, so a burst that has
   * outgrown what a person could have typed stops being held and starts being
   * refused — with the reason, so a teammate can tell "the owner has not
   * answered" from "the owner said no".
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

    // The handle is re-read from the roster on every keystroke, exactly as the
    // stamp is, so a request that started before somebody's roster entry was
    // renamed is shown under the name the project uses now.
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
   * Answers the front of a held burst, and leaves whatever the owner has not
   * seen still held.
   *
   * Every allowed keystroke goes back through the full judgment on its way out
   * — see `#judge` — so consent is permission and never a bypass: a pane that
   * exited, a mute applied, or a roster that dropped its sender while the
   * question was on screen all refuse a write the owner said yes to, and the
   * teammate is told which. Refusals are recorded here instead, because nothing
   * else will file them: no verdict path ever runs for a keystroke that was
   * never dispatched.
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
      // `conflict` for the same reason a mute gets it: the pane is in a state
      // the owner put it in, and arguing with the machine would not help.
      item.settle({ ok: false, code: ErrorCode.Conflict, message: words })
    }

    request.cancelExpiry()
    this.#pending.delete(request.id)
    const key = consentKeyOf(request.terminalId, request.publicKey)
    if (this.#pendingByPane.get(key) === request.id) this.#pendingByPane.delete(key)
    if (request.held.length === 0) return

    // What the owner was not shown starts again as its own question, with its
    // own id and its own minute. Reusing the answered request's id would let a
    // second click — or a stale window still holding the old id — answer bytes
    // that nobody has looked at.
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
   * Wakes the window for a question rather than for a keystroke.
   *
   * A new request is told at once, because it is a thing on somebody's screen
   * that was not there a moment ago. A request that is merely growing is told
   * at the same pulse a burst of typing is, and once more when it stops — that
   * last one matters, because the count the owner is shown is the count their
   * "allow once" will admit, and a window that was never told would be offering
   * to allow less than is held. Allowing less is the safe direction, and the
   * leftovers ask again; being told is still better than relying on it.
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
   * The attribution and the record, in that order and both before the caller
   * has an answer.
   *
   * The attribution is in memory and cannot fail, which is why it is the thing
   * the owner's guarantee rests on. The log is the durable copy of the same
   * fact and is allowed to be slower.
   *
   * `project` is what separates a keystroke aimed at one of the owner's panes
   * from one aimed at an id its sender made up. The first is a fact about a
   * pane and belongs on that pane's row and in the log. The second is a fact
   * about the sender and nothing else — there is no pane of theirs for it to be
   * about — so it is logged in a form a flood cannot use and never attributed.
   * Both halves of that mattered: `#typists` is bounded by count and evicts the
   * least recently typed, and the log rotates at a byte cap, so a few hundred
   * invented ids used to push out the owner's record of a keystroke that was
   * real, and the audit trail was destroyable by the party it audits.
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
    // Attributed only for a pane this machine has. "Who is typing here" is a
    // statement about the owner's own panes — nothing reads the map under an id
    // that is not one — so filing a made-up id there was a map the far end
    // chose the keys of, and a window woken once per made-up id was a refetch
    // of three collections per keystroke that could never be shown.
    if (stamp.known) this.#attribute(entry)
  }

  /**
   * Files a keystroke that reached no pane of this machine, collapsed.
   *
   * `writeLog.ts` keeps one megabyte and one generation back, which is some ten
   * thousand entries — a bound a runaway agent cannot turn into a full disk,
   * and, while every refusal was filed in full, a bound a sender could reach on
   * purpose. A refusal needs no valid pane and no valid project, so anybody who
   * may open a link could send fifteen thousand of them and roll the owner's
   * record of what they really typed off the end of the file.
   *
   * So the first few of a burst are filed as they are, and the rest become one
   * entry carrying the count. Nothing is hidden — the owner can still see that
   * this link sent thousands of keystrokes at ids that are not theirs, which is
   * the fact worth having — but the flood can no longer outrun what it is
   * trying to bury. Refusals that did reach one of the owner's panes (a mute, a
   * pane that has exited) are not collapsed: they are bounded by the owner's
   * own panes and they are the ones with something to say.
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
    // Fresh is about the *person*, not the pane. Per pane, somebody naming a
    // different one each time was fresh every time, and "fresh" is what skips
    // the pulse the window is otherwise refetched on — so the throttle could be
    // turned off from the other end of a relay by varying an id.
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

    // Bounded, because this is a map keyed by something a long-running app
    // accumulates. A pane nobody's keystroke ever reached goes before one
    // somebody typed into, and within each of those the least recently typed
    // goes first: a record of a keystroke that landed is evidence, and a record
    // of one that did not is a note.
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
   *
   * Bounded by the same argument as `#typists`: a key is a string from a
   * handshake, and a machine left running for a month must not accumulate one
   * of these per person it has ever met. Anything older than the typing window
   * is no longer the answer to any question this map is asked.
   */
  #noteTypedAt(publicKey: string, at: number): void {
    this.#lastTypedAt.set(publicKey, at)
    if (this.#lastTypedAt.size <= MAX_TYPED_PANES) return
    for (const [key, last] of this.#lastTypedAt) {
      if (at - last > TYPING_WINDOW_MS) this.#lastTypedAt.delete(key)
    }
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
      if (pane) {
        this.#remember(projectId, terminalId)
        return pane
      }
    }
    return undefined
  }

  /**
   * Files a pane under the project it was found in, so it can still be named
   * once it is gone.
   *
   * Written here rather than anywhere a pane is created, because this is the
   * one place that has both halves of the fact at once — and because the only
   * ids worth keeping are the ones something has already asked about, which is
   * exactly the set that passes through here.
   */
  #remember(projectId: string, terminalId: string): void {
    const held = this.#panesHeld.get(projectId) ?? new Set<string>()
    this.#panesHeld.set(projectId, held)
    if (held.has(terminalId)) return
    held.add(terminalId)
    // Insertion order, so the id dropped is the one longest since first seen —
    // which for a bound this far above any real pane count is a pane closed
    // long ago, never one somebody is reading now.
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
   * Which project one of this machine's panes is in.
   *
   * Walked over the workspace rather than over the facts, which is a difference
   * of one window and of nothing else: the facts are built from `listProjects`
   * at every reconcile, so once one has run the two walks visit the same
   * projects in the same order and reach the same answer. Before the first one
   * the facts are empty and the workspace is not — and the pane the owner is
   * looking at belongs to a project the store plainly has.
   *
   * That window was a real refusal. `mute` and `revoke` above are the owner's
   * own controls over their own panes, both restored out of a file in `start()`
   * before a single repository is read, and resolving them through the facts
   * meant a restored window could draw a muted pane from `watchers` and then be
   * told there is no such pane on this machine when the owner clicked to lift
   * it. Neither of them wants anything off the repository: `#paneOf` reads the
   * workspace too, so this is the fact both of them were actually after.
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
   * What this machine calls itself to a teammate on one project.
   *
   * Per project for the same reason a teammate's name is, and read at the
   * moment it is sent rather than kept in a field: a session is for one
   * repository, and the handle announced over it is a claim about that
   * repository's roster.
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
   * What ONE PROJECT'S roster files a key under, and nothing else.
   *
   * The whole of `roster.ts` — the exact-case suffix, the canonical stem, the
   * refusal of a second entry for a claimed key — exists so that one handle
   * names one person. That guarantee is per project, because a roster is a
   * directory in a repository: a key can be `mallory` in one and `ana` in
   * another, either because somebody arranged it or, far more ordinarily,
   * because one person's `git config user.email` differs between two checkouts.
   * A lookup that searched every project would call them by whichever roster it
   * happened to read first, which is a name with no repository behind it.
   *
   * Falls back to the key, never to another project's word for them — which is
   * also the whole of what `undefined` facts mean here. A project teamwork has
   * not read yet has no roster to be named by, and that is the same situation
   * as a key the roster it does have does not mention: this machine knows a
   * public key and no name for it, so it says the key.
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
    // Stamped before git is asked, never after: a remote added while the
    // subprocess was running then leaves a mark the next read disagrees with,
    // which costs one re-read rather than losing the change.
    const mark = originMark(project.path)
    const [read, relay, key] = await Promise.all([
      // Kept as a failure rather than flattened into an empty roster.
      // `roster.ts` goes to some lengths to keep a bad *file* local to that
      // file, because there is no answer worse than a wrong empty one: it reads
      // as "nobody", which is a statement about the team rather than about a
      // read. A directory that could not be listed at all is the one place that
      // was swallowed, and it was then described in those very words.
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

    // Ordered from the thing a user fixes first. "No relay" is the ordinary
    // state of a project nobody has set teamwork up on, and saying that before
    // anything else is what stops the row reading as a fault.
    if (!relay.configured) facts.disabledReason = relay.reason
    else if (!key.ok) facts.disabledReason = key.reason
    else if (!read.ok) {
      // Teamwork is still off for this project, which is the safe direction and
      // is unchanged. What changes is the sentence: this says the read failed,
      // not that the team is empty.
      facts.disabledReason = `this project’s roster could not be read: ${read.reason}`
    } else if (roster.entries.length === 0) {
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

/**
 * How many panes of this machine one link may have keystrokes waiting at.
 *
 * A person answering a colleague's agent is typing at one pane, and somebody
 * helping across three worktrees at three. Eight is past anything anybody does
 * and a long way short of a link that has opened a question at every pane on
 * the machine — which would be a way to fill the owner's screen with prompts
 * from the other end of a relay.
 */
export const MAX_PENDING_PER_LINK = 8

/**
 * How much of one burst is held while the owner is asked.
 *
 * A minute of fast typing is some six hundred keystrokes, so a thousand is
 * headroom over anything a person does; the byte cap is what actually bounds
 * it, because a paste is sixty-four kilobytes and four of those waiting is
 * already more than the owner is going to read. Past either, the keystroke is
 * refused with the reason rather than held — memory spent on somebody else's
 * say-so has to stop somewhere, and stopping silently would be the one thing
 * this feature may not do.
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
 * How a permission and a held burst are keyed: one pane, one person.
 *
 * Both halves, always. A key that named only the pane would be "anyone may type
 * here", which is the default this prompt exists to remove; one that named only
 * the person would be "ana may type anywhere", which is a decision nobody was
 * asked for. The separator is a NUL, as it is for the typists, because neither
 * an id nor a base64 key can contain one.
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
 * A verdict that has to be a decision, because it was asked for as one.
 *
 * `#judge` is given `consented` on this path, which is the only thing that can
 * make it hold a write, so the branch below is unreachable. It is written out
 * rather than cast away because the alternative is a keystroke whose promise is
 * never settled, and "unreachable" is a claim about today's control flow rather
 * than a property of the type.
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
  /**
   * Whether `terminalId` is a pane of this machine rather than a string the
   * caller made up. The record keeps both; only the first is attributed, because
   * the owner's "who is typing here" is about panes this machine has.
   */
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
 * How much of a public key a namespaced id carries. Twelve base64 characters is
 * seventy-two bits, which is not an identity — the roster it is matched against
 * is — but is plenty to pick one row out of a team.
 */
const KEY_PREFIX_LENGTH = 12

/**
 * How much of a key stands in for a name when no roster has one. Short enough
 * to read, and never mistakable for a handle somebody chose.
 */
const SHORT_KEY_LENGTH = 8

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
 *
 * Both keys whole. This id is the map key *and* the connection id, so two links
 * that shared one would displace each other silently — a teammate's session
 * answering under somebody else's name. Truncating bought nothing that carrying
 * the whole of each key does not, and the whole of each key costs nothing.
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

/**
 * How a pane id that is not this machine's is written down.
 *
 * Never the caller's own string. An id that names nothing here is a value from
 * the wire, and the record it goes into is the owner's evidence, kept on the
 * owner's disk, rotated at a size — so a verbatim copy of it is somebody else
 * choosing what that file contains and how much of it fits. A digest is a fixed
 * twenty-two characters, says nothing the caller did not already know, and
 * still tells the owner that the same made-up id came back a hundred times.
 *
 * Short on purpose: this is a label for a thing that does not exist, not a
 * cryptographic commitment to anything.
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

/**
 * How the live record of who typed is keyed.
 *
 * The project as well as the pane, because a pane id is a string a teammate can
 * name and the owner's question is about one project's panes at a time.
 */
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
 * How long one link's keystrokes at ids it invented are gathered before the
 * count starts again, and how many of them are filed in full before they are
 * only counted.
 *
 * A minute and twenty, so an honest teammate whose pane closed under them is
 * never collapsed at all, and a flood costs the log one entry a minute.
 */
export const UNAIMED_BURST_MS = 60_000
export const UNAIMED_LOGGED_PER_BURST = 20

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A snapshot from a teammate's runtime, as it arrived.
 *
 * The same shape `src/shared/entities.ts` declares, written out again as a
 * schema because a type is a claim about this process's own data and these
 * bytes are somebody else's. Zod because that is what this codebase already
 * validates a boundary with — `Params` for the method boundary, the schemas in
 * `store/teammateCache.ts` for the file one, and this for the wire.
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
 * Whether a snapshot is one at all, and how much of it is kept.
 *
 * Two jobs and both belong here. **Refusing** is the first: a two-field check
 * let `{revision, projects: [null]}` through, and the lookup that then threw
 * did so inside the delivery path, leaving the entry poisoned and every later
 * `teamwork.presence` for that project throwing for as long as the link stayed
 * up — a sidebar frozen on stale data with nothing anywhere saying why.
 *
 * **Bounding** is the second, and it is the same argument
 * `store/teammateCache.ts` makes about the file: every byte here came off
 * another machine, so the counts and the lengths are this process's to decide
 * and not the sender's. The numbers are that file's, deliberately, because a
 * snapshot kept in memory and the copy of it written to disk being bounded
 * differently would mean one of the two numbers was wrong.
 *
 * Narrowed to `onlyProjectKey` on the way through: a session is for one
 * repository, so a peer that names ten it invented gets none of them kept.
 */
export function parsePeerPresence(value: unknown, onlyProjectKey: string | undefined): PeerPresence | undefined {
  const parsed = PresencePayload.safeParse(value)
  if (!parsed.success) return undefined
  const project = parsed.data.projects.find((candidate) => candidate.projectKey === onlyProjectKey)
  return {
    revision: parsed.data.revision,
    handle: parsed.data.handle ?? null,
    // `AGENT_KINDS` is an array rather than a tuple, so `z.enum` over it widens
    // the agent to `string` and the cast puts it back. The same cast is in
    // `store/teammateCache.ts` for the same reason.
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
