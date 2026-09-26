// What this runtime tells a teammate about itself. A peer sees a project only if their key is in that
// project's roster: a session covers every repository two people share, and an unfiltered snapshot would
// show worktrees of a repository they have no part in. Metadata only; nothing here reads a scrollback.

import type { PeerPane, PeerPresence, PeerProject, PeerWorktree, Terminal, Worktree } from '../../../shared/entities'
import { MAX_PEER_PATHS, PEER_REPORT_CHARS, PEER_TASK_CHARS } from '../../../shared/presenceExtras'
import type { TaskStage } from '../../../shared/tasks'
import { pathsWithin } from '../../store/teammateCache'
import type { TaskGitDetails } from './presenceDetails'

/** Only the sliver of the workspace this needs, so a test can hand it two arrays. */
export type PresenceSource = {
  /** Projects this runtime tracks, already resolved to a key and a roster. */
  projects: () => readonly PresenceProject[]
  worktrees: (projectId: string) => readonly Worktree[]
  terminals: (worktreeId: string) => readonly Terminal[]
  /** What git last said about a worktree; absent until it has been read. */
  details?: (worktreeId: string) => TaskGitDetails | undefined
}

export type PresenceProject = {
  projectId: string
  /** Undefined when the repository cannot be matched across machines at all. */
  projectKey: string | undefined
  /** Base64 public keys from `.teamree/members`, this runtime's own included. */
  rosterKeys: readonly string[]
}

export type PresenceOptions = {
  source: PresenceSource
  now?: () => number
  /** Settings › Teamwork › Share Task Details. Off, only v1 goes out. */
  taskDetails?: boolean
}

/**
 * The snapshot for one teammate, identified by the key their handshake
 * authenticated — never by anything they claimed in a message.
 */
export function presenceFor(
  options: PresenceOptions,
  peerPublicKey: string,
  handle: string | null,
  revision: number
): PeerPresence {
  const now = options.now ?? Date.now
  const at = now()

  const projects: PeerProject[] = []
  for (const project of options.source.projects()) {
    if (project.projectKey === undefined) continue
    if (!project.rosterKeys.includes(peerPublicKey)) continue
    projects.push({
      projectKey: project.projectKey,
      worktrees: options.source.worktrees(project.projectId).map((worktree) => {
        const terminals = options.source.terminals(worktree.id)
        const described = describeWorktree(worktree, terminals, at)
        return options.taskDetails === true
          ? withTaskDetails(described, worktree, terminals, options.source.details?.(worktree.id))
          : described
      })
    })
  }

  return { revision, handle, projects }
}

// Read off the terminals, never the layout, so a teammate hears nothing of a file pane.
function describeWorktree(worktree: Worktree, terminals: readonly Terminal[], at: number): PeerWorktree {
  return {
    id: worktree.id,
    name: worktree.name,
    branch: worktree.branch,
    state: worktree.state,
    panes: terminals.map((terminal) => describePane(terminal, at))
  }
}

// Presence v2. `memory` stays unsent until graph memory has a verdict.
function withTaskDetails(
  described: PeerWorktree,
  worktree: Worktree,
  terminals: readonly Terminal[],
  details: TaskGitDetails | undefined
): PeerWorktree {
  const extended = { ...described }
  const task = worktree.task?.split('\n').find((line) => line.trim() !== '')
  if (task !== undefined) extended.task = task.trim().slice(0, PEER_TASK_CHARS)
  if (worktree.parentId !== undefined) extended.parentId = worktree.parentId
  if (details !== undefined) {
    extended.paths = pathsWithin(details.paths.slice(0, MAX_PEER_PATHS))
    extended.ahead = details.ahead
  }
  const stage = stageOf(worktree, terminals, details)
  if (stage !== undefined) extended.stage = stage
  if (worktree.report !== undefined) {
    extended.report = { outcome: worktree.report.outcome, summary: firstSentence(worktree.report.summary) }
  }
  return extended
}

/** 128's words from what this machine sees: a report, the panes, then git. */
function stageOf(
  worktree: Worktree,
  terminals: readonly Terminal[],
  details: TaskGitDetails | undefined
): TaskStage | undefined {
  if (worktree.report !== undefined) return worktree.report.outcome === 'failed' ? 'failed' : 'done'
  if (worktree.state === 'failed') return 'failed'
  const agents = terminals.filter((terminal) => terminal.running && (terminal.agent ?? terminal.foregroundAgent))
  const asking = (terminal: Terminal): boolean =>
    terminal.screenMenu !== undefined || terminal.screenSays === 'waiting' || terminal.titleSays === 'waiting'
  if (agents.some(asking)) return 'asking'
  if (terminals.some((terminal) => terminal.running && terminal.busy)) return 'working'
  if (details !== undefined && details.clean && details.ahead > 0) return 'ready'
  return agents.length > 0 ? 'stopped' : undefined
}

function firstSentence(summary: string): string {
  const text = summary.trim()
  const end = /[.!?](\s|$)|\n/u.exec(text)
  return (end === null ? text : text.slice(0, end.index + (end[0] === '\n' ? 0 : 1))).slice(0, PEER_REPORT_CHARS)
}

function describePane(terminal: Terminal, at: number): PeerPane {
  const pane: PeerPane = {
    id: terminal.id,
    title: terminal.title,
    shell: terminal.shell,
    running: terminal.running,
    busy: terminal.busy,
    // The owner's dimensions, sent and never asked for: a reader that could change them would be resizing a pty.
    cols: terminal.cols,
    rows: terminal.rows,
    // A duration rather than an instant: the receiver's clock is the only one it can trust.
    quietForMs: Math.max(0, at - terminal.lastOutputAt)
  }
  if (terminal.label !== undefined) pane.label = terminal.label
  if (terminal.ordinal !== undefined) pane.ordinal = terminal.ordinal
  if (terminal.agent !== undefined) pane.agent = terminal.agent
  if (terminal.exitCode !== undefined) pane.exitCode = terminal.exitCode
  return pane
}
