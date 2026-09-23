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

/** The kind that stands for "no agent": nothing installed, or nothing preferred. */
export const NO_AGENT = ''

/** The installed agent of this kind, or null when this machine has no such agent. */
export function agentByKind(agents: readonly InstalledAgent[], kind: string): InstalledAgent | null {
  return agents.find((agent) => agent.kind === kind) ?? null
}

/** How many of each agent to start, keyed by agent kind. */
export type AgentCounts = Readonly<Record<string, number>>

/** One worktree to create, and what to run in it. */
export type TaskCreate = {
  name: string
  /** Absent means the worktree alone. */
  agentCommand?: string
  /** The description as typed: the agent's first prompt, and the worktree's record of what it is for. */
  task: string
}

/** The most characters a task's name keeps; see `taskName`. */
export const MAX_TASK_NAME_CHARS = 32

/**
 * What a task is called: the start of its first line.
 *
 * The rest is for the agent. A row, a tab and the status bar each have a few
 * words' room to say which task this is, and a whole sentence there pushed
 * the branch and the shortcuts off the end of the window. So the name is the
 * first line, cut at a word boundary to fit, with any punctuation the cut
 * leaves dangling taken off — the branch is a slug of this, and `fix-login.`
 * is nobody's branch. A word longer than the room is cut mid-word rather than
 * dropped, because a name has to be something.
 */
export function taskName(task: string, max = MAX_TASK_NAME_CHARS): string {
  const line = task.trim().split('\n', 1)[0]?.trim() ?? ''
  const characters = Array.from(line)
  let name = line
  if (characters.length > max) {
    const room = characters.slice(0, max + 1).join('')
    const boundary = room.search(/\s\S*$/u)
    name = boundary > 0 ? room.slice(0, boundary) : characters.slice(0, max).join('')
  }
  return name.replace(/[\s.,;:!?…\-–—]+$/u, '')
}

/**
 * What the dialog opens with: one of the agent this machine's owner said they
 * always use, when it is installed — otherwise one of the first agent found,
 * which is the rule this had before there was anywhere to say otherwise — and
 * none of the rest. A preference naming an agent that is not on this machine
 * is not an error and is not reported as one: the same preference follows
 * somebody between a laptop that has codex and a desktop that does not, and
 * the honest answer on the desktop is the first agent it has.
 */
export function defaultAgentCounts(agents: readonly InstalledAgent[], preferred?: string): AgentCounts {
  const kind = defaultAgentKind(agents, preferred)
  return kind === NO_AGENT ? {} : { [kind]: 1 }
}

/** The agent kind the dialog opens with; see `defaultAgentCounts`. */
export function defaultAgentKind(agents: readonly InstalledAgent[], preferred?: string): string {
  if (preferred !== undefined && preferred !== NO_AGENT && agentByKind(agents, preferred)) return preferred
  return agents[0]?.kind ?? NO_AGENT
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
  const text = task.trim()
  return taskNamesForAgents(taskName(text), commands).map((name, index) => {
    const agentCommand = commands[index]
    return agentCommand === undefined ? { name, task: text } : { name, agentCommand, task: text }
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
