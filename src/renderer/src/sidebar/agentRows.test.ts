import { describe, expect, it } from 'vitest'
import type { Terminal } from '@shared/entities'
import {
  ACTIVITY_LABEL,
  activityOf,
  agentRows,
  agoLabel,
  paneLabel,
  paneName,
  paneNames,
  sinceLabel,
  truncateName,
  watchedBy,
  worktreeActivity,
  type AgentRow
} from './agentRows'

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
  evidence: null,
  ...overrides
})

describe('activityOf', () => {
  it('is working while output is still arriving', () => {
    expect(activityOf(terminal({ id: 't', busy: true }))).toBe('working')
  })

  // The honest reading, and the fallback the other cases are measured against.
  // A pane that has stopped saying things and said nothing about why is a pane
  // this app knows nothing more about, and calling that "waiting on you" would
  // be a guess.
  it('is quiet — not "waiting for input" — when output stops with no bell and no title', () => {
    expect(activityOf(terminal({ id: 't', busy: false }))).toBe('quiet')
  })

  // The whole point. A bell is the one byte a program sends for no reason
  // except to be noticed; a bell and then silence is a pane that asked for
  // something and is sitting on the answer.
  it('is waiting when a bell rang and the pane then went quiet', () => {
    expect(activityOf(terminal({ id: 't', busy: false, lastBellAt: 1_000 }))).toBe('waiting')
  })

  // The session clears the bell when a new burst of output starts, so a bell
  // that is still set alongside `busy` rang inside the burst still running.
  it('is working while output is still arriving, bell or no bell', () => {
    expect(activityOf(terminal({ id: 't', busy: true, lastBellAt: 1_000 }))).toBe('working')
  })

  it('is waiting when the pane’s own title says so, even mid-output', () => {
    expect(activityOf(terminal({ id: 't', busy: true, titleSays: 'waiting' }))).toBe('waiting')
    expect(activityOf(terminal({ id: 't', busy: false, titleSays: 'waiting' }))).toBe('waiting')
  })

  // A long tool call prints nothing for minutes. Its title, written before the
  // silence, is the pane's own account of what it is doing in it.
  it('is working when output stopped but the title still says it is working', () => {
    expect(activityOf(terminal({ id: 't', busy: false, titleSays: 'working' }))).toBe('working')
  })

  // A title is a status the program repaints; a bell is something it did on
  // purpose, at a person. The one aimed at a person wins.
  it('lets an unanswered bell outrank a title left saying "working"', () => {
    expect(activityOf(terminal({ id: 't', busy: false, titleSays: 'working', lastBellAt: 1_000 }))).toBe('waiting')
  })

  it('says nothing about a pane that has exited, whatever it rang on the way out', () => {
    expect(activityOf(terminal({ id: 't', running: false, exitCode: 0, lastBellAt: 1_000 }))).toBe('done')
    expect(activityOf(terminal({ id: 't', running: false, exitCode: 1, titleSays: 'waiting' }))).toBe('failed')
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

  it('carries the evidence known for a pane and nothing for the rest', () => {
    const rows = agentRows([terminal({ id: 'a' }), terminal({ id: 'b' })], 'wt1', 0, { a: '766 tests passed' })
    expect(rows.map((entry) => entry.evidence)).toEqual(['766 tests passed', null])
  })

  it('has no evidence at all when none has been read yet', () => {
    expect(agentRows([terminal({ id: 'a' })], 'wt1', 0)[0]?.evidence).toBeNull()
  })
})

describe('paneName', () => {
  // The gap this whole file is about: the agent's binary is the one fact three
  // panes started on three different jobs have in common.
  it('prefers the name somebody gave the pane to the agent running in it', () => {
    expect(paneName(terminal({ id: 't', agent: 'claude', label: 'auth refactor' }))).toBe('auth refactor')
  })

  it('falls back to the agent, and then to what the pane is running', () => {
    expect(paneName(terminal({ id: 't', agent: 'claude', title: 'node' }))).toBe('claude')
    expect(paneName(terminal({ id: 't', title: 'npm test' }))).toBe('npm test')
  })

  // A pane called "   " is a pane with no name drawn as though it had one.
  it('ignores a name that is only whitespace', () => {
    expect(paneName(terminal({ id: 't', agent: 'claude', label: '   ' }))).toBe('claude')
  })
})

describe('paneNames', () => {
  it('numbers panes that would otherwise read identically', () => {
    const names = paneNames([
      terminal({ id: 'a', agent: 'claude', title: 'node' }),
      terminal({ id: 'b', agent: 'claude', title: 'node' }),
      terminal({ id: 'c', agent: 'claude', title: 'node' })
    ])

    expect(names).toEqual(['claude 1', 'claude 2', 'claude 3'])
  })

  it('leaves a name alone when nothing else in the worktree reads like it', () => {
    const names = paneNames([
      terminal({ id: 'a', agent: 'claude', title: 'node' }),
      terminal({ id: 'b', title: 'npm test' })
    ])

    expect(names).toEqual(['claude', 'npm test'])
  })

  // Numbering somebody's own words back at them would be the app overruling
  // the one thing on the row it did not make up.
  it('never numbers a name somebody typed, and counts only the unnamed', () => {
    const names = paneNames([
      terminal({ id: 'a', agent: 'claude', label: 'auth refactor' }),
      terminal({ id: 'b', agent: 'claude', label: 'auth refactor' }),
      terminal({ id: 'c', agent: 'claude', title: 'node' })
    ])

    expect(names).toEqual(['auth refactor', 'auth refactor', 'claude'])
  })
})

describe('truncateName', () => {
  it('leaves a name that fits exactly as it was typed', () => {
    expect(truncateName('auth refactor')).toBe('auth refactor')
  })

  it('cuts a longer one to the row and says it was cut', () => {
    const cut = truncateName('rewrite the pager so it streams instead of buffering', 20)
    expect(cut).toHaveLength(20)
    expect(cut.endsWith('…')).toBe(true)
  })
})

describe('agentRows naming', () => {
  it('gives two unnamed panes of the same agent an index apiece', () => {
    const rows = agentRows(
      [terminal({ id: 'a', agent: 'claude', title: 'node' }), terminal({ id: 'b', agent: 'claude', title: 'node' })],
      'wt1',
      0
    )

    expect(rows.map((entry) => entry.label)).toEqual(['claude 1', 'claude 2'])
  })

  // Only within the worktree being drawn: a pane in another one is not on this
  // row and cannot be what a reader is confusing it with.
  it('counts only the panes of the worktree it is listing', () => {
    const rows = agentRows(
      [
        terminal({ id: 'a', agent: 'claude', title: 'node' }),
        terminal({ id: 'b', agent: 'claude', title: 'node', worktreeId: 'other' })
      ],
      'wt1',
      0
    )

    expect(rows.map((entry) => entry.label)).toEqual(['claude'])
  })

  it('calls a named pane what it was named, whole', () => {
    const rows = agentRows(
      [terminal({ id: 'a', agent: 'claude', label: 'rewrite the pager so it streams instead of buffering' })],
      'wt1',
      0
    )

    expect(rows[0]?.label).toBe('rewrite the pager so it streams instead of buffering')
  })
})

describe('paneLabel', () => {
  it('keeps a title a program set for itself', () => {
    expect(paneLabel(terminal({ id: 't', title: 'npm run build' }))).toBe('npm run build')
  })

  // The one title that says nothing: it repeats the worktree the row is already
  // under, and it changes every time the shell changes directory.
  it('replaces the default shell title, which is user, host and path', () => {
    expect(paneLabel(terminal({ id: 't', title: 'root@8f2c1d: /work/rank-results' }))).toBe('bash')
    expect(paneLabel(terminal({ id: 't', title: 'ada@laptop:~', shell: '/usr/bin/zsh' }))).toBe('zsh')
  })

  it('keeps a title that only looks like the default one', () => {
    expect(paneLabel(terminal({ id: 't', title: 'deploy@staging: pushing 3 of 8' }))).toBe(
      'deploy@staging: pushing 3 of 8'
    )
  })

  it('reduces a title that is only a path to its last segment', () => {
    expect(paneLabel(terminal({ id: 't', title: '/home/ada/code/teamree/src' }))).toBe('src')
    expect(paneLabel(terminal({ id: 't', title: '~/code/teamree' }))).toBe('teamree')
    expect(paneLabel(terminal({ id: 't', title: 'C:\\Users\\ada\\code' }))).toBe('code')
  })

  it('falls back to the shell when there is no title at all', () => {
    expect(paneLabel(terminal({ id: 't', title: '   ', shell: '/bin/fish' }))).toBe('fish')
    expect(paneLabel(terminal({ id: 't', title: '', shell: 'C:\\Windows\\System32\\cmd.exe' }))).toBe('cmd')
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

  // One pane in five asking a question is the reason somebody opened this app.
  it('surfaces a pane that is asking over panes that are merely working', () => {
    expect(worktreeActivity([row({ activity: 'working' }), row({ activity: 'waiting' })])).toBe('waiting')
    expect(worktreeActivity([row({ activity: 'waiting' }), row({ activity: 'failed' })])).toBe('failed')
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

describe('who is reading a pane', () => {
  const watcher = (handle: string): { handle: string; publicKey: string; since: number } => ({
    handle,
    publicKey: `${handle}-key`,
    since: 0
  })

  it('names one reader rather than counting them', () => {
    expect(watchedBy([watcher('ana')])).toBe('ana is watching')
  })

  it('names every reader, because a count is the half that does not matter', () => {
    expect(watchedBy([watcher('ana'), watcher('bo'), watcher('cy')])).toBe('ana, bo and cy are watching')
  })

  it('says so plainly when nobody is', () => {
    expect(watchedBy([])).toBe('nobody is watching')
  })
})

describe('agoLabel', () => {
  // Every age `sinceLabel` returns composes with "ago" except the first one:
  // "last output now ago" was the sidebar's hover text for a pane that had
  // just printed.
  it('says "now" on its own and everything else with "ago"', () => {
    expect(agoLabel(3_000)).toBe('now')
    expect(agoLabel(45_000)).toBe('45s ago')
    expect(agoLabel(3 * 60_000)).toBe('3m ago')
  })
})

describe('ACTIVITY_LABEL', () => {
  // "waiting on you" and "waiting — no output" are opposites — a pane that
  // rang the bell and a pane with nothing to say — and read side by side in
  // the sidebar they started with the same word. The dashboard's nouns
  // (`asking`, `waiting`) already tell them apart; the phrases now do too.
  it('does not start the two opposite states with the same word', () => {
    const [waiting] = ACTIVITY_LABEL.waiting.split(/\s/)
    const [quiet] = ACTIVITY_LABEL.quiet.split(/\s/)
    expect(waiting).not.toBe(quiet)
    expect(ACTIVITY_LABEL.quiet).toBe('quiet — no output')
  })
})
