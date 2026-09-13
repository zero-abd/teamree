// What this runtime tells a teammate about itself, and the one rule that
// decides how much of it they get.
//
// **A peer sees a project only if their key is in that project's roster.** A
// session is pairwise and covers every repository two people happen to share,
// so a snapshot built once and sent to everybody would show a teammate on one
// repository the worktrees of another they have no part in. The roster is the
// membership list, it is already read per project, and filtering by it here is
// the same rule the handshake applies, applied once more where it decides
// visibility rather than admission.
//
// Metadata only. `docs/teamwork.md` is exact about this: names, branches, pane
// states and how long each has been quiet are automatic, and a pane's actual
// output is milestone C and flows only for a pane somebody has opened. Nothing
// in this file reads a scrollback.

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
    // Converted from an instant to a duration on the way out: the receiver's
    // clock is the only one it can trust, and a duration survives the crossing.
    quietForMs: Math.max(0, at - terminal.lastOutputAt)
  }
  if (terminal.agent !== undefined) pane.agent = terminal.agent
  if (terminal.exitCode !== undefined) pane.exitCode = terminal.exitCode
  return pane
}
