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

export type RuntimeStatus = {
  version: string
  /** Socket path or named pipe the runtime is listening on. */
  endpoint: string
  pid: number
  platform: NodeJS.Platform
  startedAt: number
}
