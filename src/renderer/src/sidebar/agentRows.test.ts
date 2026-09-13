import { describe, expect, it } from 'vitest'
import type { Terminal } from '@shared/entities'
import { activityOf, agentRows, sinceLabel, worktreeActivity, type AgentRow } from './agentRows'

function terminal(overrides: Partial<Terminal> & { id: string }): Terminal {
  return {
    worktreeId: 'wt1',
    title: 'bash',
    cwd: '/checkouts/wt1',
    shell: '/bin/bash',
    cols: 80,
    rows: 24,
    running: true,
    busy: false,
    lastOutputAt: 0,
    ...overrides
  }
}

const row = (overrides: Partial<AgentRow> = {}): AgentRow => ({
  terminalId: 't',
  agent: undefined,
  label: 'bash',
  activity: 'quiet',
  quietFor: 0,
  ...overrides
})

describe('activityOf', () => {
  it('is working while output is still arriving', () => {
    expect(activityOf(terminal({ id: 't', busy: true }))).toBe('working')
  })

  // The honest reading. Teamree watches a PTY, not an agent's protocol: a pane
  // that has stopped saying things is what waiting looks like from outside, and
  // calling it anything more specific would be a guess.
  it('is quiet — not "waiting for input" — when output stops', () => {
    expect(activityOf(terminal({ id: 't', busy: false }))).toBe('quiet')
  })

  it('separates a clean finish from a failure', () => {
    expect(activityOf(terminal({ id: 't', running: false, exitCode: 0 }))).toBe('done')
    expect(activityOf(terminal({ id: 't', running: false, exitCode: 1 }))).toBe('failed')
  })

  it('treats a death with no code at all as a failure', () => {
    expect(activityOf(terminal({ id: 't', running: false }))).toBe('failed')
  })
})

describe('agentRows', () => {
  it('takes only this worktree’s panes', () => {
    const rows = agentRows(
      [terminal({ id: 'a' }), terminal({ id: 'b', worktreeId: 'other' }), terminal({ id: 'c' })],
      'wt1',
      0
    )

    expect(rows.map((entry) => entry.terminalId)).toEqual(['a', 'c'])
  })

  it('labels an agent pane by its agent and a shell by its title', () => {
    const rows = agentRows(
      [terminal({ id: 'a', agent: 'claude', title: 'node' }), terminal({ id: 'b', title: 'npm test' })],
      'wt1',
      0
    )

    expect(rows.map((entry) => entry.label)).toEqual(['claude', 'npm test'])
  })

  // A build somebody left running is as likely to want attention as an agent,
  // and hiding it would make the row disagree with what is actually open.
  it('keeps plain shells, not only agents', () => {
    expect(agentRows([terminal({ id: 'a' })], 'wt1', 0)).toHaveLength(1)
  })

  it('measures the silence from the last output', () => {
    const rows = agentRows([terminal({ id: 'a', lastOutputAt: 1000 })], 'wt1', 61_000)
    expect(rows[0]?.quietFor).toBe(60_000)
  })

  it('never reports a negative silence when the clocks disagree', () => {
    expect(agentRows([terminal({ id: 'a', lastOutputAt: 5000 })], 'wt1', 1000)[0]?.quietFor).toBe(0)
  })
})

describe('worktreeActivity', () => {
  it('says nothing for a worktree with no panes', () => {
    expect(worktreeActivity([])).toBeNull()
  })

  // A failure is finished and wrong; work in progress is merely unfinished.
  it('puts a failure above work in progress', () => {
    expect(worktreeActivity([row({ activity: 'working' }), row({ activity: 'failed' })])).toBe('failed')
  })

  it('puts work in progress above waiting', () => {
    expect(worktreeActivity([row({ activity: 'quiet' }), row({ activity: 'working' })])).toBe('working')
  })

  it('is done only when everything is', () => {
    expect(worktreeActivity([row({ activity: 'done' }), row({ activity: 'done' })])).toBe('done')
    expect(worktreeActivity([row({ activity: 'done' }), row({ activity: 'quiet' })])).toBe('quiet')
  })
})

describe('sinceLabel', () => {
  it('says "now" while it is still effectively now', () => {
    expect(sinceLabel(0)).toBe('now')
    expect(sinceLabel(9_000)).toBe('now')
  })

  it('steps up through the units', () => {
    expect(sinceLabel(42_000)).toBe('42s')
    expect(sinceLabel(90_000)).toBe('1m')
    expect(sinceLabel(3 * 3_600_000)).toBe('3h')
    expect(sinceLabel(50 * 3_600_000)).toBe('2d')
  })

  // Rounding up would read as less stale than it is, which is backwards for a
  // number whose whole job is to say something has been sitting there.
  it('rounds down, so it never flatters the silence', () => {
    expect(sinceLabel(119_000)).toBe('1m')
  })
})
