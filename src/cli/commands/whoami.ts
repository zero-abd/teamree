// `teamree whoami`: the pane, worktree, project and parent chain a shell runs
// in, read from the pane's `TEAMREE_*` ids, or the checkout around cwd.

import type { Project, Terminal, Worktree } from '../../shared/entities.js'
import { PANE_IDENTITY_ENV } from '../../shared/tasks.js'
import type { CommandSpec } from '../command-spec.js'
import { formatFields } from '../output.js'
import { selectHere, type Caller } from '../selectors.js'

export type Whoami = {
  terminal: { id: string; title: string; label?: string; agent?: string } | null
  worktree: { id: string; name: string; branch: string; path: string }
  project: { id: string; name: string } | null
  /** Nearest first. */
  parents: Array<{ id: string; name: string; branch: string }>
}

/** Who the caller is, from listings already in hand. */
export function whoami(
  here: Caller,
  listings: { worktrees: readonly Worktree[]; projects: readonly Project[]; terminals: readonly Terminal[] }
): Whoami {
  const worktree = selectHere(listings.worktrees, here)
  const terminalId = here.env[PANE_IDENTITY_ENV.terminalId]
  const terminal = listings.terminals.find((entry) => entry.id === terminalId)
  const project = listings.projects.find((entry) => entry.id === worktree.projectId)

  const parents: Whoami['parents'] = []
  const seen = new Set([worktree.id])
  for (let at = worktree.parentId; at !== undefined && !seen.has(at); ) {
    seen.add(at)
    const parent = listings.worktrees.find((entry) => entry.id === at)
    if (parent === undefined) break
    parents.push({ id: parent.id, name: parent.name, branch: parent.branch })
    at = parent.parentId
  }

  return {
    terminal:
      terminal === undefined
        ? null
        : {
            id: terminal.id,
            title: terminal.title,
            ...(terminal.label === undefined ? {} : { label: terminal.label }),
            ...(terminal.agent === undefined ? {} : { agent: terminal.agent })
          },
    worktree: { id: worktree.id, name: worktree.name, branch: worktree.branch, path: worktree.path },
    project: project === undefined ? null : { id: project.id, name: project.name },
    parents
  }
}

export function whoamiText(me: Whoami): string {
  const pane = me.terminal
  return formatFields([
    ['pane', pane === null ? '-' : `${pane.id}  ${pane.label ?? pane.agent ?? pane.title}`],
    ['worktree', `${me.worktree.name}  ${me.worktree.id}`],
    ['branch', me.worktree.branch],
    ['project', me.project === null ? '-' : `${me.project.name}  ${me.project.id}`],
    ...(me.parents.length === 0
      ? []
      : [['parents', me.parents.map((parent) => `${parent.name} (${parent.branch})`).join(' < ')] as const]),
    ['path', me.worktree.path]
  ])
}

export const whoamiCommands: readonly CommandSpec[] = [
  {
    path: ['whoami'],
    summary: 'Show the pane, worktree, project and parent tasks this shell is in.',
    examples: ['teamree whoami', 'teamree whoami --json'],
    run: async (context) => {
      const [worktrees, projects, terminals] = await Promise.all([
        context.client.call('worktree.list', {}),
        context.client.call('project.list', {}),
        context.client.call('terminal.list', {})
      ])
      const me = whoami(context, { worktrees, projects, terminals })
      return { data: me, text: whoamiText(me) }
    }
  }
]
