// What this runtime tells a teammate about itself. A peer sees a project only if their key is in that
// project's roster: a session covers every repository two people share, and an unfiltered snapshot would
// show worktrees of a repository they have no part in. Metadata only; nothing here reads a scrollback.

import type { PeerPane, PeerPresence, PeerProject, PeerWorktree, Terminal, Worktree } from '../../../shared/entities'

/** Only the sliver of the workspace this needs, so a test can hand it two arrays. */
export type PresenceSource = {
  /** Projects this runtime tracks, already resolved to a key and a roster. */
  projects: () => readonly PresenceProject[]
  worktrees: (projectId: string) => readonly Worktree[]
  terminals: (worktreeId: string) => readonly Terminal[]
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
      worktrees: options.source
        .worktrees(project.projectId)
        .map((worktree) => describeWorktree(worktree, options.source.terminals(worktree.id), at))
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
  if (terminal.agent !== undefined) pane.agent = terminal.agent
  if (terminal.exitCode !== undefined) pane.exitCode = terminal.exitCode
  return pane
}
