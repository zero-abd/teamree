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
  exitCode?: number
  /** Which coding agent this pane runs, when it runs one. */
  agent?: AgentKind
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
  readAt: number
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
  /** Somebody was there and the handshake did not authenticate them. */
  | 'refused'
  /** The relay could not be reached at all. */
  | 'unreachable'
  /** Given up: something reconnecting cannot fix, and `detail` says what. */
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
  /** How many times this link has been built, so a flapping one is visible. */
  attempts: number
}

/**
 * Whether teamwork is running for one project, and how.
 *
 * `disabledReason` is the honest half: a project with no relay, no origin
 * remote or no roster is not "offline", it is not configured, and a row that
 * said "offline" would have somebody looking at their network.
 */
export type TeamworkStatus = {
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
  origin: { ok: true } | { ok: false; reason: string }
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

/** One of a teammate's worktrees, with whose it is attached to it. */
export type TeammateWorktree = PeerWorktree & {
  handle: string
  publicKey: string
  /** When this was last heard, by this machine's clock. */
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
  /** When anything was last heard from them, or null if it never has been. */
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

/** Every pane of this machine somebody is reading, has typed into, or muted. */
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
 */
export type RemoteWriteOutcome = 'written' | 'muted' | 'no-pane' | 'not-a-member' | 'too-large'

/** The owner's record of what teammates have typed here. */
export type RemoteWriteLog = {
  /** Oldest first, so this list's order is the order it happened in. */
  writes: RemoteWrite[]
  /** Why the record may be incomplete, or null when nothing has gone wrong. */
  problem: string | null
  readAt: number
}

/** Every teammate's worktrees in one project, as last heard. */
export type TeammatePresence = {
  projectId: string
  /** Sorted by handle then by worktree name, so two reads compare cleanly. */
  worktrees: TeammateWorktree[]
  /** Every teammate on this project's roster, those never heard from included. */
  teammates: TeammateStanding[]
  readAt: number
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
 * How the destination directory reaches a shell's PATH.
 *
 * Two sources because an app opened from Finder inherits none of a shell's
 * environment, so this process's own PATH is evidence of one thing only — that
 * the directory is on it. `login` is `/etc/paths`, which `path_helper` puts on
 * every login shell's PATH, and is what makes "/usr/local/bin is on your PATH"
 * a true statement about the terminal the user will actually type in.
 */
export type CliPathSource = 'environment' | 'login'

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
