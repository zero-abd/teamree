import { describe, expect, it } from 'vitest'
import type { InstalledAgent } from '@shared/entities'
import {
  agentCount,
  defaultAgentCounts,
  fanOut,
  MAX_PER_AGENT,
  submitLabel,
  taskCreates,
  taskPlanNote,
  withAgentCount
} from './taskPlan'

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
      { name: 'Rewrite the pager', agentCommand: 'claude' },
      { name: 'Rewrite the pager codex', agentCommand: 'codex' },
      { name: 'Rewrite the pager claude 2', agentCommand: 'claude' }
    ])
  })

  it('makes one bare create when no agent was asked for', () => {
    expect(taskCreates('  Rewrite the pager  ', [])).toEqual([{ name: 'Rewrite the pager' }])
  })
})

describe('what the dialog promises', () => {
  // The button must not say "Start task" when submitting starts nothing.
  it('offers to start a task only when something will run', () => {
    expect(submitLabel([claude])).toBe('Start task')
    expect(submitLabel([])).toBe('Create worktree')
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
    expect(taskPlanNote([], true, [])).toBe('No coding agent on your login shell’s PATH.')
  })

  // The probe having answered says nothing about the answer being non-empty.
  it('does not promise a worktree count on a machine that has none', () => {
    expect(taskPlanNote([], true, [])).not.toContain('worktree')
  })
})
