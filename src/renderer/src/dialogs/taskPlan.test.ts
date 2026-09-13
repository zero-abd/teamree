import { describe, expect, it } from 'vitest'
import type { InstalledAgent } from '@shared/entities'
import { agentByKind, defaultAgentKind, NO_AGENT, submitLabel, taskPlanNote } from './taskPlan'

const claude: InstalledAgent = { kind: 'claude', command: 'claude', binary: '/usr/local/bin/claude' }
const codex: InstalledAgent = { kind: 'codex', command: 'codex', binary: '/opt/bin/codex' }
const found = [claude, codex]

describe('picking the agent', () => {
  it('preselects the first one found', () => {
    expect(defaultAgentKind(found)).toBe('claude')
  })

  it('preselects no agent when the machine has none', () => {
    expect(defaultAgentKind([])).toBe(NO_AGENT)
  })

  it('resolves a choice back to the agent that will run', () => {
    expect(agentByKind(found, 'codex')).toEqual(codex)
  })

  it('resolves the no-agent choice to nothing, rather than to the first one', () => {
    expect(agentByKind(found, NO_AGENT)).toBeNull()
  })
})

describe('what the dialog promises', () => {
  // The button must not say "Start task" when submitting starts nothing.
  it('offers to start a task only when something will run', () => {
    expect(submitLabel(claude)).toBe('Start task')
    expect(submitLabel(null)).toBe('Create worktree')
  })

  it('names the command it is going to run', () => {
    expect(taskPlanNote(found, true, claude)).toBe('Creates the worktree, then runs claude in it.')
  })

  it('says the worktree comes alone when the user asked for that', () => {
    expect(taskPlanNote(found, true, null)).toBe('Creates the worktree, with no agent in it.')
  })

  // Two states that are both an empty list, and only one of which should tell
  // someone their machine has no agent on it.
  it('separates "not asked yet" from "none installed"', () => {
    expect(taskPlanNote([], false, null)).toBe('Looking for coding agents…')
    expect(taskPlanNote([], true, null)).toBe(
      'No coding agent on the PATH your login shell sets, so this creates the worktree alone.'
    )
  })

  // The probe having answered says nothing about the answer being non-empty.
  it('does not promise an agent on a machine that has none', () => {
    expect(taskPlanNote([], true, null)).not.toContain('then runs')
  })
})
