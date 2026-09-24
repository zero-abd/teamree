import { describe, expect, it } from 'vitest'
import type { InstalledAgent } from '@shared/entities'
import {
  agentByKind,
  agentCount,
  defaultAgentCounts,
  defaultAgentKind,
  fanOut,
  MAX_PER_AGENT,
  NO_AGENT,
  submitLabel,
  taskCreates,
  taskName,
  taskPlanNote,
  withAgentCount
} from './taskPlan'
import { branchNameFromTask } from './branchNameFromTask'

const claude: InstalledAgent = { kind: 'claude', command: 'claude', binary: '/usr/local/bin/claude' }
const codex: InstalledAgent = { kind: 'codex', command: 'codex', binary: '/opt/bin/codex' }
const found = [claude, codex]

describe('how many of each agent', () => {
  it('opens with one of the first one found and none of the rest', () => {
    const counts = defaultAgentCounts(found)
    expect(agentCount(counts, 'claude')).toBe(1)
    expect(agentCount(counts, 'codex')).toBe(0)
  })

  it('asks for nothing on a machine with no agent', () => {
    expect(fanOut([], defaultAgentCounts([]))).toEqual([])
  })

  it('will not step below none or above the ceiling', () => {
    const counts = defaultAgentCounts(found)
    expect(agentCount(withAgentCount(counts, 'claude', -1), 'claude')).toBe(0)
    expect(agentCount(withAgentCount(counts, 'claude', 99), 'claude')).toBe(MAX_PER_AGENT)
  })
})

describe('the order the worktrees are made in', () => {
  it('takes one of each before a second of any', () => {
    const counts = withAgentCount(defaultAgentCounts(found), 'claude', 2)
    expect(fanOut(found, counts).map((agent) => agent.command)).toEqual(['claude', 'claude'])
    expect(fanOut(found, withAgentCount(counts, 'codex', 1)).map((agent) => agent.command)).toEqual([
      'claude',
      'codex',
      'claude'
    ])
  })
})

describe('the plan the dialog submits', () => {
  // The whole point of the change: one description, several attempts at it.
  it('makes one create per selection, each with its own name and its agent', () => {
    expect(taskCreates('Rewrite the pager', [claude, codex, claude])).toEqual([
      { name: 'Rewrite the pager claude', agentCommand: 'claude', task: 'Rewrite the pager' },
      { name: 'Rewrite the pager codex', agentCommand: 'codex', task: 'Rewrite the pager' },
      { name: 'Rewrite the pager claude 2', agentCommand: 'claude', task: 'Rewrite the pager' }
    ])
  })

  // A row, a tab and the status bar have room for a few words, and a sentence
  // there pushed the branch and the shortcuts off the end of the window.
  it.each([
    ['Make the pager stream', 'Make the pager stream'],
    ['Make the pager stream progress to the sidebar', 'Make the pager stream progress'],
    ['Fix the login form; it posts twice.', 'Fix the login form; it posts'],
    ['Fix login.', 'Fix login'],
    ['Why does the pager buffer everything?', 'Why does the pager buffer'],
    ['Zeichenkette für die Übersetzung des Menüs überarbeiten', 'Zeichenkette für die Übersetzung'],
    ['🚀 Ship the pager rewrite before the demo on Friday', '🚀 Ship the pager rewrite before'],
    ['a'.repeat(40), 'a'.repeat(32)],
    ['First line only\nThe second line is for the agent', 'First line only'],
    ['  padded  ', 'padded'],
    ['Add a subtract function to src/math.ts', 'Add a subtract function'],
    ['Put the new save button in the corner', 'Put the new save button'],
    ['Log in', 'Log in']
  ])('names %j %j', (task, name) => {
    expect(taskName(task)).toBe(name)
    expect(Array.from(taskName(task)).length).toBeLessThanOrEqual(32)
  })

  it('never leaves a cut branch ending in a small word', () => {
    expect(branchNameFromTask(taskName('Add a subtract function to src/math.ts'))).toBe('add-a-subtract-function')
  })

  // The description is the agent's first prompt, and the name is only what the
  // row is called. A create that carried the name alone left every agent
  // started bare, in a checkout named after work it had never been told about.
  it('carries the description whole, and the name derived from it', () => {
    const task = 'Make the pager stream\n\nIt buffers the whole file today.'
    const [create] = taskCreates(task, [claude])
    expect(create?.task).toBe(task)
    expect(create?.name).toBe('Make the pager stream')
  })
})

describe('the agent the dialog opens with', () => {
  it('gives the preferred agent the one count', () => {
    expect(defaultAgentCounts(found, 'codex')).toEqual({ codex: 1 })
    expect(defaultAgentCounts([claude], 'codex')).toEqual({ claude: 1 })
  })

  // The gap this closes: the composer used to offer whichever agent the probe
  // happened to find first, which is alphabetical order dressed up as a choice.
  it('preselects the agent this machine’s owner said they always use', () => {
    expect(defaultAgentKind(found, 'codex')).toBe('codex')
  })

  // A preference travels between machines in somebody's head, and the machines
  // do not have to agree about what is installed. The honest answer on the one
  // without it is the rule that was there before.
  it('falls back to the first one found when the preferred agent is not installed here', () => {
    expect(defaultAgentKind([claude], 'codex')).toBe('claude')
    expect(defaultAgentKind([], 'codex')).toBe(NO_AGENT)
  })

  it('treats no preference as no preference', () => {
    expect(defaultAgentKind(found, NO_AGENT)).toBe('claude')
  })

  it('resolves a choice back to the agent that will run', () => {
    expect(agentByKind(found, 'codex')).toEqual(codex)
  })

  it('makes one bare create when no agent was asked for', () => {
    expect(taskCreates('  Rewrite the pager  ', [])).toEqual([{ name: 'Rewrite the pager', task: 'Rewrite the pager' }])
  })
})

describe('what the dialog promises', () => {
  // The button must not say "Start Task" when submitting starts nothing.
  it('offers to start a task only when something will run', () => {
    expect(submitLabel([claude])).toBe('Start Task')
    expect(submitLabel([])).toBe('Create Worktree')
  })

  it('counts the worktrees and names what runs in each, in order', () => {
    expect(taskPlanNote(found, true, [claude])).toBe('1 worktree · claude')
    expect(taskPlanNote(found, true, [claude, codex, claude])).toBe('3 worktrees · claude, codex, claude')
  })

  it('says the worktree comes alone when the user asked for that', () => {
    expect(taskPlanNote(found, true, [])).toBe('1 worktree · no agent')
  })

  // Two states that are both an empty list, and only one of which should tell
  // someone their machine has no agent on it.
  it('separates "not asked yet" from "none installed"', () => {
    expect(taskPlanNote([], false, [])).toBe('Looking for coding agents…')
    expect(taskPlanNote([], true, [])).toBe('No coding agent on your login shell’s PATH')
  })

  // The probe having answered says nothing about the answer being non-empty.
  it('does not promise a worktree count on a machine that has none', () => {
    expect(taskPlanNote([], true, [])).not.toContain('worktree')
  })
})
