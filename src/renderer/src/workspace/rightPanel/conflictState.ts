// An update stopped on conflicts, in the words the panel and the agent read: task names, not folders.

import type { AgentKind, InstalledAgent, Project, Terminal, Worktree } from '@shared/entities'
import { defaultAgentKind } from '../../dialogs/taskPlan'
import { worktreeDisplay, worktreeLabel } from '../../sidebar/worktreeDisplay'

/** This task, and what an update brings into it: the parent task, or the base branch (`main`). */
export type UpdateSides = { task: string; incoming: string }

export function updateSides(
  worktrees: readonly Worktree[],
  projects: readonly Project[],
  worktreeId: string
): UpdateSides {
  const worktree = worktrees.find((entry) => entry.id === worktreeId)
  const nameOf = (entry: Worktree | undefined): string =>
    entry === undefined ? 'this task' : worktreeLabel(worktreeDisplay(entry))
  const parent = worktrees.find((entry) => entry.id === worktree?.parentId)
  if (parent !== undefined) return { task: nameOf(worktree), incoming: nameOf(parent) }
  const base = worktree?.baseRef ?? projects.find((project) => project.id === worktree?.projectId)?.baseRef ?? 'main'
  return { task: nameOf(worktree), incoming: base.slice(base.indexOf('/') + 1) }
}

/** `Merging cart totals into payment · 2 conflicted`, or `Rebasing payment onto main · all resolved`. */
export function conflictHeadline(operation: 'rebase' | 'merge', sides: UpdateSides, conflicted: number): string {
  const what =
    operation === 'merge'
      ? `Merging ${sides.incoming} into ${sides.task}`
      : `Rebasing ${sides.task} onto ${sides.incoming}`
  return `${what} · ${conflicted === 0 ? 'all resolved' : `${conflicted} conflicted`}`
}

/** The agent's prompt: the files, what is being brought in, and how to finish without an editor. */
export function resolvePrompt(
  paths: readonly string[],
  operation: 'rebase' | 'merge' | undefined,
  sides: UpdateSides
): string {
  const files = paths.join(', ')
  const goal = 'Keep what both sides meant, leave no conflict markers, and git add each file'
  if (operation === 'rebase') {
    return `Resolve the conflicts in ${files}: ${sides.task} is being rebased onto ${sides.incoming}. ${goal}, then run GIT_EDITOR=true git rebase --continue, and do the same if it stops again.`
  }
  if (operation === 'merge') {
    return `Resolve the conflicts in ${files}: ${sides.incoming} is being merged into ${sides.task}. ${goal}, then run git commit --no-edit.`
  }
  return `Resolve the conflicts in ${files}. ${goal}.`
}

/** The running agent pane of this worktree, one started as an agent before one typed into a shell. */
export function agentPaneOf(
  terminals: Readonly<Record<string, Terminal>>,
  worktreeId: string
): { id: string; kind: NonNullable<Terminal['agent']> } | undefined {
  const panes = Object.values(terminals).filter((terminal) => terminal.worktreeId === worktreeId && terminal.running)
  const started = panes.find((terminal) => terminal.agent !== undefined)
  if (started?.agent !== undefined) return { id: started.id, kind: started.agent }
  const typed = panes.find((terminal) => terminal.foregroundAgent !== undefined)
  return typed?.foregroundAgent === undefined ? undefined : { id: typed.id, kind: typed.foregroundAgent }
}

/** Who Ask … to Resolve goes to: the worktree's running agent, else the default one started for it; null with none installed. */
export function askerOf(
  state: { terminals: Readonly<Record<string, Terminal>>; agents: readonly InstalledAgent[]; defaultAgent: string },
  worktreeId: string
): AgentKind | null {
  const running = agentPaneOf(state.terminals, worktreeId)?.kind
  if (running !== undefined) return running
  const kind = defaultAgentKind(state.agents, state.defaultAgent)
  return state.agents.find((agent) => agent.kind === kind)?.kind ?? null
}
