// Task trees, pane identity, overlaps, usage, handoffs and templates: the
// shared shapes behind child worktrees and the surfaces that read them.

/** Deepest a child an agent may make sits under its top-level task. People in the window are not limited. */
export const MAX_CHILD_DEPTH = 3

/** Most open children an agent may give one parent. */
export const MAX_OPEN_CHILDREN = 6

/** A task's stage, derived from panes, git and reports; never set by hand. */
export type TaskStage = 'working' | 'asking' | 'stopped' | 'ready' | 'done' | 'landed' | 'failed'

export const TASK_STAGES: readonly TaskStage[] = ['working', 'asking', 'stopped', 'ready', 'done', 'landed', 'failed']

export type TaskOutcome = 'succeeded' | 'failed'

/** What a child said when it finished (`msg done`); `paths` come from git, not from the agent. */
export type WorktreeReport = {
  outcome: TaskOutcome
  summary: string
  paths: string[]
  at: number
}

/** Environment every pane starts with, so the program in it can say "me" to teamree. */
export const PANE_IDENTITY_ENV = {
  terminalId: 'TEAMREE_TERMINAL_ID',
  worktreeId: 'TEAMREE_WORKTREE_ID',
  projectId: 'TEAMREE_PROJECT_ID',
  /** This runtime's socket, so a pane reaches the app it runs in. */
  endpoint: 'TEAMREE_ENDPOINT',
  /** Absolute path of this build's CLI. */
  cli: 'TEAMREE_CLI'
} as const

/** Two worktrees changing the same paths; `conflicts` are the ones a merge would stop on. */
export type WorktreeOverlap = {
  worktreeId: string
  with: { worktreeId: string } | { handle: string; worktreeId: string }
  paths: string[]
  conflicts: string[]
  /** Paths one side changed inside the other's claims. */
  claimed?: string[]
  /** Hot files among `paths` (lockfiles, package.json, touched by most worktrees): weak evidence alone. */
  hot?: string[]
}

export type WorktreeOverlaps = { projectId: string; overlaps: WorktreeOverlap[]; readAt: number }

/** Tokens a worktree's agents spent, read from their own transcripts. `costUsd` is null when a model is unpriced. */
export type WorktreeUsage = {
  worktreeId: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  costUsd: number | null
  sessions: number
  /** Agent panes whose transcripts teamree cannot read; counted, never taken as zero. */
  unknownPanes: number
  readAt: number
}

/** A worktree offered to one teammate, carried in presence. */
export type PeerHandoff = {
  id: string
  /** The receiving teammate's handle; only they draw it. */
  to: string
  from?: string
  worktreeName: string
  branch: string
  note: string
  at: number
}

export type TeamworkHandoffs = { incoming: PeerHandoff[]; outgoing: PeerHandoff[] }

/** A prompt kept as `.teamree/tasks/<name>.md`; frontmatter gives the agent counts and start point. */
export type TaskTemplate = {
  name: string
  /** Repo-relative path of the file. */
  file: string
  agents: Record<string, number>
  from?: 'base' | 'parent'
  prompt: string
}

/** A template file that did not parse, reported rather than thrown. */
export type TaskTemplateProblem = { file: string; problem: string }

export type TaskTemplateList = { projectId: string; templates: TaskTemplate[]; problems: TaskTemplateProblem[] }
