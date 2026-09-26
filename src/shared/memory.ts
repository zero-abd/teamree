// Project memory: notes, the budgeted `project.context` bundle and conflicts.
// The graph lives in the main process; these are the shapes that leave it.

export type NoteKind = 'decision' | 'question' | 'summary'

export const NOTE_KINDS: readonly NoteKind[] = ['decision', 'question', 'summary']

/** `team` notes may cross to teammates in presence; `private` ones never do. */
export type NoteScope = 'private' | 'team'

export const MAX_NOTE_CHARS = 500

/** Most paths a note may name. */
export const MAX_NOTE_PATHS = 20

export type MemoryNote = {
  id: string
  worktreeId: string
  kind: NoteKind
  text: string
  scope: NoteScope
  /** Questions only: unanswered. */
  open?: boolean
  answer?: string
  paths?: string[]
  at: number
  /** `me`, or the teammate's public key for a note heard over presence (read-only). */
  author: 'me' | string
  /** The pane that wrote it, when an agent did. */
  agentId?: string
}

export type ContextSection = 'ancestors' | 'siblings' | 'self' | 'questions' | 'files' | 'teammates'

export const CONTEXT_SECTIONS: readonly ContextSection[] = [
  'ancestors',
  'siblings',
  'self',
  'questions',
  'files',
  'teammates'
]

/** Token budget for `project.context`; tokens are estimated as ceil(chars / 4). */
export const CONTEXT_BUDGET = { default: 1500, min: 200, max: 4000 } as const

export function clampContextBudget(tokens: number | undefined): number {
  if (tokens === undefined || !Number.isFinite(tokens)) return CONTEXT_BUDGET.default
  return Math.min(CONTEXT_BUDGET.max, Math.max(CONTEXT_BUDGET.min, Math.round(tokens)))
}

export type ContextSibling = {
  worktreeId: string
  name: string
  goal: string
  state: string
  /** `me`, or the teammate's handle. */
  owner: 'me' | string
  /** Paths both touched: the conflict risk. */
  overlap: string[]
  decisions: MemoryNote[]
}

/** How one context source answered, so a slow or broken one is visible and never blocking. */
export type ContextSourceReport = { name: string; ms: number; error?: string }

/** The budgeted bundle an agent reads about its place in the project. */
export type ProjectContext = {
  worktreeId: string
  /** Bumps on any memory write in the project. */
  revision: number
  tokens: number
  truncated: { section: string; dropped: number }[]
  /** Nearest first. */
  ancestors: { worktreeId: string; name: string; goal: string }[]
  self: { goal: string; decisions: MemoryNote[]; questions: MemoryNote[] }
  siblings: ContextSibling[]
  files: { path: string; summary: string; touchedBy: string[] }[]
  /** The same bundle rendered as text under the budget. */
  text: string
  sources?: ContextSourceReport[]
}

/** A bundle with nothing in it: what a worktree with no memory yet gets. */
export function emptyProjectContext(worktreeId: string): ProjectContext {
  return {
    worktreeId,
    revision: 0,
    tokens: 0,
    truncated: [],
    ancestors: [],
    self: { goal: '', decisions: [], questions: [] },
    siblings: [],
    files: [],
    text: ''
  }
}

/** Another worktree touching the same files. */
export type MemoryConflict = { worktreeId: string; owner: 'me' | string; files: string[] }

/** A worktree as a memory node. `goal` is the task's first line. */
export type MemoryWorktree = {
  id: string
  projectId: string
  parentId?: string
  name: string
  branch: string
  goal: string
  state: string
  owner: 'me' | string
}

/** Paths a worktree touched, and how that was learned. Paths only, never contents. */
export type MemoryTouch = {
  worktreeId: string
  paths: string[]
  source: 'diff' | 'status' | 'tool'
  agentId?: string
  at: number
}

/** A `team` note as it crosses in presence: no author, agent or scope. */
export type PeerMemoryNote = Pick<MemoryNote, 'id' | 'text' | 'at'> & {
  kind: 'decision' | 'question'
  open?: boolean
  paths?: string[]
}

/** Most bytes of `memory` one worktree may carry in presence, as JSON. */
export const MAX_PEER_MEMORY_BYTES = 8192

/** The memory a worktree shares with teammates. Goal and parent ride `PeerWorktree.task` and `parentId`. */
export type PeerWorktreeMemory = {
  revision: number
  notes: PeerMemoryNote[]
  touched?: string[]
}
