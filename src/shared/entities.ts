// Core domain entities. Every process agrees on these shapes: the runtime owns
// them, the renderer and the CLI only ever read or request changes to them.

import type { RestoredAs } from './paneRestore'
import type { ScreenMenu, ScreenOpinion } from './screenOpinion'
import type { TitleOpinion } from './titleOpinion'

/** A tracked git repository. One project owns many worktrees. */
export type Project = {
  id: string
  name: string
  /** Absolute path to the primary checkout. */
  path: string
  /** Ref new worktrees branch from unless overridden, e.g. "origin/main". */
  baseRef: string
  /**
   * Gitignored directories in the primary checkout — `node_modules`, `.venv` —
   * symlinked (never copied: large, rebuildable) into every new worktree.
   * Absent means unconfigured, not "none".
   */
  linkedPaths?: string[]
  /**
   * Gitignored files in the primary checkout — `.env`, `.env.local` — copied
   * into every new worktree: small, and a task's edits must not leak back.
   */
  copiedPaths?: string[]
  /**
   * One command run in every new worktree once the checkout is ready, in a
   * terminal pane labelled `setup` so it can be watched and Ctrl-C'd. Not
   * parsed or sanitised; runs on create only, never on restore or relaunch.
   */
  setupCommand?: string
  /** False stops the timed and on-focus fetch of the base ref; absent is on. */
  fetchInBackground?: boolean
  /**
   * What `.teamree/project.json` in the primary checkout says. Read, never
   * stored: each field applies where this Mac has none of its own.
   */
  repository?: ProjectRepositorySettings
  /** Why `.teamree/project.json` was ignored: it is there and cannot be read. */
  repositoryProblem?: string
}

/** A project's shared setup, as `.teamree/project.json` carries it. Every field optional. */
export type ProjectRepositorySettings = {
  linkedPaths?: string[]
  copiedPaths?: string[]
  setupCommand?: string
  /** The ref new worktrees start from, as Settings' "Start new worktrees from" names it. */
  startFrom?: string
}

/** A `project.clone` while it runs. */
export type CloneProgress = {
  url: string
  /** Where it is being cloned to, `~` expanded. */
  path: string
  /** The last line git printed; empty until it has. */
  line: string
  startedAt: number
  cancelling: boolean
}

export type WorktreeState =
  | 'creating'
  | 'ready'
  | 'removing'
  /** Creation failed; `error` carries the reason. */
  | 'failed'

/** One task's isolated checkout. */
export type Worktree = {
  id: string
  projectId: string
  /** Human-facing name. Seeds the branch at creation; `worktree.rename` changes it later, never the branch. */
  name: string
  branch: string
  /** Absolute path to this worktree's checkout. */
  path: string
  /** What this branched from: a ref name or a commit sha. */
  startedFrom: string
  state: WorktreeState
  error?: string
  /** On a failed create whose cause may pass (a timeout, a lock, a cancel); only then is a retry offered. */
  retryable?: true
  createdAt: number
  /**
   * The pane the project's setup command was started in. Set once when the
   * checkout became ready and kept after the pane closes, as the record that
   * setup was started. Absent where the project named no command.
   */
  setupTerminalId?: string
  /**
   * What this worktree was opened to do, as typed: the agent's first prompt,
   * kept whole. `name` starts as its first line and the branch a slug of that.
   * Absent on a checkout made without one.
   */
  task?: string
  /**
   * The checkout directory is not on disk, though git still lists it (an
   * `rm -rf` of a checkout). Read from disk on every listing, never remembered:
   * the directory can come back. Absent when the directory is where the record says.
   */
  missing?: true
  /** What its commits are compared against when not the project's base ref: an opened pull request's base. */
  baseRef?: string
  /** The existing branch it was opened on, as `worktree.create`'s `checkout` took it; absent for a new branch. */
  checkout?: string
}

/** A branch a worktree could be opened on as it is: not checked out anywhere yet. */
export type BranchEntry = {
  /** The local branch the worktree will be on. */
  name: string
  /** What `worktree.create` takes as `checkout`: the local name, or `origin/<name>` for a branch only on origin. */
  checkout: string
  remote: boolean
  /** When its last commit was made, in epoch ms. */
  updatedAt: number
  author: string
  /** Its last commit's subject, which names the worktree. */
  subject: string
}

export type BranchList = { projectId: string; branches: BranchEntry[]; readAt: number }

/** An open pull request, as `gh pr list` reports it. */
export type PullRequestEntry = {
  number: number
  title: string
  author: string
  /** The local branch the worktree will be on. */
  branch: string
  /** `origin/<head>`, or `pull/<n>/head` for a pull request from a fork. */
  checkout: string
  /** The ref its changes are compared against, `origin/<base>`. */
  base: string
  updatedAt: number | null
}

/** `available` is false when `gh` is missing or refused; `reason` is its first line then. */
export type PullRequestList = {
  projectId: string
  available: boolean
  reason: string | null
  pullRequests: PullRequestEntry[]
  readAt: number
}

/**
 * Whether there is a checkout to work in: ready, and the directory is there.
 * The one test for "can a shell start here", so every surface agrees on it.
 */
export function hasCheckout(worktree: Pick<Worktree, 'state' | 'missing'>): boolean {
  return worktree.state === 'ready' && worktree.missing !== true
}

/** Live git state for a worktree, refreshed independently of the row itself. */
export type WorktreeStatus = {
  worktreeId: string
  branch: string
  /**
   * Set when there was no checkout to read: every count below is zero because
   * nothing was asked, not because the tree is clean.
   */
  missing?: true
  /** What the branch tracks; null when it tracks nothing, absent when not read. */
  upstream?: string | null
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
  /**
   * Entries a .gitignore covers, a wholly ignored directory counting as one.
   * Not added to the counts above, but removing the checkout deletes them and
   * git's "dirty" leaves them out, so this is the only warning. Optional: never asked is not zero.
   */
  ignored?: number
  /** A rebase or merge stopped part-way, usually on conflicts. */
  operation?: 'rebase' | 'merge'
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
 * after it was added is both.
 */
export type WorktreeChange = {
  path: string
  kind: WorktreeChangeKind
  staged: boolean
  unstaged: boolean
  /** Where a rename or copy came from. Absent otherwise. */
  from?: string
  /** Lines added and removed against HEAD, a new file's lines as added; absent when git cannot count them. */
  added?: number
  removed?: number
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

/** What one entry of a worktree directory is, as `lstat` sees it. */
export type WorktreeFileKind = 'file' | 'dir' | 'symlink'

/** One entry of one directory in a worktree. A name, never a path; nothing is read recursively. */
export type WorktreeFileEntry = {
  name: string
  kind: WorktreeFileKind
  /** True when git's ignore rules cover it, so a listing can draw it dimmed. */
  ignored: boolean
}

/** One directory of a worktree, as of one read. Never its contents. */
export type WorktreeFiles = {
  worktreeId: string
  /** The directory listed, relative to the worktree root; `''` is the root. */
  path: string
  /** Directories first, then the rest, each half in name order. */
  entries: WorktreeFileEntry[]
  /** True when the directory holds more than `entries` carries. */
  truncated: boolean
  readAt: number
}

/** The paths in a worktree whose name matches a query, as of one read. */
export type WorktreeFileMatches = {
  worktreeId: string
  query: string
  /** Relative to the worktree root, in path order, or best first for a fuzzy query. */
  paths: string[]
  /** True when more matched than `paths` carries. */
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
 * What staging or unstaging one hunk did. A receipt, not a new view of the
 * tree: the caller re-reads the diff and the changes through the usual invalidation.
 */
export type WorktreeHunkStage = {
  worktreeId: string
  path: string
  /** True when the hunk is in the index now; false when it was taken out. */
  staged: boolean
  /** Lines the hunk adds, and lines it removes, as it was applied. */
  added: number
  removed: number
  appliedAt: number
}

/** What taking a whole path out of the index did. A receipt; the working tree is never written. */
export type WorktreeUnstage = {
  worktreeId: string
  path: string
  unstagedAt: number
}

/** What discarding a path or one hunk did. A receipt; the caller re-reads through the usual invalidation. */
export type WorktreeDiscard = {
  worktreeId: string
  path: string
  /** `trashed`: an untracked file went to the Trash. `restored`: back to staged, else committed. */
  outcome: 'trashed' | 'restored' | 'hunk'
  discardedAt: number
  /** The copy kept before the discard, for `worktree.undoDiscard`; absent from a runtime that keeps none. */
  trashId?: string
}

/** A removed worktree kept under `refs/teamree/trash/` until restored or pruned; `id` is what `worktree.restore` takes. */
export type RemovedWorktree = {
  id: string
  projectId: string
  worktreeId: string
  name: string
  branch: string
  task?: string
  removedAt: number
}

/**
 * Whether a worktree's branch would merge into its project's base ref.
 * Answered without checking anything out, so it is cheap to ask for every worktree.
 */
export type WorktreeMergePreview = {
  worktreeId: string
  /** What it was compared against. */
  baseRef: string
  /**
   * `nothingToMerge`, `clean` and `conflicts` are answers; `unrelated` and
   * `unavailable` are refusals to guess and carry a `reason`. `nothingToMerge`
   * is not "merged": a branch fully in the base and one that never committed look the same to git.
   */
  state: 'nothingToMerge' | 'clean' | 'conflicts' | 'unrelated' | 'unavailable'
  /** Commits this branch has that the base does not. */
  ahead: number
  /** Paths that would conflict, for `conflicts`. Empty otherwise. */
  conflicts: string[]
  reason?: string
  readAt: number
}

/** Where a worktree's branch can land: a pull request on its host, or a merge into the base branch here. */
export type WorktreeLanding = {
  worktreeId: string
  branch: string
  /** The base branch by its bare name, `main`. */
  base: string
  /** The forge `origin` points at; null for a path, an unknown host, or no origin. */
  host: 'github' | 'gitlab' | 'bitbucket' | null
  /** The branch is on `origin`. */
  published: boolean
  /** Commits on the branch that the base does not have. */
  unmerged: number
  /** The branch made commits and they are all in the base, or its pull request merged. */
  merged: boolean
  /** The host's page for opening a pull request from this branch. */
  compareUrl?: string
  /** Read with `gh`, for a GitHub origin only. */
  pullRequest?: { number: number; url: string; state: 'open' | 'merged' | 'closed' }
  readAt: number
}

/** A pull request made with `gh`, or, with `created` false and no number, the host's page to make one. */
export type WorktreePullRequest = { worktreeId: string; url: string; number?: number; created: boolean }

/** A merge of a worktree's branch into the base branch checked out in the project's own folder. */
export type WorktreeMerge = {
  worktreeId: string
  /** The base branch, `main`. */
  into: string
  /** The project's own checkout, where the merge runs. */
  checkout: string
  /** Newest first; capped at 50. */
  commits: { shortSha: string; subject: string }[]
  fastForward: boolean
  /** Uncommitted paths in `checkout`; any refuses the merge. */
  dirty: string[]
  /** False for a plan (`dryRun`). */
  merged: boolean
  /** The base branch's tip after the merge. */
  head?: string
}

/** The run kept and the task's other runs removed, their branches left in place. */
export type WorktreeKeep = { worktree: Worktree; removed: string[] }

/** A commit this app made, reported back so the caller can see what landed. */
export type WorktreeCommit = {
  worktreeId: string
  sha: string
  shortSha: string
  message: string
  /** What the commit actually captured: a path staged earlier goes in too. */
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
  /** Changes left behind in the worktree: what landed is not what is on screen. */
  uncommitted: number
  /**
   * Where to open a review for this branch, derived from the remote's URL; absent
   * when the URL does not say which forge. Nothing asked the forge, so this is
   * the page that starts one. See `src/main/git/reviewUrl.ts`.
   */
  reviewUrl?: string
  pushedAt: number
}

/** A worktree brought up to date with its base ref. */
export type WorktreeUpdate = {
  worktreeId: string
  baseRef: string
  /** Rebased when the branch was unpublished, merged when it was. */
  mode: 'rebase' | 'merge'
  /** `conflicts`: stopped part-way with `conflicts` unresolved, for `worktree.abortUpdate` or a fix. */
  outcome: 'updated' | 'upToDate' | 'conflicts'
  conflicts: string[]
  updatedAt: number
}

/** What `worktree.abortUpdate` undid; null when nothing was in progress. */
export type WorktreeUpdateAbort = { worktreeId: string; aborted: 'rebase' | 'merge' | null }

/** `data` of a failed `worktree.push`, whose message is one clause: git's whole refusal. */
export type PushFailureData = { detail: string }

/** One commit a worktree made. */
export type WorktreeCommitSummary = {
  sha: string
  shortSha: string
  author: string
  /** ISO 8601 as git wrote it, offset and all. */
  committedAt: string
  subject: string
}

/** One commit and its patch against its first parent, as `worktree.showCommit` answers. */
export type WorktreeCommitPatch = WorktreeCommitSummary & {
  worktreeId: string
  patch: string
  /** True when the patch was cut short at the byte ceiling. */
  truncated: boolean
  readAt: number
}

/** One run of a task as `worktree.compare` reads it: its working tree against the shared start commit. */
export type WorktreeCompareSide = {
  worktreeId: string
  head: string
  patch: string
  truncated: boolean
}

/** Two runs of one task, each as its patch against `base`, the commit both started from. */
export type WorktreeCompare = {
  base: string
  left: WorktreeCompareSide
  right: WorktreeCompareSide
  readAt: number
}

/** What a worktree has done that its base has not, newest first. Scoped to `base..branch`. */
export type WorktreeLog = {
  worktreeId: string
  baseRef: string
  commits: WorktreeCommitSummary[]
  truncated: boolean
  /**
   * Why the branch could not be compared against its base: an unfetched clone,
   * a base deleted on the remote, a repository with no commits. Absent when the
   * log was read — an empty `commits` then means the branch made none.
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
   * `running` stays true across that window, but the pty refuses input, so
   * anything deciding whether input can land must ask this too.
   */
  draining?: boolean
  exitCode?: number
  /** Which coding agent this pane runs, when it runs one. */
  agent?: AgentKind
  /** A harness seen in the foreground of a pane not started as one: typed into its shell. */
  foregroundAgent?: AgentKind
  /**
   * What this pane is called, when somebody has said: the task it was started
   * for, or a rename. Three agents all introduce themselves as `claude`, so
   * this outranks everything derived.
   */
  label?: string
  /** Its number among the worktree's open panes started as the same agent or shell: one past the highest held. */
  ordinal?: number
  /**
   * True while output is still arriving. The only honest signal about whether
   * an agent is working: a quiet terminal is what "waiting for you" looks like from outside.
   */
  busy: boolean
  /**
   * What this pane's own window title says it is doing. Absent means the title
   * was not one `titleOpinion` has a row for; absent is never a denial -- see
   * `src/shared/titleOpinion.ts`.
   */
  titleSays?: TitleOpinion
  /** What the bottom rows of an agent pane's screen say; see `src/shared/screenOpinion.ts`. Cleared by typing. */
  screenSays?: ScreenOpinion
  /** The answers its asking screen offers as buttons; see `screenMenu`. Cleared by typing. */
  screenMenu?: ScreenMenu
  /**
   * When this pane last rang the bell, within the current burst of output.
   * Cleared when a new burst starts and when anybody types: a bell is a request,
   * and both overtake it. Set and since quiet means the pane is asking for something.
   */
  lastBellAt?: number
  /** When output last arrived, for "no update for 4m". */
  lastOutputAt: number
  /**
   * The last thing the agent said about itself through its own hook -- see
   * `src/main/terminals/agent-hooks.ts`. Outranks bell, title and output; absent is
   * never a denial. A keystroke overtakes one about a turn in progress; an ended turn stays ended.
   */
  agentEvent?: AgentEvent
  /** Whether its agent has started a turn: set on agent panes only; false exits read as stopped, not done. */
  tookTurn?: boolean
  /**
   * How this terminal came back from a previous run — see `RestoredAs`. Absent
   * for a terminal opened now; clears the moment the user types into the pane.
   */
  restored?: RestoredAs
}

/**
 * One process, as one `ps` call reported it. `rss` is bytes; `cpu` is the
 * platform's own percentage of one core (decaying average on macOS, lifetime on
 * Linux), so compare rows but do not read one figure as this instant. `command` is the basename.
 */
export type ResourceProcess = {
  pid: number
  ppid: number
  cpu: number
  rss: number
  command: string
}

/** A pane closed in a worktree that `terminal.reopen` can bring back. `resumable`: its agent's conversation can be picked up. */
export type ClosedPane = {
  terminalId: string
  worktreeId: string
  agent?: AgentKind
  label?: string
  ordinal?: number
  resumable: boolean
  closedAt: number
}

/**
 * Everything one pane's child has started, summed and listed. `pid` is the pty
 * child, kept even when nothing under it was found: it may have died between the pane list and `ps`.
 */
export type PaneResources = {
  terminalId: string
  worktreeId: string
  pid: number
  cpu: number
  rss: number
  /** Root first, then its descendants. Empty when the child is gone. */
  processes: ResourceProcess[]
}

/** The app's own processes — main, renderer, GPU and the rest — as one row. */
export type AppResources = {
  pid: number
  cpu: number
  rss: number
  processes: ResourceProcess[]
}

/** What everything this app spawned is costing at one instant, from one `ps` call. */
export type SystemResources = {
  sampledAt: number
  cpu: number
  rss: number
  panes: PaneResources[]
  app: AppResources
}

/** What `system.kill` did: the signal went to one process, or to its whole group. */
export type ProcessKill = {
  signalled: true
  pid: number
  group: boolean
}

/**
 * Pane layout for one worktree. A leaf holds a terminal or a worktree file; a split divides its
 * area between children. Sizes are fractions summing to 1, positionally matched to `children`.
 */
export type PaneNode =
  | {
      kind: 'leaf'
      /** The pane's id: a terminal's, or `file:` plus a uuid for a file pane. */
      terminalId: string
      /** What the leaf holds. Absent means a terminal, which is every leaf older clients wrote. */
      pane?: 'terminal' | 'file'
      /** The file a file leaf shows, relative to the worktree root; its extension picks the viewer. */
      path?: string
      /** A file leaf showing this commit read-only instead of a file; `path` then holds the tab's title. */
      commit?: string
      /** A file leaf comparing its worktree with this sibling worktree, read-only; `path` holds the tab's title. */
      compare?: string
      /** A file leaf showing every change of its worktree as one patch, read-only; `path` holds the tab's title. */
      review?: true
    }
  | {
      kind: 'split'
      direction: 'row' | 'column'
      sizes: number[]
      children: PaneNode[]
      /** File leaves drawn one at a time under a tab row: the file column. Never flattened or dissolved. */
      tabs?: true
      /** The tab on show; the first when absent. */
      shown?: string
      /** The preview tab, which the next preview open replaces. */
      preview?: string
    }

export type Layout = {
  worktreeId: string
  root: PaneNode | null
  /** Terminal that receives keyboard focus when this worktree is opened. */
  focusedTerminalId: string | null
}

/** One text file of a worktree, as `file.read` answers. */
export type FileContent = {
  worktreeId: string
  /** Relative to the worktree root, forward slashes. */
  path: string
  /** Empty when the file does not exist yet; `exists` says which. */
  content: string
  exists: boolean
  /** The file's mtime in ms, or 0 when it does not exist. */
  modifiedAt: number
  size: number
  /** Text only: how the bytes were decoded and which line ending they use, kept on save. */
  encoding?: 'utf-8' | 'utf-8-bom'
  lineEnding?: '\n' | '\r\n'
  /** Only for a `viewer` read: what to draw instead of `content`, which is then empty. */
  view?: FileView
}

/** A file a viewer draws without its text: loaded from a URL, or described. */
export type FileView =
  | { kind: 'image' | 'pdf' | 'media'; url: string; mime: string }
  | { kind: 'binary' }
  | { kind: 'tooLarge'; limit: number }

/** The receipt for `file.write`: the mtime the caller can compare later reads against. */
export type FileWritten = {
  worktreeId: string
  path: string
  modifiedAt: number
  size: number
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
  /** Commit or tag time in Unix seconds, as git's %ct prints it; not milliseconds. */
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
 * The coding agents this app knows how to start and resume. Here because it
 * crosses the wire: the CLI prints it and the GUI keys buttons off it.
 */
export type AgentKind =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'opencode'
  | 'droid'
  | 'grok'
  | 'cursor'
  | 'copilot'
  | 'amp'
  | 'pi'
  | 'goose'
  | 'auggie'
  | 'crush'
  | 'cline'
  | 'codebuff'
  | 'continue'
  | 'kilo'
  | 'kimi'
  | 'kiro'
  | 'vibe'
  | 'qwen'

/**
 * The hook events an agent reports through this app's own CLI, under the agent's
 * own names. The set is what `agent-hooks.ts` subscribes to; the hook line is generated, so nothing else arrives.
 */
export type AgentEventName = 'SessionStart' | 'UserPromptSubmit' | 'Notification' | 'Stop' | 'SessionEnd'

/** One thing an agent said about itself, and when. */
export type AgentEvent = {
  event: AgentEventName
  /** The reporting CLI's clock, on the same machine as the pane. */
  at: number
  /**
   * The event's own qualifier: for `Notification`, the type -- `permission_prompt`,
   * `idle_prompt` -- which separates a request aimed at a person from a login that succeeded.
   */
  detail?: string
  /** A `Notification`'s own words, e.g. `Claude needs your permission to use Edit`. */
  message?: string
}

/** A coding agent this machine can run, found on PATH rather than configured. */
export type InstalledAgent = {
  kind: AgentKind
  /** What to run. */
  command: string
  /** Where it was found. */
  binary: string
}

/**
 * Who this installation is, as the roster records it. The public key is the
 * identity; the handle is only what it is filed under. Push access is what makes a key membership.
 */
export type MemberIdentity = {
  /**
   * Filename stem under `.teamree/members`. Null when none could be worked out
   * (git has no configured email); the key is still this machine's.
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
 * A file under `.teamree/members` that could not be read as a member. Reported
 * rather than thrown: one typo must not make the roster read as "no team here".
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
  /** Where joining would write, relative to the project root. Null when no handle could be worked out. */
  selfFile: string | null
  /** True when this installation's public key is in the roster. Keyed on the key, not the handle. */
  enrolled: boolean
  /**
   * Whether a key arriving by `git pull` is noticed on its own. False is not a
   * fault and must not be shown as one: the list is only as fresh as this read.
   */
  watched: boolean
  readAt: number
}

/**
 * What an unwatched `.teamree` costs, in the one sentence both sides say: the
 * runtime when a watch cannot attach, the window beside `watched: false`.
 */
export const UNWATCHED_TEAMREE_LAG =
  'A teammate’s key or a relay arriving by git pull will be noticed by the periodic check rather than at once, so ' +
  'the roster can be up to half a minute behind the last pull.'

/**
 * Where a project's relay is recorded, and what each of the two places said.
 * Both halves reported, and the environment override named even when unset: an
 * app launched from Finder inherits no shell environment.
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
   * The one command that stands a relay up, as *this* installation can run it:
   * it differs between a checkout and an installed app. `command` is null when
   * this build carries no relay, and `reason` then says so.
   */
  deploy: { command: string; reason: null } | { command: null; reason: string }
  readAt: number
}

/**
 * What one commit would carry, said before it is made. Read from the runtime
 * because the branch and upstream are git's answers, not the window's guess.
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
 * What the one button did, in the two halves it can half-fail in. A commit that
 * landed and a push that was refused is ordinary, so each carries its own verdict.
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
     * `kind` is the shape of the refusal, for deciding whether to offer "try again".
     */
    | { ok: false; kind: PushFailureKind; error: string; advice: string }
  at: number
}

/**
 * Why a push did not land, as a thing to branch on. `rejected` is a teammate
 * having pushed first, which retrying fixes after a pull; `auth` and `host-key`
 * retrying never touches; `cancelled` and `timeout` are teamree's verdicts, not the remote's.
 */
export type PushFailureKind = 'rejected' | 'auth' | 'host-key' | 'cancelled' | 'timeout' | 'other'

/** What a publish is doing right now. `finished` covers success and failure alike. */
export type TeamworkPublishPhase = 'staging' | 'committing' | 'pushing' | 'finished'

/**
 * A publish while it is happening. A push waiting on a credential, one copying
 * objects and one that will never return look alike from outside; the phase,
 * `output`, `startedAt` and `lastOutputAt` are what tell them apart.
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
 * One pane on a teammate's machine, as their runtime reports it. Deliberately
 * not a `Terminal`: only what the sidebar reads crosses.
 */
export type PeerPane = {
  /** The owner's id for it. Namespaced by the receiver before it is stored. */
  id: string
  /**
   * The pane's own title and the shell behind it — the raw facts a name is made
   * from, not the name: the reader owns the rule, and a sent label would be a second copy free to disagree.
   */
  title: string
  shell: string
  /** What the owner called it, when somebody did. Absent from a peer built before names crossed. */
  label?: string
  /** `Terminal.ordinal` on the owner's machine; absent from a peer built before it crossed. */
  ordinal?: number
  agent?: AgentKind
  running: boolean
  exitCode?: number
  busy: boolean
  /**
   * The size of the owner's pty, so a watcher can letterbox to it. Optional
   * because a peer that has not been rebuilt sends none. Never negotiated: a
   * reader letterboxes rather than resizing a pty under a program only being read (`docs/teamwork.md`).
   */
  cols?: number
  rows?: number
  /**
   * Silence as a duration measured by the owner, never an instant: two machines
   * do not agree on the time. The receiver adds the time since it arrived.
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
 * A teammate's worktrees in one repository. Named by a hash rather than its
 * remote: a peer session covers every shared repository, and remotes in the
 * clear would leak URLs of repositories the teammate is not a member of.
 */
export type PeerProject = {
  projectKey: string
  worktrees: PeerWorktree[]
}

/** Everything one runtime tells a teammate about itself. Metadata only. */
export type PeerPresence = {
  /**
   * Monotonic per sender. A snapshot that arrives behind one already applied is
   * dropped: over a real link two reads can overtake each other.
   */
  revision: number
  /** The handle the sender's own roster files their key under. Display only. */
  handle: string | null
  projects: PeerProject[]
}

/**
 * How a link to one teammate is going, in the words the window shows.
 * `waiting`, `refused` and `unreachable` are three different facts, never "offline".
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
   * Not "never again": a relay is restarted without this app hearing, so the
   * link looks once more after a long wait — see `STOPPED_RETRY_MS`.
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
   * When something from them last decrypted, by this machine's clock, and only
   * once that was long enough ago to mean anything (`since` is when the phase moved).
   * Absent while the link is talking and while it is down; the link owns the threshold.
   */
  lastHeardAt?: number
  /** How many times this link has been built, so a flapping one is visible. */
  attempts: number
}

/**
 * Whether teamwork is running for one project, and how. `disabledReason` is the
 * honest half: no relay, origin or roster is "not configured", not "offline".
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
   * Whether this checkout has an `origin` teamree can match against a teammate's,
   * and why not. Beside `disabledReason` rather than in it: that names the first
   * thing to fix, which for a project with neither is the relay.
   */
  origin: /**
   * `url` is the origin as it is to be named — the string an invitation says to
   * clone. For a repository shared over a path it is the normalised path, which
   * their checkout must match character for character.
   */
  { ok: true; url: string } | { ok: false; reason: string }
  /**
   * Whether this machine's own key is on the roster this checkout holds. False
   * is the one cause of silence that is entirely this end's: every link below
   * dials a rendezvous the teammate's machine has no key to compute.
   */
  enrolled: boolean
  links: PeerLink[]
  readAt: number
}

/**
 * A project this machine has and teamwork has not read yet: between the add
 * event and the reconcile, and every restored project until the peer service
 * has started. Its own answer rather than a row of nulls (those are findings)
 * and not an error (the project exists). One type for every read with this state.
 */
export type TeamworkUnread = {
  state: 'unread'
  projectId: string
  /** When this answer was given, which is the whole of what it asserts. */
  readAt: number
}

/**
 * Whether teamwork is running for one project — or whether even that is known.
 * A union, because a reader that cannot tell the two apart names a fault nobody established.
 */
export type TeamworkStatus = TeamworkRead | TeamworkUnread

/**
 * What was found, or nothing at all while teamwork has not read this project.
 * `undefined` is deliberately the same answer as "never asked"; anything with a
 * sentence to write about the wait reads `state` instead.
 */
export function teamworkFacts(status: TeamworkStatus | undefined): TeamworkRead | undefined {
  return status?.state === 'read' ? status : undefined
}

/** One of a teammate's worktrees, with whose it is attached to it. */
export type TeammateWorktree = PeerWorktree & {
  handle: string
  publicKey: string
  /**
   * When the snapshot this row came out of arrived, by this machine's clock: the
   * age of the picture, not of the silence, which is the owner's measurement plus the time since.
   */
  heardAt: number
  /**
   * Whether the link this came over is connected right now. False is a row out
   * of the local cache; nothing may be done to a pane on a row that is not live.
   */
  live: boolean
}

/**
 * One teammate on the roster, and whether there is any picture of them at all:
 * "their machine is away" and "never heard from" are different facts.
 */
export type TeammateStanding = {
  handle: string
  publicKey: string
  /** Their link is connected and has confirmed key possession. */
  connected: boolean
  /**
   * When their picture was last taken, by this machine's clock, or null if never.
   * The age of the snapshot, not of the contact: it moves when a *changed*
   * snapshot arrives. Time since anything was heard is `PeerLink.lastHeardAt`.
   */
  heardAt: number | null
}

/**
 * One person reading one of this machine's panes, right now. The half of the
 * bargain in `docs/teamwork.md` the owner is owed: nothing is done invisibly.
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
 * One person who has typed into one of this machine's panes. Their keystroke
 * runs as the owner, so `at` keeps "is typing" live. The counters cover this
 * runtime's whole uptime; `refused` counts typing at a muted pane, which the owner wants to know.
 */
/**
 * How long after a keystroke somebody is still "typing". Shared so the runtime
 * and the window agree; 1.5s survives thinking mid-command without outliving the typist.
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
   * The owner has stopped remote keystrokes reaching this pane. Reported even
   * when nobody is reading or typing: a mute the owner cannot see is one they cannot lift.
   */
  muted: boolean
}

/**
 * Every pane of this machine somebody is reading, has typed into, or muted. One
 * shape rather than a `read`/`unread` union: every fact here is this machine's
 * own and none waits on a reconcile, so an empty list is a finding.
 */
export type PaneWatchers = {
  projectId: string
  /** Only panes with something to say: a reader, a typist, or a mute. */
  panes: WatchedPane[]
  readAt: number
}

/**
 * How long a held burst waits for the owner before it expires: a minute. Here
 * rather than in the service, because `PEER_WRITE_TIMEOUT_MS` in
 * `src/main/runtime/peerTransport.ts` is derived from it and must be the longer of the two.
 */
export const CONSENT_WINDOW_MS = 60_000

/**
 * What the owner may answer a held burst with. `once` admits the keystrokes they
 * were shown and nothing else (see `ConsentRequest.writes`); `session` lasts until
 * this runtime or that link ends, `always` until the pane does or the owner lifts it.
 */
export type ConsentDecision = 'once' | 'session' | 'always' | 'deny'

/** How long a standing permission lasts. The two halves of `ConsentDecision`. */
export type ConsentScope = 'session' | 'always'

/**
 * One teammate's keystrokes, held at one of this machine's panes until the owner
 * says. A burst is one request: keystrokes from the same teammate at the same
 * pane join the open one. NOTHING HERE HAS RUN: the pty has not seen the bytes.
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
   * How many keystrokes are held. What the owner was shown is what "allow once"
   * admits; anything that arrived after stays held and asks again.
   */
  writes: number
  bytes: number
  /**
   * What is held, rendered so every byte is visible and none can act: caret
   * notation, escapes shown not obeyed, reordering characters named. See
   * `src/main/teamwork/peer/writePreview.ts`: the sender must not choose what the question looks like.
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
 * decided. One shape rather than a union, on the same argument as `PaneWatchers`:
 * an empty queue is the truth, and standing permissions are restored before the first reconcile.
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
 * One remote keystroke, as the owner's own record of it. DELIBERATELY WITHOUT
 * THE BYTES: input includes what a terminal does not echo, and keeping it would
 * make the audit trail a plaintext store of passphrases. See `src/main/teamwork/peer/writeLog.ts`.
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
 * `written` is the only one where bytes reached a pty; the refusals stay apart
 * because "I muted you" and "that pane is gone" are different answers, as are
 * `denied` (a decision) and `expired` (nobody at the keyboard). An allowed hold is filed as `written` when it runs.
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
 * Who is on this project, or nothing at all while it has not been read. A union
 * for the reason `TeamworkStatus` is: `teammates: []` is a finding that sends
 * somebody to `teamree team invite`, and must not be answered for an unopened `.teamree`.
 */
export type TeammatePresence = TeammatePresenceRead | TeamworkUnread

/**
 * Who was heard from, or nothing at all while teamwork has not read this project.
 * `teamworkFacts` for the roster; anything with a sentence about the wait reads `state`.
 */
export function teammatesHeard(presence: TeammatePresence | undefined): TeammatePresenceRead | undefined {
  return presence?.state === 'read' ? presence : undefined
}

/**
 * What is sitting at the path the CLI would be linked to. `elsewhere` — a link
 * to a *different* teamree, an older copy in ~/Downloads — is the failure
 * nobody diagnoses alone: the command runs and drives an app that is not this one.
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
 * How the destination directory reaches a shell's PATH, and which question was
 * answered. `environment` is this process's PATH, of which a Finder-launched app
 * inherits none of a shell's. `shell` is the login shell's own PATH, the only
 * source that can say no. `login` is `/etc/paths`, a fallback only: `path_helper`
 * builds a *starting* PATH that a profile assigning `PATH=` throws away.
 */
export type CliPathSource = 'environment' | 'shell' | 'login'

/**
 * Why a link to this app would not outlive the day. `volume` is the copy inside
 * the mounted disk image; `translocated` is the read-only copy macOS runs from a
 * per-boot temporary directory when an app is opened from a disk image or download.
 */
export type CliImpermanence = 'volume' | 'translocated'

/** Where the CLI is, what is at its destination, and what linking will cost. */
export type CliStatus = {
  /**
   * Whether this app can do the linking itself. macOS only; elsewhere the
   * window says what to type instead of offering a button that cannot work.
   */
  installable: boolean
  platform: NodeJS.Platform
  /** The CLI inside this app, or null when this build has none to link. */
  source: string | null
  /**
   * Whether that CLI is the one inside a packaged app rather than a source
   * checkout. Only the unprompted first-run offer cares: a link into a checkout
   * breaks the moment the checkout moves, and nobody wants asking on every `npm run dev`.
   */
  packaged: boolean
  /**
   * The Node bundle the CLI at `source` would run, or null when there is none.
   * A packaged app ships it beside the launcher; a checkout only has one once
   * `npm run build:cli` wrote `out/cli/index.js`, which `npm run dev` does not.
   * Null means the link would resolve and `teamree` still exit with "Cannot find module".
   */
  bundle: string | null
  /**
   * Where this app is running from, when a link cannot follow it (disk image,
   * translocation): the link is made, reads back, and dangles by the evening. Null when ordinary.
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
   * Whether `resolved` is a path with nothing at it. Only ever true of a
   * symlink: a link to a deleted or ejected copy is not a command at all.
   */
  dangling: boolean
  /** Whether writing the link will ask for an administrator password. */
  needsAdministrator: boolean
  /** Null when nothing this app can read says the directory is on PATH. */
  onPath: CliPathSource | null
  /**
   * When this installation was asked whether to do this, or null if never. The
   * record of a question, not an outcome: declining has to stick, or "asked once" becomes "asked once a launch".
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
 * A release this build could move to. Everything here came off the GitHub API
 * through `src/main/updates/latestRelease.ts`, the only place that trusts it.
 * Still somebody else's words: render as text, never as markup.
 */
export type UpdateRelease = {
  /** The version, without the tag's `v`, e.g. "0.2.0". */
  version: string
  /** The tag it was published under, e.g. "v0.2.0". */
  tag: string
  /**
   * The release notes, as text, or null. Null also for a release remembered from
   * an earlier run: the version is written down, the notes deliberately not — see `workspaceDocument.ts`.
   */
  notes: string | null
  /** The `.dmg`, when a check found one. Null leaves the release page. */
  downloadUrl: string | null
  /** The release's page, which exists for every published tag. */
  releaseUrl: string
  publishedAt: number | null
  /** The `.dmg` teamree can fetch and verify itself; absent or null when the release gives no size and checksum. */
  installer?: { name: string; size: number } | null
}

/** Fetching the installer into ~/Downloads. `version` says which release it was for. */
export type UpdateDownload =
  | { state: 'downloading'; version: string; received: number; total: number }
  | { state: 'ready'; version: string; path: string }
  | { state: 'failed'; version: string; problem: string }

/** What this build is, what is out there, and whether teamree is looking. */
export type UpdateState = {
  /** This build's version: package.json's, baked in at build time. */
  current: string
  /**
   * Whether there is anything to compare against. False for a non-release build:
   * `npm run dev` reports `0.0.0-dev`, which precedes every published version.
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
   * Why the last check produced no answer, or null. Kept rather than raised: a
   * check that could not reach GitHub is not worth interrupting anybody for.
   */
  problem: string | null
  /** The installer being fetched, fetched, or refused; absent or null before one was asked for. */
  download?: UpdateDownload | null
}
