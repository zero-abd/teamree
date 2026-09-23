// Core domain entities. Every process agrees on these shapes: the runtime owns
// them, the renderer and the CLI only ever read or request changes to them.

/** A tracked git repository. One project owns many worktrees. */
export type Project = {
  id: string
  name: string
  /** Absolute path to the primary checkout. */
  path: string
  /** Ref new worktrees branch from unless overridden, e.g. "origin/main". */
  baseRef: string
  /**
   * Gitignored directories in the primary checkout — `node_modules`, `.venv`,
   * `.cache` — symlinked into every new worktree.
   *
   * Symlinked and never copied: they are large and rebuildable, and every
   * worktree of one repository wants the same one.
   *
   * Optional because a project nobody has configured has not said "none"; it
   * has said nothing, which is what an absent field means everywhere else in
   * the records this app stores.
   */
  linkedPaths?: string[]
  /**
   * Gitignored files in the primary checkout — `.env`, `.env.local` — copied
   * into every new worktree.
   *
   * Copied rather than linked for the reason the list above is linked: these
   * are small, and a task that changes one must not change the primary
   * checkout's copy underneath everybody else.
   */
  copiedPaths?: string[]
}

export type WorktreeState =
  | 'creating'
  | 'ready'
  | 'removing'
  /** Creation failed; `error` carries the reason and the row offers a retry. */
  | 'failed'

/** One task's isolated checkout. */
export type Worktree = {
  id: string
  projectId: string
  /** Human-facing task name; also seeds the branch name. */
  name: string
  branch: string
  /** Absolute path to this worktree's checkout. */
  path: string
  /** What this branched from: a ref name or a commit sha. */
  startedFrom: string
  state: WorktreeState
  error?: string
  createdAt: number
}

/** Live git state for a worktree, refreshed independently of the row itself. */
export type WorktreeStatus = {
  worktreeId: string
  branch: string
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
  /**
   * Entries a .gitignore covers, a wholly ignored directory counting as one.
   *
   * Not a change, and deliberately not added to any of the counts above — but
   * removing the checkout deletes them, and git's own idea of "dirty" leaves
   * them out, so this is the only warning there is. Optional because an answer
   * that was never given is not the same as a count of zero.
   */
  ignored?: number
  /** Wall-clock time of the read, so stale reads are visible to the UI. */
  readAt: number
}

/** What git says happened to one path in a worktree. */
export type WorktreeChangeKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typeChanged'
  | 'untracked'
  | 'conflicted'

/**
 * One changed path. `staged` and `unstaged` are not exclusive: a file edited
 * after it was added is both, and a row that hid one of them would be lying
 * about what a commit would capture.
 */
export type WorktreeChange = {
  path: string
  kind: WorktreeChangeKind
  staged: boolean
  unstaged: boolean
  /** Where a rename or copy came from. Absent otherwise. */
  from?: string
}

/** Every changed path in a worktree, as of one read. */
export type WorktreeChanges = {
  worktreeId: string
  changes: WorktreeChange[]
  /** Paths found, which may exceed what `changes` carries. */
  total: number
  limit: number
  truncated: boolean
  readAt: number
}

/** A unified diff for a worktree, or for one path in it. */
export type WorktreeDiff = {
  worktreeId: string
  /** The single path this covers, absent when it covers the whole worktree. */
  path?: string
  /** True when the patch is of the index rather than the working tree. */
  staged: boolean
  patch: string
  /** True when the patch was cut short at the byte ceiling. */
  truncated: boolean
  readAt: number
}

/**
 * Whether a worktree's branch would merge into its project's base ref.
 *
 * Answered without checking anything out, so it costs nothing to ask about
 * every worktree at once — which is the point when several of them are attempts
 * at the same task.
 */
export type WorktreeMergePreview = {
  worktreeId: string
  /** What it was compared against. */
  baseRef: string
  /**
   * `nothingToMerge`, `clean` and `conflicts` are answers. `unrelated` and
   * `unavailable` are refusals to guess, and carry a `reason` — because
   * "nothing conflicts" and "could not tell" look the same to a caller and mean
   * opposite things.
   *
   * `nothingToMerge` is deliberately not called "merged". A branch whose
   * commits are all in the base and a branch that never made any are the same
   * fact to git, and claiming the first when it might be the second would have
   * someone delete a worktree they had not finished with.
   */
  state: 'nothingToMerge' | 'clean' | 'conflicts' | 'unrelated' | 'unavailable'
  /** Commits this branch has that the base does not. */
  ahead: number
  /** Paths that would conflict, for `conflicts`. Empty otherwise. */
  conflicts: string[]
  reason?: string
  readAt: number
}

/** A commit this app made, reported back so the caller can see what landed. */
export type WorktreeCommit = {
  worktreeId: string
  sha: string
  shortSha: string
  message: string
  /**
   * What the commit actually captured, which is not always what was asked for:
   * a path staged earlier goes in too, and saying so is the difference between
   * a report and a guess.
   */
  paths: string[]
  committedAt: number
}

/** The outcome of pushing a worktree's branch, as it actually went. */
export type WorktreePush = {
  worktreeId: string
  remote: string
  branch: string
  /** True when the remote already had every commit; nothing was sent. */
  alreadyUpToDate: boolean
  /** What the branch tracks now. */
  upstream: string
  /** True when this push is what set that tracking. */
  setUpstream: boolean
  /**
   * Changes left behind in the worktree. Pushing while still editing is
   * ordinary, but it means what landed is not what is on screen.
   */
  uncommitted: number
  pushedAt: number
}

/** One commit a worktree made. */
export type WorktreeCommitSummary = {
  sha: string
  shortSha: string
  author: string
  /** ISO 8601 as git wrote it, offset and all. */
  committedAt: string
  subject: string
}

/**
 * What a worktree has done that its base has not, newest first.
 *
 * Scoped to `base..branch`: the question is what this worktree produced, and
 * everything before the fork belongs to everyone.
 */
export type WorktreeLog = {
  worktreeId: string
  baseRef: string
  commits: WorktreeCommitSummary[]
  truncated: boolean
  /**
   * Why the branch could not be compared against its base, when it could not:
   * an unfetched clone, a base deleted on the remote, a repository with no
   * commits at all. Absent when the log was read — and an empty `commits` list
   * then means this branch has made none, which is a different thing to put in
   * front of somebody than not knowing either way.
   */
  unavailable?: string
  readAt: number
}

export type Terminal = {
  id: string
  worktreeId: string
  title: string
  cwd: string
  shell: string
  cols: number
  rows: number
  /** False once the child process has exited; the pane stays until closed. */
  running: boolean
  /**
   * True between the child being reaped and the last of its output arriving.
   *
   * `running` is still true across that window — the pane is still filling, and
   * the exit is not announced until the scrollback is complete — but there is
   * nothing on the other end to read a keystroke and the pty refuses one.
   * Anything deciding whether input can still land has to ask this too, or it
   * concludes "running, therefore typeable" for the half-second after every
   * exit and says so in writing.
   */
  draining?: boolean
  exitCode?: number
  /** Which coding agent this pane runs, when it runs one. */
  agent?: AgentKind
  /**
   * What this pane is called, when somebody has said.
   *
   * Three agents on three approaches all introduce themselves as `claude`, so
   * a name taken from the program answers "which of these is the auth
   * refactor" with the one fact the three panes have in common. This is the
   * other name: the task the pane was started for, or whatever it was renamed
   * to. Nothing derives it, which is why it outranks everything that is
   * derived.
   */
  label?: string
  /**
   * True while output is still arriving. It is the only honest signal this app
   * has about whether an agent is working: without a hook into the agent's own
   * protocol, a quiet terminal is a terminal that has stopped saying things,
   * which is what "waiting for you" looks like from the outside.
   */
  busy: boolean
  /** When output last arrived, for "no update for 4m". */
  lastOutputAt: number
  /**
   * How this terminal came back from a previous run, when it did. `agent` means
   * a conversation was resumed; `shell` means the pane and its directory came
   * back but whatever was running did not. Absent for a terminal opened now.
   *
   * It clears the moment the user types into the pane: by then they know what
   * they are looking at, and a badge that never leaves is noise.
   */
  restored?: 'shell' | 'agent'
}

/**
 * Pane layout for one worktree. A leaf holds a terminal; a split divides its
 * area between two or more children. Sizes are fractions summing to 1 and are
 * positionally matched to `children`.
 */
export type PaneNode =
  | { kind: 'leaf'; terminalId: string }
  | { kind: 'split'; direction: 'row' | 'column'; sizes: number[]; children: PaneNode[] }

export type Layout = {
  worktreeId: string
  root: PaneNode | null
  /** Terminal that receives keyboard focus when this worktree is opened. */
  focusedTerminalId: string | null
}

/** One thing a new worktree can branch from, as offered by the create dialog. */
export type StartPoint = {
  /** What to pass back as `startedFrom`, e.g. "origin/main" or a sha. */
  ref: string
  kind: 'localBranch' | 'remoteBranch' | 'tag' | 'commit' | 'head'
  sha: string
  shortSha: string
  /** Bare name without the refs/ prefix, absent for a raw commit. */
  refName?: string
  /** True for the project's configured base ref. */
  isBase: boolean
  /** True for the branch the primary checkout currently has out. */
  isCurrent: boolean
  updatedAt: number
}

export type StartPointList = {
  baseRef: string
  options: StartPoint[]
  /** Total refs found, which may exceed what `options` carries. */
  total: number
  limit: number
  /** True when `total` exceeded `limit` and a tail was dropped. */
  truncated: boolean
}

/**
 * The coding agents this app knows how to start and resume.
 *
 * Lives here rather than beside the launch logic because it crosses the wire:
 * the CLI prints it, the GUI keys buttons off it, and a bare `string` in its
 * place is the one field in this file a caller cannot exhaust.
 */
export type AgentKind = 'claude' | 'codex' | 'gemini' | 'opencode' | 'droid'

/** A coding agent this machine can run, found on PATH rather than configured. */
export type InstalledAgent = {
  kind: AgentKind
  /** What to run. */
  command: string
  /** Where it was found. */
  binary: string
}

/**
 * Who this installation is, as the roster records it.
 *
 * The public key is the identity; the handle is only what it is filed and
 * displayed under. There is no account behind either — push access to the
 * repository is what makes a key membership.
 */
export type MemberIdentity = {
  /**
   * Filename stem under `.teamree/members`, and how the app names this person.
   *
   * Null when none could be worked out and none was given, because git has no
   * configured email to take one from. The key is still this machine's; only
   * its name is missing, and the user is asked for one.
   */
  handle: string | null
  /** Base64 of the 32-byte X25519 public key. The private half never leaves the machine. */
  publicKey: string
}

/** One member of a project: a public key committed to the repository. */
export type Member = {
  handle: string
  publicKey: string
  /** ISO 8601 date the key was added, exactly as the file records it. */
  addedAt: string
  /** Path relative to the project root, so the file can be found in a diff. */
  file: string
  /** True when this entry is this installation's own key. */
  isSelf: boolean
}

/**
 * A file under `.teamree/members` that could not be read as a member.
 *
 * Reported rather than thrown. One unreadable file is somebody's typo, and a
 * roster that refused to list nine good members because of it would read as
 * "there is no team here", which is the one thing it must never wrongly say.
 */
export type MemberProblem = {
  /** Path relative to the project root. */
  file: string
  /** What is wrong with it, in words somebody can act on. */
  reason: string
}

/** A project's roster, as of one read. */
export type MemberList = {
  projectId: string
  /** Sorted by handle, so two reads of one team compare cleanly. */
  members: Member[]
  problems: MemberProblem[]
  /** Who this installation is, whether or not it is in `members` yet. */
  self: MemberIdentity
  /**
   * Where joining would write, relative to the project root. Null when no
   * handle could be worked out, because then there is no filename to name.
   */
  selfFile: string | null
  /**
   * True when this installation's public key is in the roster. Keyed on the
   * key rather than the handle: the key is the identity, and somebody who
   * renamed their file is still the same person.
   */
  enrolled: boolean
  /**
   * Whether a key that arrives by `git pull` is noticed on its own.
   *
   * True is the ordinary state: `.teamree` is watched, and a roster that
   * changed on disk reaches the window without anybody asking. False is not a
   * fault and must not be shown as one — it means this list is only as fresh as
   * this read, which is a different sentence and has to stay one.
   */
  watched: boolean
  readAt: number
}

/**
 * What an unwatched `.teamree` actually costs, in the one sentence both sides
 * say.
 *
 * The runtime reports it when a watch cannot be attached and the window says it
 * beside a roster that is `watched: false`. It is shared because the two used
 * to disagree: the panel told people to reopen it after a pull, which described
 * a version of this app that existed before the sweep did. A lost watch is not
 * a lost roster — it is a roster that catches up on a timer.
 */
export const UNWATCHED_TEAMREE_LAG =
  'A teammate’s key or a relay arriving by git pull will be noticed by the periodic check rather than at once, so ' +
  'the roster can be up to half a minute behind the last pull.'

/**
 * Where a project's relay is recorded, and what each of the two places said.
 *
 * Both halves are reported whatever is in effect, because the two questions a
 * surprised person actually has are "which URL is this app using" and "why is
 * it not the one I set". The environment override is named even when it is not
 * set at all: an app launched from Finder inherits no shell environment, so
 * "teamree saw no override" is the answer to a question that is otherwise
 * unanswerable from inside the app.
 */
export type RelaySetting = {
  projectId: string
  /** Path relative to the project root, as a diff would show it. */
  file: string
  /** The URL teamwork would dial, or null when there is none to dial. */
  url: string | null
  /** Which of the two places the URL in effect came from. Null when neither did. */
  source: 'repository' | 'environment' | null
  /** Why there is no URL in effect, in words to act on. Null when there is one. */
  problem: string | null
  /** What the file in this checkout says, read even when the environment is winning. */
  onDisk: { url: string | null; problem: string | null }
  /** The per-machine override, as this process sees it. */
  override: {
    /** The variable's name, so a message can say it rather than imply it. */
    name: string
    /** Null when this process has no such variable — which is what Finder does. */
    value: string | null
  }
  /**
   * The one command that stands a relay up, as *this* installation can run it.
   *
   * Reported rather than written into the panel, because the answer is
   * different in a checkout and in an installed app and a panel that guessed
   * would print a path that is not there. `command` is null when this build
   * carries no relay at all, and `reason` then says so in one sentence — which
   * is what lets the button be disabled honestly instead of failing when it is
   * pressed.
   */
  deploy: { command: string; reason: null } | { command: null; reason: string }
  readAt: number
}

/**
 * What one commit would carry, said before it is made.
 *
 * This is the whole of the confirmation the push button owes somebody: the
 * files, the message, the remote and the branch. It is read from the runtime
 * rather than assembled in the window, because the branch and the upstream are
 * git's answers and a panel that guessed them would be describing a push it is
 * not about to make.
 */
export type TeamworkPublishPlan = {
  projectId: string
  /** Paths relative to the project root, exactly as they will be staged. */
  files: string[]
  message: string
  remote: string
  /** Null when HEAD is detached, which `blocker` then explains. */
  branch: string | null
  /** What the branch tracks now; null when this push would be what sets it. */
  upstream: string | null
  /** Whether the files are already committed, so the push would send nothing new. */
  committed: boolean
  /** Why this cannot be done at all, in words to act on. Null when it can. */
  blocker: string | null
  readAt: number
}

/**
 * What the one button actually did, in the two halves it can half-fail in.
 *
 * A commit that landed and a push that was refused is the ordinary outcome of a
 * teammate having pushed first, and reporting it as one failure would leave
 * somebody believing they had made no commit. So the commit is reported either
 * way and the push carries its own verdict.
 */
export type TeamworkPublish = {
  projectId: string
  files: string[]
  /** Null when everything was already committed and this made no new commit. */
  commit: { sha: string; shortSha: string; message: string } | null
  remote: string
  branch: string
  push:
    | { ok: true; upstream: string; setUpstream: boolean; alreadyUpToDate: boolean }
    /**
     * `error` is git's own words, whole; `advice` is the one thing to do next;
     * `kind` is the shape of the refusal, for a panel that has to decide
     * whether offering "try again" would be help or an invitation to sit
     * through the same failure twice.
     */
    | { ok: false; kind: PushFailureKind; error: string; advice: string }
  at: number
}

/**
 * Why a push did not land, as a thing to branch on rather than to read.
 *
 * `rejected` is a teammate having pushed first, which is the ordinary one and
 * the one retrying fixes once you have pulled. `auth` and `host-key` are this
 * machine not being allowed or not being willing, and no amount of retrying
 * touches either. `cancelled` and `timeout` are not git's verdicts at all —
 * they are teamree's, and a person who pressed Stop must not be told the remote
 * refused them.
 */
export type PushFailureKind = 'rejected' | 'auth' | 'host-key' | 'cancelled' | 'timeout' | 'other'

/** What a publish is doing right now. `finished` covers success and failure alike. */
export type TeamworkPublishPhase = 'staging' | 'committing' | 'pushing' | 'finished'

/**
 * A publish while it is happening, which is the half this flow used not to have.
 *
 * The button said "Pushing…" and then nothing moved, for up to ten minutes, and
 * from the outside a push waiting on a credential, a push copying objects and a
 * push that will never return look exactly alike. Everything here exists to
 * tell those three apart from the window: the phase says which of the three
 * commands is running, `output` is what git has actually printed, `startedAt`
 * makes the wait measurable rather than felt, and `lastOutputAt` is what lets a
 * panel say "nothing for forty seconds" — which is the sentence that means
 * "this is probably waiting for something it cannot ask you for".
 */
export type TeamworkPublishProgress = {
  projectId: string
  phase: TeamworkPublishPhase
  startedAt: number
  /** When git last printed anything. Equal to `startedAt` until it has. */
  lastOutputAt: number
  /** Null while it is still running. */
  finishedAt: number | null
  /** The last lines git printed, oldest first. Progress meters included. */
  output: string[]
  /** True once somebody has asked for this to stop and it has not stopped yet. */
  cancelling: boolean
  readAt: number
}

/** What adding the `origin` remote did, as it actually went. */
export type TeamworkOrigin = {
  projectId: string
  remote: string
  /** What git was given: a URL as typed, or a path in its normalised spelling. */
  url: string
  /** True when a remote was already there and this replaced its URL. */
  replaced: boolean
}

export type RuntimeStatus = {
  version: string
  /** Socket path or named pipe the runtime is listening on. */
  endpoint: string
  pid: number
  platform: NodeJS.Platform
  startedAt: number
}

/**
 * One pane on a teammate's machine, as their runtime reports it.
 *
 * Deliberately not a `Terminal`. A `Terminal` carries a cwd, a shell, a column
 * count and a scrollback position, none of which mean anything on a machine
 * that is not the one the process is on. What crosses is what the sidebar
 * reads, and nothing else.
 */
export type PeerPane = {
  /** The owner's id for it. Namespaced by the receiver before it is stored. */
  id: string
  /**
   * The pane's own title and the shell behind it — the two raw facts a name is
   * made from, rather than the name itself. The reader already owns the rule
   * that turns them into a label, and sending the label instead would be a
   * second copy of that rule, on the other machine, free to disagree.
   */
  title: string
  shell: string
  agent?: AgentKind
  running: boolean
  exitCode?: number
  busy: boolean
  /**
   * The size of the owner's pty, so a watcher can letterbox to it.
   *
   * Optional because a peer that has not been rebuilt sends none, and a watcher
   * that guessed 80x24 at one would draw a frame the output does not fit. The
   * numbers are the owner's and are never negotiated: `docs/teamwork.md` is
   * explicit that a reader letterboxes rather than resizing a pty under a
   * program that is only being read.
   */
  cols?: number
  rows?: number
  /**
   * Silence as a duration measured by the owner, never as an instant.
   *
   * Two machines do not agree about what time it is, and a `lastOutputAt` from
   * a clock three minutes fast renders as a pane that last spoke in the future.
   * A duration is true wherever it is read; the receiver adds the time since it
   * arrived, which is a number it is entitled to.
   */
  quietForMs: number
}

/** One of a teammate's worktrees, with the panes inside it. */
export type PeerWorktree = {
  id: string
  name: string
  branch: string
  state: WorktreeState
  panes: PeerPane[]
}

/**
 * A teammate's worktrees in one repository.
 *
 * The repository is named by a hash rather than by its remote, because a peer
 * session is pairwise and covers every repository the two of them happen to
 * share: sending remotes in the clear would tell a teammate the URLs of
 * repositories they are not a member of.
 */
export type PeerProject = {
  projectKey: string
  worktrees: PeerWorktree[]
}

/** Everything one runtime tells a teammate about itself. Metadata only. */
export type PeerPresence = {
  /**
   * Monotonic per sender. A snapshot that arrives behind one already applied is
   * dropped: over a link with real latency two reads can overtake each other,
   * and the older one landing last would freeze the sidebar in a past the
   * sender has already left.
   */
  revision: number
  /** The handle the sender's own roster files their key under. Display only. */
  handle: string | null
  projects: PeerProject[]
}

/**
 * How a link to one teammate is going, in the words the window shows.
 *
 * `waiting`, `refused` and `unreachable` are three different facts and the UI
 * says which: "their machine is not connected", "somebody answered and was not
 * who they should be", and "the relay could not be reached" are the kind of
 * distinction this codebase keeps rather than collapsing into "offline".
 */
export type PeerLinkPhase =
  /** Reaching the relay. */
  | 'connecting'
  /** Parked on the relay; the teammate's machine has not arrived. */
  | 'waiting'
  /** Handshake complete against a key from this project's roster. */
  | 'connected'
  /** A handshake that did not complete. Which end it failed on is not established. */
  | 'refused'
  /** The relay could not be reached at all. */
  | 'unreachable'
  /**
   * Stopped dialling: something reconnecting cannot fix, and `detail` says what.
   *
   * Not "never again". Everything that lands here is a fact about the relay,
   * and a relay is restarted, rolled back and upgraded without this app hearing
   * about it, so the link looks once more after a long wait — see
   * `STOPPED_RETRY_MS`. What it is not is a link that keeps trying.
   */
  | 'stopped'

/** One teammate, and how this machine is getting on with reaching them. */
export type PeerLink = {
  /** Their public key, which is the identity. */
  publicKey: string
  /** What the roster files that key under. */
  handle: string
  phase: PeerLinkPhase
  /** Why, in words, whenever the phase is not `connected`. */
  detail?: string
  /** When the phase last changed, by this machine's clock. */
  since: number
  /**
   * When something from them last decrypted, by this machine's clock — and
   * only once that was long enough ago to mean anything.
   *
   * `since` cannot answer this. It is when the *phase* moved, so a link
   * established three hours ago and silent for four minutes carries the same
   * `since` as one that is fine, and `connected` on its own asserts health for
   * the whole of the window before the silence deadline ends it.
   *
   * Absent while the link is talking, and absent while it is down. A healthy
   * link gives the window nothing new to say; a link that is not up has a
   * `detail` that already says what happened to it, and an age beside that
   * would be a second, competing account of the same silence. The link decides
   * when the number is worth carrying, so there is one threshold rather than
   * one here and another wherever it is drawn.
   */
  lastHeardAt?: number
  /** How many times this link has been built, so a flapping one is visible. */
  attempts: number
}

/**
 * Whether teamwork is running for one project, and how, once that has been read.
 *
 * `disabledReason` is the honest half: a project with no relay, no origin
 * remote or no roster is not "offline", it is not configured, and a row that
 * said "offline" would have somebody looking at their network.
 */
export type TeamworkRead = {
  /** Everything below was established by a reconcile, rather than assumed. */
  state: 'read'
  projectId: string
  /** Where the relay is and which of the two places said so. Null when neither did. */
  relay: { url: string; source: 'repository' | 'environment' } | null
  /** Why teamwork is not running here, or null when it is. */
  disabledReason: string | null
  /**
   * Whether this checkout has an `origin` teamree can match against a
   * teammate's, and why not when it has not.
   *
   * Reported beside `disabledReason` rather than folded into it because the two
   * answer different questions. `disabledReason` names the first thing to fix,
   * and for a project with neither a relay nor an origin that is the relay — so
   * a setup flow reading only that would offer a relay field for a checkout
   * where no relay can ever help, and never say why.
   */
  origin: /**
   * `url` is the origin as it is to be named, so anything that has to *name*
   * the repository — an invitation to send a teammate, most of all — can say
   * the URL they are being asked to clone rather than describing it. For a
   * repository shared over a path it is the normalised path, which is the
   * string their checkout has to match character for character.
   */
  { ok: true; url: string } | { ok: false; reason: string }
  /**
   * Whether this machine's own key is on the roster this checkout holds.
   *
   * False is the one cause of silence that is entirely this end's: every link
   * below dials a rendezvous the teammate's machine has no key to compute, so
   * they all wait forever and every phrase about them points at somebody
   * else's laptop. The roster read that fills in `links` already knows this.
   */
  enrolled: boolean
  links: PeerLink[]
  readAt: number
}

/**
 * A project this machine has and teamwork has not read yet.
 *
 * The window is small and entirely real. Adding a project writes it to the
 * store and emits an event; the reconcile that reads its `.teamree`, its
 * `origin` and its roster runs off the back of that event, afterwards and
 * asynchronously. Between the two there is a project with an id, a name and a
 * path about which teamwork knows nothing whatever — and the same is true of
 * every project in a restored session until the peer service has finished
 * starting.
 *
 * This is its own answer rather than a row of nulls, because a row of nulls
 * would be a different claim. `relay: null` with `disabledReason: 'no relay'`
 * says somebody has to go and set one up; `enrolled: false` says this machine's
 * key was never pushed, and sends them to the roster. Both are findings, and
 * nothing has been found here yet. The one true sentence about this project is
 * that nothing has been read about it, and every reader below says exactly that
 * for the moment it lasts, rather than naming a fault nobody established.
 *
 * It is not an error either. A project that exists is not "no such project",
 * and answering that to a caller which handles its errors would have the caller
 * reporting a project gone while it sits in the sidebar.
 *
 * One type for every read that has this state to report, rather than one per
 * method. `TeamworkStatus` and `TeammatePresence` are two questions about the
 * same reconcile, so "nothing has been read about this project" is one fact,
 * and spelling it twice would let the two drift into two different sentences
 * about one moment.
 */
export type TeamworkUnread = {
  state: 'unread'
  projectId: string
  /** When this answer was given, which is the whole of what it asserts. */
  readAt: number
}

/**
 * Whether teamwork is running for one project — or whether even that is known.
 *
 * A union rather than one shape with softer fields, because a reader that
 * cannot tell the two apart writes the wrong sentence for one of them, and the
 * wrong sentence here is this app describing a fault nobody has established.
 */
export type TeamworkStatus = TeamworkRead | TeamworkUnread

/**
 * What was found, or nothing at all while teamwork has not read this project.
 *
 * For the readers that only ever wanted a finding — the origin field in the
 * setup panel, the empty state asking whether teamwork is already running here
 * — which would otherwise repeat the same narrowing at every field they touch.
 *
 * `undefined` is deliberately the same answer it gives for a project nobody has
 * asked about yet, because those two readers treat them the same way and say
 * nothing in either case. Anything that has a sentence to write about the wait
 * itself — the sidebar header, the setup panel's last step, `teamree team
 * status` — reads `state` instead and says which of the two this is.
 */
export function teamworkFacts(status: TeamworkStatus | undefined): TeamworkRead | undefined {
  return status?.state === 'read' ? status : undefined
}

/** One of a teammate's worktrees, with whose it is attached to it. */
export type TeammateWorktree = PeerWorktree & {
  handle: string
  publicKey: string
  /**
   * When the snapshot this row came out of arrived, by this machine's clock.
   *
   * The age of the picture, and deliberately not the age of the silence. Every
   * pane's quiet time on this row is the owner's own measurement plus whatever
   * has elapsed since, so a stamp that moved on contact rather than on content
   * would make an hour-old pane claim to have gone quiet seconds ago.
   */
  heardAt: number
  /**
   * Whether the link this came over is confirmed and connected right now.
   *
   * False is a row out of the local cache: a true picture of what that teammate
   * was showing when their machine was last reachable, and not a statement
   * about what it is showing now. Nothing may be done to a pane on a row that
   * is not live — the peer is not there to do it to.
   */
  live: boolean
}

/**
 * One teammate on the roster, and whether there is any picture of them at all.
 *
 * "Their machine is away" and "nothing has ever been heard from them" are
 * different facts and read differently: the first has rows behind it, and the
 * second is a colleague whose app has never been up while yours was.
 */
export type TeammateStanding = {
  handle: string
  publicKey: string
  /** Their link is connected and has confirmed key possession. */
  connected: boolean
  /**
   * When their picture was last taken, by this machine's clock, or null if one
   * never has been.
   *
   * The age of the snapshot, not of the contact: it moves when a *changed*
   * snapshot arrives, so a teammate whose worktrees have been static for an
   * hour has an hour-old one while their machine is connected and fine. Null
   * versus a number is the fact this carries — a colleague whose app has never
   * been up while yours was is not a colleague with no worktrees — and the
   * number itself is the age of what is shown. How long since anything at all
   * was heard is the link's business, and `PeerLink.lastHeardAt` is where it
   * is kept.
   */
  heardAt: number | null
}

/**
 * One person reading one of this machine's panes, right now.
 *
 * The whole argument in `docs/teamwork.md` for why "anyone can type" is
 * survivable is that nothing can be done invisibly, and watching is the first
 * half of that. So this is not decoration: it is the half of the bargain the
 * owner is owed, and it is live rather than a log.
 */
export type PaneWatcher = {
  /** What the roster files their key under. */
  handle: string
  /** Their public key, which is the identity the handshake authenticated. */
  publicKey: string
  /** When they started watching, by this machine's clock. */
  since: number
}

/**
 * One person who has typed into one of this machine's panes.
 *
 * The other half of the same bargain, and the half that matters more: a
 * teammate's keystroke runs as the owner, so the owner is told whose it was
 * while it happens rather than afterwards. `at` is what makes that live — a
 * reader compares it with the clock and says "is typing" or "typed", and never
 * claims somebody is at the keyboard because they once were.
 *
 * The counters cover the whole time this runtime has been up, so a pane that
 * has been typed into says so even when nobody is typing now. `refused` sits
 * beside `writes` deliberately: somebody still typing at a muted pane is a fact
 * the owner wants, and it is one that would vanish if only what landed counted.
 */
/**
 * How long after a keystroke somebody is still "typing".
 *
 * Here rather than in either half, because the runtime decides when to say a
 * burst has ended and the window decides whether to draw one, and two numbers
 * would eventually disagree about whether anybody is at the keyboard.
 *
 * A second and a half: long enough to survive somebody thinking mid-command,
 * short enough that "ana is typing" goes away while she is still in the room.
 */
export const TYPING_WINDOW_MS = 1_500

export type PaneTypist = {
  /** What the roster files their key under. */
  handle: string
  /** Their public key, which is the identity the handshake authenticated. */
  publicKey: string
  /** Their first keystroke into this pane, by this machine's clock. */
  since: number
  /** Their most recent one, which is what makes "is typing" a live answer. */
  at: number
  /** Keystrokes that reached the pane. */
  writes: number
  /** Bytes that reached the pane. Never the bytes themselves. */
  bytes: number
  /** Keystrokes this machine refused: a mute, a pane that had gone, a roster. */
  refused: number
}

/** One of this machine's panes, and what everyone else is doing to it. */
export type WatchedPane = {
  terminalId: string
  /** Sorted by handle, so two reads compare cleanly. */
  watchers: PaneWatcher[]
  /** Sorted by handle, for the same reason. */
  typists: PaneTypist[]
  /**
   * The owner has stopped remote keystrokes reaching this pane.
   *
   * Reported even when nobody is reading or typing, because a mute the owner
   * cannot see is a mute they cannot lift — and because `docs/teamwork.md` is
   * explicit that a muted pane still exists. Mute stops the bytes; it does not
   * hide the worktree.
   */
  muted: boolean
}

/**
 * Every pane of this machine somebody is reading, has typed into, or muted.
 *
 * One shape rather than the `read`/`unread` union `TeamworkStatus` and
 * `TeammatePresence` carry, and deliberately so: every fact here is this
 * machine's own, and none of it waits on a reconcile. A watcher and a typist
 * both arrive over a link, and a link exists only for a project teamwork has
 * already read — so for a project it has not, "nobody is reading and nobody has
 * typed" is not an assumption, it is the only thing that can be true. The mutes
 * are stronger still: they are restored from the owner's own decisions before
 * the first reconcile runs, so this answers with them at a moment a roster read
 * would have nothing to say. An empty list here is a finding, and it is one
 * this machine is always in a position to have made.
 */
export type PaneWatchers = {
  projectId: string
  /**
   * Only panes with something to say: a reader, a typist, or a mute. An empty
   * list means nobody is reading, nobody has typed, and nothing is muted.
   */
  panes: WatchedPane[]
  readAt: number
}

/**
 * How long a held burst waits for the owner before it expires.
 *
 * A minute. Long enough that somebody who looked away from the screen still
 * gets to answer, short enough that a teammate whose colleague has gone to
 * lunch is told so rather than left watching a cursor that never moves.
 *
 * Here rather than in the service that enforces it, because the machine doing
 * the typing has to be more patient than the machine doing the deciding: the
 * peer call carrying a held keystroke keeps its own deadline, and if that
 * deadline were the shorter of the two the typist would be told their teammate
 * never answered at the very moment their teammate was about to. See
 * `PEER_WRITE_TIMEOUT_MS` in `src/main/runtime/peerTransport.ts`, which is
 * derived from this rather than guessed alongside it.
 */
export const CONSENT_WINDOW_MS = 60_000

/**
 * What the owner may answer a held burst with.
 *
 * `once` admits the keystrokes they were actually shown and nothing else — see
 * `ConsentRequest.writes` for why that is a count and not a boolean. `session`
 * and `always` are standing permissions for that teammate on that pane, and the
 * only difference between them is how long they outlive: `session` until this
 * runtime or that link ends, `always` until the pane does or the owner lifts it.
 */
export type ConsentDecision = 'once' | 'session' | 'always' | 'deny'

/** How long a standing permission lasts. The two halves of `ConsentDecision`. */
export type ConsentScope = 'session' | 'always'

/**
 * One teammate's keystrokes, held at one of this machine's panes until the
 * owner says.
 *
 * A burst is one request. Somebody typing a command sends a keystroke per key,
 * and a prompt per key would be a prompt nobody reads — so keystrokes from the
 * same teammate at the same pane join the request that is already open, and the
 * preview grows underneath the owner while they decide.
 *
 * NOTHING HERE HAS RUN. That is the whole point of the shape: the bytes are on
 * this machine, in memory, and the pty has not seen them.
 */
export type ConsentRequest = {
  id: string
  projectId: string
  /** This machine's own pane id, from this machine's own list. */
  terminalId: string
  /** What this project's roster calls them, never what they call themselves. */
  handle: string
  publicKey: string
  /** The first keystroke of this burst, by the owner's clock. */
  since: number
  /** The most recent one, which is what makes a growing burst visible. */
  at: number
  /** When this stops waiting and the teammate is told it expired. */
  expiresAt: number
  /**
   * How many keystrokes are held.
   *
   * The owner answers a count as well as a request: what they were shown is
   * what "allow once" admits, and anything that arrived after the screen they
   * looked at stays held and asks again. A burst that grew between the render
   * and the click must not ride in on a decision made about something shorter.
   */
  writes: number
  bytes: number
  /**
   * What is held, rendered so that every byte of it is visible and none of it
   * can act.
   *
   * Control characters are shown in caret notation, escape sequences are shown
   * rather than obeyed, and the characters that reorder text on screen are
   * named instead of printed. See `src/main/teamwork/peer/writePreview.ts`: the
   * owner is being asked to approve bytes chosen by somebody else, and a
   * preview that rendered them would let the sender choose what the question
   * looks like.
   */
  preview: string
  /** True when more is held than the preview shows. */
  clipped: boolean
}

/** One standing permission the owner has given, and how long it lasts. */
export type ConsentGrant = {
  terminalId: string
  handle: string
  publicKey: string
  scope: ConsentScope
  /** When it was given, by the owner's clock. */
  since: number
}

/**
 * What is waiting on the owner in one project, and what they have already
 * decided.
 *
 * Both halves in one answer, for the reason the mute is reported beside the
 * watchers: a permission the owner cannot see is a permission they cannot lift.
 *
 * One shape rather than a union, on the same argument as `PaneWatchers` and
 * with the same two halves behind it. A held burst is a teammate's keystroke,
 * which arrives over a link, which a project teamwork has not read has none of
 * — so an empty queue is the truth rather than a guess at it. The standing
 * permissions are the owner's own, restored before the first reconcile, so they
 * are reported from the first moment somebody can ask. The one thing a roster
 * adds is the name to put beside a key, and a key the roster does not name is
 * already shown as a key; a project whose roster has not been read yet is that
 * same case arrived at a moment earlier.
 */
export type PaneConsent = {
  projectId: string
  /** Oldest first, so the queue reads in the order it arrived. */
  requests: ConsentRequest[]
  /** Sorted by pane then handle, so two reads compare cleanly. */
  standing: ConsentGrant[]
  readAt: number
}

/**
 * One remote keystroke, as the owner's own record of it.
 *
 * WHAT IT DELIBERATELY DOES NOT HOLD IS THE BYTES. The argument is written out
 * in `src/main/teamwork/peer/writeLog.ts`, where the file is written; the short
 * form is that a remote write carries *input*, and input includes what a
 * terminal deliberately does not echo. Keeping it would turn the owner's audit
 * trail into a plaintext store of their teammates' passphrases, which is a
 * worse thing to own than this log is good.
 */
export type RemoteWrite = {
  /** By the owner's clock, which is the only one this record trusts. */
  at: number
  handle: string
  publicKey: string
  projectId: string
  terminalId: string
  /** How much was sent, never what it was. */
  bytes: number
  /** How many submissions it carried, so a command is not read as a keypress. */
  returns: number
  /** Whether it reached the pane, and what stopped it when it did not. */
  outcome: RemoteWriteOutcome
  /** Why it was refused, in the words the teammate was given. Absent when it landed. */
  reason?: string
}

/**
 * `written` is the only one where bytes reached a pty. The rest are the ways
 * this machine said no, kept apart rather than collapsed into "refused",
 * because "I muted you" and "that pane is gone" are different answers.
 *
 * `denied` and `expired` are the two ways a held keystroke ends without
 * running, and they are two entries rather than one for the same reason: "I was
 * asked and said no" and "nobody was at the keyboard" are different facts about
 * the owner, and only the first of them is a decision. A held keystroke that is
 * allowed is filed as `written`, once, at the moment it actually runs — there
 * is no entry for the holding itself, because nothing happened to the pane
 * while it was held.
 */
export type RemoteWriteOutcome = 'written' | 'muted' | 'no-pane' | 'not-a-member' | 'too-large' | 'denied' | 'expired'

/** The owner's record of what teammates have typed here. */
export type RemoteWriteLog = {
  /** Oldest first, so this list's order is the order it happened in. */
  writes: RemoteWrite[]
  /** Why the record may be incomplete, or null when nothing has gone wrong. */
  problem: string | null
  readAt: number
}

/** Every teammate's worktrees in one project, as last heard. */
export type TeammatePresenceRead = {
  /** The roster below was read from the repository, rather than assumed empty. */
  state: 'read'
  projectId: string
  /** Sorted by handle then by worktree name, so two reads compare cleanly. */
  worktrees: TeammateWorktree[]
  /** Every teammate on this project's roster, those never heard from included. */
  teammates: TeammateStanding[]
  readAt: number
}

/**
 * Who is on this project, or nothing at all while it has not been read.
 *
 * A union for the same reason `TeamworkStatus` is one, and the empty roster is
 * exactly the `relay: null` of this method. `teammates: []` is a finding — it
 * says the repository's roster was read and holds nobody but you, which sends
 * somebody to `teamree team invite`. Answering it for a project whose
 * `.teamree` has not been opened yet would tell a person their team is absent
 * when the truth is that nobody has looked, and the sidebar would draw the one
 * project with four colleagues in it as a project with none.
 *
 * `worktrees: []` would be the milder half of the same lie — "connected and
 * showing nothing" rather than "not dialled" — and it is not separable from the
 * roster anyway: the roster is what the links are made from, so the two are
 * unread together or read together.
 */
export type TeammatePresence = TeammatePresenceRead | TeamworkUnread

/**
 * Who was heard from, or nothing at all while teamwork has not read this
 * project.
 *
 * `teamworkFacts` for the roster, and it exists for the same readers: the
 * sidebar's teammate rows, the "nothing heard from ana" line, the size a
 * watched pane letterboxes to. Every one of them already says nothing for a
 * project nobody has asked about yet, and "not read yet" is the same silence
 * arrived at a different way. Anything with a sentence to write about the wait
 * itself reads `state` instead.
 */
export function teammatesHeard(presence: TeammatePresence | undefined): TeammatePresenceRead | undefined {
  return presence?.state === 'read' ? presence : undefined
}

/**
 * What is sitting at the path the CLI would be linked to.
 *
 * `elsewhere` is the one worth keeping apart from the rest. A link that already
 * exists and leads to a *different* teamree — an older copy still in
 * ~/Downloads, a second build — is the failure nobody diagnoses on their own:
 * the command is on PATH, it runs, and it drives an app that is not this one.
 */
export type CliLinkState =
  /** A symlink that lands on this app's own CLI. There is nothing to do. */
  | 'linked'
  /** A symlink that lands somewhere else. `resolved` says where. */
  | 'elsewhere'
  /** A regular file. Somebody's binary, and teamree will not delete it. */
  | 'file'
  /** A directory, which is stranger still and equally not ours to remove. */
  | 'directory'
  | 'absent'

/**
 * How the destination directory reaches a shell's PATH — and which question was
 * actually answered, because the three are not equally strong.
 *
 * An app opened from Finder inherits none of a shell's environment, so this
 * process's own PATH (`environment`) is evidence of one thing only: that the
 * directory is on it.
 *
 * `shell` is the login shell's own PATH, asked for by starting it and having it
 * print what it ended up with after reading the user's profile. That is the
 * PATH of the terminal they will actually type in, so it is the only source
 * that can answer the question either way — and the only one that can say no.
 *
 * `login` is `/etc/paths`, and it is the fallback for a shell that could not be
 * asked. It used to be documented here as "what makes '/usr/local/bin is on
 * your PATH' a true statement about the terminal the user will actually type
 * in", and that was wrong: `path_helper` builds a *starting* PATH, and a
 * profile that assigns `PATH=` rather than extending it throws it away. On such
 * a machine `/etc/paths` says yes, the terminal says no, and the app said yes
 * with no hedge — after charging an administrator password for the link.
 */
export type CliPathSource = 'environment' | 'shell' | 'login'

/**
 * Why a link to this app would not outlive the day, when it would not.
 *
 * Both of these are how a Mac runs an app nobody has put in /Applications yet,
 * and both of them look like a working app to everything except a symlink.
 * `volume` is the copy inside the mounted disk image, which the DMG window
 * invites a double-click on. `translocated` is the read-only copy macOS runs
 * instead when an app is opened from a disk image or a download, out of a
 * per-boot temporary directory that is gone by the next launch.
 */
export type CliImpermanence = 'volume' | 'translocated'

/** Where the CLI is, what is at its destination, and what linking will cost. */
export type CliStatus = {
  /**
   * Whether this app can do the linking itself. macOS only: everything below is
   * still answered elsewhere, so the window can say what to type instead of
   * offering a button that cannot work.
   */
  installable: boolean
  platform: NodeJS.Platform
  /** The CLI inside this app, or null when this build has none to link. */
  source: string | null
  /**
   * Whether that CLI is the one inside a packaged app rather than one found in
   * a source checkout.
   *
   * The difference matters to exactly one caller: the offer made unprompted on
   * first run. A checkout's CLI is a fine thing to link by hand and a bad thing
   * to be asked about on every `npm run dev`, and a link into a checkout breaks
   * the moment that checkout moves.
   */
  packaged: boolean
  /**
   * The Node bundle the CLI at `source` would run, or null when there is none.
   *
   * `source` is a launcher script; the CLI itself is the bundle behind it, and
   * the launcher looks for that in two places. A packaged app ships it beside
   * the launcher. A source checkout only has one once `npm run build:cli` has
   * written `out/cli/index.js` — which `npm run dev` does not do. Null is
   * therefore the difference between a command and a symlink that resolves: the
   * link can be made, a password can be spent making it, and `teamree` still
   * exits with "Cannot find module".
   */
  bundle: string | null
  /**
   * Where this app is running from, when that is somewhere a link cannot
   * follow. Null when it is somewhere ordinary.
   *
   * The thing that has to be known before a password is asked for: a link into
   * a mounted disk image, or into the copy macOS translocates an app to, is
   * made successfully, reads back successfully, and dangles by the evening.
   */
  impermanent: CliImpermanence | null
  /** The link itself. */
  destination: string
  /** The directory holding it — the thing that has to be writable. */
  directory: string
  state: CliLinkState
  /** Where what is at the destination actually lands. Null when nothing is there. */
  resolved: string | null
  /**
   * Whether `resolved` is a path with nothing at it.
   *
   * Only ever true of a symlink, and it is the difference between the two
   * things `elsewhere` covers. A link to another copy of teamree is a command
   * that works and drives the wrong app; a link to a copy that has been deleted
   * or ejected is not a command at all, and a shell asked to run it says so.
   */
  dangling: boolean
  /** Whether writing the link will ask for an administrator password. */
  needsAdministrator: boolean
  /** Null when nothing this app can read says the directory is on PATH. */
  onPath: CliPathSource | null
  /**
   * When this installation was asked whether to do this, or null if it never
   * has been.
   *
   * The record of a question, not of an outcome: declining is an answer and it
   * has to stick, or "asked once" becomes "asked once a launch" — which is how
   * a prompt teaches people to dismiss it unread.
   */
  askedAt: number | null
  readAt: number
}

/** What `cli.install` did, told precisely enough to be repeated back. */
export type CliInstall = {
  outcome: /** The link was already right. Pressing the button twice is not an error. */
    | 'already-linked'
    | 'linked'
    /** A symlink to something else was replaced; `replaced` says what it was. */
    | 'replaced'
  /** Where the link used to lead, when it led anywhere. */
  replaced: string | null
  /** Whether a password was asked for. */
  administrator: boolean
  /** Read back after the link was made, by resolving it. */
  status: CliStatus
}

/**
 * A release this build could move to, as the app is willing to describe it.
 *
 * Everything here came off the GitHub API and has been through
 * `src/main/updates/latestRelease.ts`, which is the only place that trusts any
 * of it: the tag has been matched against the shape this project's tags have,
 * both URLs have been checked to be addresses in this repository, and the notes
 * are plain text with the control characters taken out. They are still somebody
 * else's words — render them as text, never as markup.
 */
export type UpdateRelease = {
  /** The version, without the tag's `v`, e.g. "0.2.0". */
  version: string
  /** The tag it was published under, e.g. "v0.2.0". */
  tag: string
  /**
   * The release notes, as text, or null when there are none to show.
   *
   * Null is also what a release remembered from an earlier run carries: the
   * version a check found is written down so that a restart still knows about
   * it, and the notes deliberately are not — see `workspaceDocument.ts`.
   */
  notes: string | null
  /** The `.dmg`, when a check found one. Null leaves the release page. */
  downloadUrl: string | null
  /** The release's page, which exists for every published tag. */
  releaseUrl: string
  publishedAt: number | null
}

/** What this build is, what is out there, and whether teamree is looking. */
export type UpdateState = {
  /** This build's version: package.json's, baked in at build time. */
  current: string
  /**
   * Whether there is anything to compare against.
   *
   * False for a build that is not a release — `npm run dev` reports
   * `0.0.0-dev`, which precedes every published version and would otherwise
   * have every developer's window announcing an update on every launch.
   */
  checkable: boolean
  /** Whether teamree checks by itself. The preference, as the user left it. */
  automatic: boolean
  /** The newer release, or null when there is none to offer. */
  available: UpdateRelease | null
  /** True while a check is in flight, so a button can say so. */
  checking: boolean
  /** When the last check was attempted, whether or not it succeeded. */
  checkedAt: number | null
  /**
   * Why the last check produced no answer, in one line, or null when it did.
   *
   * Kept rather than raised: a check that could not reach GitHub is not an
   * error the user has to do anything about, and interrupting them with one
   * would be worse than the staleness it is warning about.
   */
  problem: string | null
}
