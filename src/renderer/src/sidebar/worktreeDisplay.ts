// What a worktree is called, on every surface: the sidebar, the strip, the pane header, the status
// bar, the board, the palette, their tooltips and accessible names. Nothing else reads `name` to show it.

import { slugifyBranchName } from '@shared/branchName'
import type { AgentKind, InstalledAgent, Worktree } from '@shared/entities'
import { HARNESSES } from '../agents/harnesses'
import { taskName, taskNames } from '../dialogs/taskPlan'

export type WorktreeNameSource = Pick<Worktree, 'name' | 'branch' | 'task'>

export type WorktreeDisplay = {
  /** The run's agent, when the worktree is one of a task's runs, e.g. `claude 2`; `kind` draws its glyph. */
  agent?: { text: string; kind?: AgentKind }
  /** The task's first line, whole; the name when there is no task, or the name says something else. */
  title: string
  /** Absent when it is only the name or the title slugified. */
  branch?: string
}

/** Which words name an agent: every kind, and the command each installed agent runs as. */
export function agentWords(installed: readonly InstalledAgent[]): (word: string) => AgentKind | undefined {
  const commands = new Map(installed.map((agent) => [agent.command, agent.kind]))
  return (word) => agentKind(word) ?? commands.get(word)
}

function agentKind(word: string): AgentKind | undefined {
  return Object.hasOwn(HARNESSES, word) ? (word as AgentKind) : undefined
}

/**
 * Undoes `taskNamesForAgents` from the task alone, or from a word naming an agent after a CLI-given
 * name; `kindOf` only picks the glyph, so every surface splits alike.
 */
export function worktreeDisplay(
  worktree: WorktreeNameSource,
  kindOf: (word: string) => AgentKind | undefined = agentKind
): WorktreeDisplay {
  const name = worktree.name.trim()
  const task = worktree.task?.trim() ?? ''
  const named = task === '' ? [] : taskNames(task)
  const run = named.length === 0 || named.includes(name) ? null : taskRun(name)
  const display: WorktreeDisplay = { title: name }
  if (named.includes(name) || (run !== null && named.includes(run.base))) display.title = taskName(task, Infinity)
  else if (run !== null && agentKind(run.word) !== undefined) display.title = run.base
  if (run !== null && display.title !== name) display.agent = runAgent(run, kindOf)
  if (worktree.branch !== slugifyBranchName(name) && worktree.branch !== slugifyBranchName(display.title)) {
    display.branch = worktree.branch
  }
  return display
}

type TaskRun = { base: string; word: string; text: string }

/** `name agent` or `name agent 2`, as `taskNamesForAgents` writes them. */
function taskRun(name: string): TaskRun | null {
  for (const shape of [/^(.*\S)\s+(\S+)\s+(\d+)$/u, /^(.*\S)\s+(\S+)()$/u]) {
    const [, base, word, nth] = shape.exec(name) ?? []
    if (base !== undefined && word !== undefined) return { base, word, text: nth ? `${word} ${nth}` : word }
  }
  return null
}

function runAgent(
  run: TaskRun,
  kindOf: (word: string) => AgentKind | undefined
): NonNullable<WorktreeDisplay['agent']> {
  const kind = kindOf(run.word)
  return kind === undefined ? { text: run.text } : { text: run.text, kind }
}

/** The display on one line: `claude · Add a subtract function`; pass `, ` for an accessible name. */
export function worktreeLabel(display: WorktreeDisplay, between: string = ' · '): string {
  return display.agent === undefined ? display.title : `${display.agent.text}${between}${display.title}`
}

/** A pane labelled with its worktree's name, as a task's agent is, goes by the worktree's title. */
export function paneInWorktree<P extends { label?: string }>(pane: P, worktree: WorktreeNameSource | undefined): P {
  if (worktree === undefined || pane.label === undefined || pane.label.trim() !== worktree.name.trim()) return pane
  return { ...pane, label: worktreeDisplay(worktree).title }
}
