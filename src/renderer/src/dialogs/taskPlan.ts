// What the composer promises before submit: the footer and button never claim an agent will run when
// none can. The choice is a count per agent, turned here into the ordered list a submission is made of.

import { taskNamesForAgents } from '@shared/branchName'
import type { InstalledAgent } from '@shared/entities'
import { harnessName } from '../agents/harnesses'

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
  /** A branch named by hand; absent, the runtime makes one from `name`. */
  branch?: string
}

/** The most characters a task's name keeps; see `taskName`. */
export const MAX_TASK_NAME_CHARS = 32

/** Words a cut name may not end on: `add-a-subtract-function-to` reads as a mistake. */
const DANGLING_WORDS = /(?:\s+(?:a|an|and|for|in|of|the|to))+$/iu

/**
 * What a task is called: its first line, cut at a word boundary with dangling punctuation and small
 * words dropped (the branch is a slug of it). A word longer than the room is cut mid-word.
 */
export function taskName(task: string, max = MAX_TASK_NAME_CHARS): string {
  const { name, atWord } = cutFirstLine(task, max)
  // An uncut "Log in" keeps its last word; only the cut leaves one dangling.
  return atWord ? trimPunctuation(name.replace(DANGLING_WORDS, '')) : name
}

/** Every name a task's worktree may carry: `taskName`'s, and the one made before small words were dropped. */
export function taskNames(task: string): string[] {
  const earlier = cutFirstLine(task, MAX_TASK_NAME_CHARS).name
  const name = taskName(task)
  return name === earlier ? [name] : [name, earlier]
}

function cutFirstLine(task: string, max: number): { name: string; atWord: boolean } {
  const line = task.trim().split('\n', 1)[0]?.trim() ?? ''
  const characters = Array.from(line)
  if (characters.length <= max) return { name: trimPunctuation(line), atWord: false }
  const room = characters.slice(0, max + 1).join('')
  const boundary = room.search(/\s\S*$/u)
  if (boundary <= 0) return { name: trimPunctuation(characters.slice(0, max).join('')), atWord: false }
  return { name: trimPunctuation(room.slice(0, boundary)), atWord: true }
}

function trimPunctuation(name: string): string {
  return name.replace(/[\s.,;:!?…\-–—]+$/u, '')
}

/**
 * One of the preferred agent when installed, else one of the first found. A preference for an agent
 * not on this machine is not an error: it follows people between machines.
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

/** Clamped here, not at each button: an unbounded stepper starts fifty checkouts. */
export function withAgentCount(counts: AgentCounts, kind: string, count: number): AgentCounts {
  return { ...counts, [kind]: Math.max(0, Math.min(MAX_PER_AGENT, Math.trunc(count))) }
}

/** The counts expanded into creation order: one of each before any second, so every agent starts early. */
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
 * One create per selected agent, named by the shared suffix rule; an empty selection is the worktree alone.
 * A `branch` named by hand is suffixed the same way, `pager-codex`, so several runs never ask for one branch.
 */
export function taskCreates(task: string, selection: readonly InstalledAgent[], branch = ''): TaskCreate[] {
  const commands = selection.map((agent) => agent.command)
  const text = task.trim()
  const branches = branch === '' ? [] : taskNamesForAgents(branch, commands).map((each) => each.replaceAll(' ', '-'))
  return taskNamesForAgents(taskName(text), commands).map((name, index) => {
    const agentCommand = commands[index]
    const named = branches[index]
    return {
      name,
      ...(agentCommand === undefined ? {} : { agentCommand }),
      task: text,
      ...(named === undefined ? {} : { branch: named })
    }
  })
}

export function submitLabel(selection: readonly InstalledAgent[]): string {
  return selection.length === 0 ? 'Create Worktree' : 'Start Task'
}

/** What the button will do, in one line; `probed` separates "not looked yet" from "found nothing". */
export function taskPlanNote(
  agents: readonly InstalledAgent[],
  probed: boolean,
  selection: readonly InstalledAgent[]
): string {
  if (!probed) return 'Looking for coding agents…'
  // Names which PATH: the login shell's, so `which claude` in a pane is the check to run.
  if (agents.length === 0) return 'No coding agent on your login shell’s PATH'
  if (selection.length === 0) return '1 worktree · no agent'
  const names = selection.map((agent) => harnessName(agent.kind)).join(', ')
  return `${selection.length} worktree${selection.length === 1 ? '' : 's'} · ${names}`
}
