// What the composer promises before it is submitted.
//
// The dialog must never claim an agent will run when none can: on a machine
// with no agent on PATH, submitting makes a worktree and nothing else, and
// saying "Start task" there would be a lie the user only discovers afterwards.
// So the footer note and the submit button both come from here, and both are
// derived from the same three facts — whether the probe has answered, what it
// found, and how many of each the user asked for.
//
// One task can be several attempts at it, so the choice is a count per agent
// rather than one name. Everything below turns that table of counts into the
// single ordered list a submission is made of.

import { taskNamesForAgents } from '@shared/branchName'
import type { InstalledAgent } from '@shared/entities'

/** How many runs of one agent a single task may ask for. */
export const MAX_PER_AGENT = 9

/** How many of each agent to start, keyed by agent kind. */
export type AgentCounts = Readonly<Record<string, number>>

/** One worktree to create, and what to run in it. */
export type TaskCreate = {
  name: string
  /** Absent means the worktree alone. */
  agentCommand?: string
}

/** What the dialog opens with: one of the first agent found, none of the rest. */
export function defaultAgentCounts(agents: readonly InstalledAgent[]): AgentCounts {
  const first = agents[0]
  return first ? { [first.kind]: 1 } : {}
}

export function agentCount(counts: AgentCounts, kind: string): number {
  return counts[kind] ?? 0
}

/**
 * A stepper with no ceiling is a way to start fifty checkouts by leaning on a
 * key, so the count is clamped here rather than at each button.
 */
export function withAgentCount(counts: AgentCounts, kind: string, count: number): AgentCounts {
  return { ...counts, [kind]: Math.max(0, Math.min(MAX_PER_AGENT, Math.trunc(count))) }
}

/**
 * The counts, expanded into the order the worktrees are created in.
 *
 * One of each before any second one: somebody who asked for two claudes and a
 * codex wants all three racing, and taking a full round at a time means the
 * slow part — the checkout, the first prompt — starts for every agent before it
 * starts twice for one of them.
 */
export function fanOut(agents: readonly InstalledAgent[], counts: AgentCounts): InstalledAgent[] {
  const selection: InstalledAgent[] = []
  const most = Math.max(0, ...agents.map((agent) => agentCount(counts, agent.kind)))
  for (let round = 0; round < most; round += 1) {
    for (const agent of agents) {
      if (agentCount(counts, agent.kind) > round) selection.push(agent)
    }
  }
  return selection
}

/**
 * One create per selected agent, named by the shared suffix rule so the rows
 * are told apart before the runtime has allocated anything. An empty selection
 * is still one create: the worktree on its own.
 */
export function taskCreates(task: string, selection: readonly InstalledAgent[]): TaskCreate[] {
  const commands = selection.map((agent) => agent.command)
  return taskNamesForAgents(task.trim(), commands).map((name, index) => {
    const agentCommand = commands[index]
    return agentCommand === undefined ? { name } : { name, agentCommand }
  })
}

export function submitLabel(selection: readonly InstalledAgent[]): string {
  return selection.length === 0 ? 'Create worktree' : 'Start task'
}

/**
 * Exactly what the button is about to do, in one line: how many checkouts, and
 * who runs in them, in the order they are made.
 *
 * `probed` is the difference between "we have not looked yet" and "we looked
 * and there is nothing" — two states that are both an empty list, and only one
 * of which should tell someone their machine has no agent on it.
 */
export function taskPlanNote(
  agents: readonly InstalledAgent[],
  probed: boolean,
  selection: readonly InstalledAgent[]
): string {
  if (!probed) return 'Looking for coding agents…'
  // Which PATH, said out loud, because the plain word was the wrong one: the
  // app used to look on the PATH it was started with, which on a desktop launch
  // is not the user's, and somebody whose `which claude` answers in a pane had
  // no way to tell that from an agent they had not installed. Now the sentence
  // is true, and it names the one place to go and look.
  if (agents.length === 0) return 'No coding agent on your login shell’s PATH.'
  if (selection.length === 0) return '1 worktree · no agent'
  const commands = selection.map((agent) => agent.command).join(', ')
  return `${selection.length} worktree${selection.length === 1 ? '' : 's'} · ${commands}`
}
