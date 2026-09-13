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

export type RuntimeStatus = {
  version: string
  /** Socket path or named pipe the runtime is listening on. */
  endpoint: string
  pid: number
  platform: NodeJS.Platform
  startedAt: number
}
