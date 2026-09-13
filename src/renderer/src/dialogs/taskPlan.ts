// What the composer promises before it is submitted.
//
// The dialog must never claim an agent will run when none can: on a machine
// with no agent on PATH, submitting makes a worktree and nothing else, and
// saying "Start task" there would be a lie the user only discovers afterwards.
// So the footer note and the submit button both come from here, and both are
// derived from the same three facts — whether the probe has answered, what it
// found, and which of those the user picked.

import type { InstalledAgent } from '@shared/entities'

/** The agent field's value when the user wants the worktree on its own. */
export const NO_AGENT = ''

export function agentByKind(agents: readonly InstalledAgent[], kind: string): InstalledAgent | null {
  return agents.find((agent) => agent.kind === kind) ?? null
}

/** The agent selected when the dialog opens: the first one found, if any. */
export function defaultAgentKind(agents: readonly InstalledAgent[]): string {
  return agents[0]?.kind ?? NO_AGENT
}

export function submitLabel(agent: InstalledAgent | null): string {
  return agent ? 'Start task' : 'Create worktree'
}

/**
 * `probed` is the difference between "we have not looked yet" and "we looked
 * and there is nothing" — two states that are both an empty list, and only one
 * of which should tell someone their machine has no agent on it.
 */
export function taskPlanNote(agents: readonly InstalledAgent[], probed: boolean, agent: InstalledAgent | null): string {
  if (!probed) return 'Looking for coding agents…'
  // Which PATH, said out loud, because the plain word was the wrong one: the
  // app used to look on the PATH it was started with, which on a desktop launch
  // is not the user's, and somebody whose `which claude` answers in a pane had
  // no way to tell that from an agent they had not installed. Now the sentence
  // is true, and it names the one place to go and look.
  if (agents.length === 0)
    return 'No coding agent on the PATH your login shell sets, so this creates the worktree alone.'
  return agent
    ? `Creates the worktree, then runs ${agent.command} in it.`
    : 'Creates the worktree, with no agent in it.'
}
