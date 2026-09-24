import { describe, expect, it } from 'vitest'
import type { Terminal } from '@shared/entities'
import {
  activityOf,
  paneAgent,
  paneCount,
  TONE_LABEL,
  TONES_BY_ATTENTION,
  dotClass,
  dotTone,
  agentRows,
  agoLabel,
  paneLabel,
  paneName,
  paneNames,
  paneText,
  sinceLabel,
  truncateName,
  watchedBy,
  worktreeActivity,
  worktreeTone,
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
  text: 'bash',
  activity: 'quiet',
  quietFor: 0,
  evidence: null,
  ...overrides
})

describe('activityOf', () => {
  it('is working while output is still arriving', () => {
    expect(activityOf(terminal({ id: 't', agent: 'claude', busy: true }))).toBe('working')
  })

  // A pane that stopped saying things and said nothing about why is one this
  // app knows nothing more about; "waiting on you" would be a guess.
  it('is quiet — not "waiting for input" — when output stops with no bell and no title', () => {
    expect(activityOf(terminal({ id: 't', agent: 'claude', busy: false }))).toBe('quiet')
  })

  // A bell is the one byte a program sends for no reason except to be noticed.
  it('is waiting when a bell rang and the pane then went quiet', () => {
    expect(activityOf(terminal({ id: 't', agent: 'claude', busy: false, lastBellAt: 1_000 }))).toBe('waiting')
  })

  // The session clears the bell when a new burst starts, so a bell set
  // alongside `busy` rang inside the burst still running.
  it('is working while output is still arriving, bell or no bell', () => {
    expect(activityOf(terminal({ id: 't', agent: 'claude', busy: true, lastBellAt: 1_000 }))).toBe('working')
  })

  it('is waiting when the pane’s own title says so, even mid-output', () => {
    expect(activityOf(terminal({ id: 't', agent: 'claude', busy: true, titleSays: 'waiting' }))).toBe('waiting')
    expect(activityOf(terminal({ id: 't', agent: 'claude', busy: false, titleSays: 'waiting' }))).toBe('waiting')
  })

  // A long tool call prints nothing for minutes; the title is the pane's own account.
  it('is working when output stopped but the title still says it is working', () => {
    expect(activityOf(terminal({ id: 't', agent: 'claude', busy: false, titleSays: 'working' }))).toBe('working')
  })

  // A title is a status the program repaints; a bell is something it did on purpose, at a person.
  it('lets an unanswered bell outrank a title left saying "working"', () => {
    expect(
      activityOf(terminal({ id: 't', agent: 'claude', busy: false, titleSays: 'working', lastBellAt: 1_000 }))
    ).toBe('waiting')
  })

  it('says nothing about a pane that has exited, whatever it rang on the way out', () => {
    expect(activityOf(terminal({ id: 't', agent: 'claude', running: false, exitCode: 0, lastBellAt: 1_000 }))).toBe(
      'done'
    )
    expect(activityOf(terminal({ id: 't', agent: 'claude', running: false, exitCode: 1, titleSays: 'waiting' }))).toBe(
      'failed'
    )
  })

  it('separates a clean finish from a failure', () => {
    expect(activityOf(terminal({ id: 't', agent: 'claude', running: false, exitCode: 0 }))).toBe('done')
    expect(activityOf(terminal({ id: 't', agent: 'claude', running: false, exitCode: 1 }))).toBe('failed')
  })

  it('treats a death with no code at all as a failure', () => {
    expect(activityOf(terminal({ id: 't', agent: 'claude', running: false }))).toBe('failed')
  })
})

describe('activityOf, in a pane with no agent', () => {
  // A shell rings for a failed tab completion; nothing in it is asking.
  it('never reads a bell or a title as a shell asking', () => {
    expect(activityOf(terminal({ id: 't', busy: false, lastBellAt: 1_000 }))).toBe('quiet')
    expect(activityOf(terminal({ id: 't', busy: false, titleSays: 'waiting' }))).toBe('quiet')
    expect(activityOf(terminal({ id: 't', busy: true }))).toBe('working')
  })

  it('reads an agent seen in the foreground as an agent', () => {
    expect(activityOf(terminal({ id: 't', foregroundAgent: 'codex', lastBellAt: 1_000 }))).toBe('waiting')
  })
})

describe('dotTone', () => {
  it('draws a quiet shell as idle and a quiet agent as quiet', () => {
    expect(dotTone('quiet', undefined)).toBe('idle')
    expect(dotTone('quiet', 'claude')).toBe('quiet')
  })

  it('leaves every other state as it is', () => {
    for (const activity of ['waiting', 'working', 'done', 'failed'] as const) {
      expect(dotTone(activity, undefined)).toBe(activity)
    }
  })
})

describe('dotClass', () => {
  // One dot per row: unread is a ring on it, never a second mark beside it.
  it('rings the dot when unread', () => {
    expect(dotClass('idle')).toBe('activity activity--idle')
    expect(dotClass('working', true)).toBe('activity activity--working activity--unread')
  })

  it('draws a bare dot when the state is not known yet', () => {
    expect(dotClass(null)).toBe('activity')
    expect(dotClass(null, true)).toBe('activity activity--unread')
  })
})

describe('worktreeTone', () => {
  it('is idle when every quiet pane is a shell', () => {
    expect(worktreeTone([row({ activity: 'quiet' }), row({ activity: 'done' })])).toBe('idle')
  })

  it('is quiet when a quiet pane runs an agent', () => {
    expect(worktreeTone([row({ activity: 'quiet' }), row({ activity: 'quiet', agent: 'claude' })])).toBe('quiet')
  })

  it('follows worktreeActivity otherwise', () => {
    expect(worktreeTone([])).toBeNull()
    expect(worktreeTone([row({ activity: 'quiet' }), row({ activity: 'working' })])).toBe('working')
  })
})

describe('activityOf, when the screen shows a question', () => {
  // A trust prompt comes before any hook loads, rings no bell and leaves the title alone.
  it('is waiting while output arrives and after it stops', () => {
    expect(activityOf(terminal({ id: 't', agent: 'claude', busy: false, screenSays: 'waiting' }))).toBe('waiting')
    expect(activityOf(terminal({ id: 't', agent: 'codex', busy: true, screenSays: 'waiting' }))).toBe('waiting')
  })

  it('ranks below what the agent said about itself', () => {
    const said = { event: 'UserPromptSubmit' as const, at: 1_000 }
    expect(
      activityOf(terminal({ id: 't', agent: 'claude', busy: false, screenSays: 'waiting', agentEvent: said }))
    ).toBe('working')
  })

  it('never reads a shell as asking', () => {
    expect(activityOf(terminal({ id: 't', busy: false, screenSays: 'waiting' }))).toBe('quiet')
  })
})

describe('activityOf, when the agent has said something', () => {
  // Claude Code writes no bell and no telling title while it sits on a
  // permission prompt; a hook reporting the prompt is the agent saying so.
  it('is waiting when the agent reported a notification, whatever the bytes say', () => {
    const said = { event: 'Notification' as const, at: 1_000, detail: 'permission_prompt' }
    expect(activityOf(terminal({ id: 't', agent: 'claude', busy: true, titleSays: 'working', agentEvent: said }))).toBe(
      'waiting'
    )
    expect(activityOf(terminal({ id: 't', agent: 'claude', busy: false, agentEvent: said }))).toBe('waiting')
  })

  // Claude's reminder that it is still at its prompt; no hookless agent can say it, so it is not a request.
  it('stays quiet when the agent says only that it is still idle at its prompt', () => {
    const said = { event: 'Notification' as const, at: 1_000, detail: 'idle_prompt' }
    expect(activityOf(terminal({ id: 't', agent: 'claude', busy: false, agentEvent: said }))).toBe('quiet')
  })

  // A model call prints nothing; the turn is running because the agent said it started.
  it('is working after a prompt was submitted, even with no output arriving', () => {
    const said = { event: 'UserPromptSubmit' as const, at: 1_000 }
    expect(activityOf(terminal({ id: 't', agent: 'claude', busy: false, agentEvent: said }))).toBe('working')
    expect(activityOf(terminal({ id: 't', agent: 'claude', busy: false, lastBellAt: 900, agentEvent: said }))).toBe(
      'working'
    )
  })

  // A title still saying otherwise is one nobody has repainted; a bell in the
  // burst that ended was part of that turn.
  it('is quiet once the agent reported the turn ended, even mid-output', () => {
    for (const event of ['Stop', 'SessionStart', 'SessionEnd'] as const) {
      const said = { event, at: 1_000 }
      expect(
        activityOf(terminal({ id: 't', agent: 'claude', busy: true, titleSays: 'working', agentEvent: said }))
      ).toBe('quiet')
      expect(activityOf(terminal({ id: 't', agent: 'claude', busy: false, lastBellAt: 900, agentEvent: said }))).toBe(
        'quiet'
      )
    }
  })

  // A login that succeeded or a quota timer says nothing about whether you are needed.
  it('falls back to the bytes for a notification that is not a request', () => {
    const said = { event: 'Notification' as const, at: 1_000, detail: 'auth_success' }
    expect(activityOf(terminal({ id: 't', agent: 'claude', busy: true, agentEvent: said }))).toBe('working')
    expect(activityOf(terminal({ id: 't', agent: 'claude', busy: false, agentEvent: said }))).toBe('quiet')
  })

  it('reads the bytes when the agent has said nothing', () => {
    expect(activityOf(terminal({ id: 't', agent: 'claude', busy: true }))).toBe('working')
    expect(activityOf(terminal({ id: 't', agent: 'claude', busy: false, lastBellAt: 1 }))).toBe('waiting')
  })

  it('reports an exit over anything the agent said before it', () => {
    const said = { event: 'UserPromptSubmit' as const, at: 1_000 }
    expect(activityOf(terminal({ id: 't', agent: 'claude', running: false, exitCode: 0, agentEvent: said }))).toBe(
      'done'
    )
    expect(activityOf(terminal({ id: 't', agent: 'claude', running: false, exitCode: 1, agentEvent: said }))).toBe(
      'failed'
    )
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

    expect(rows.map((entry) => entry.label)).toEqual(['Claude Code', 'npm test'])
  })

  // Hiding a plain shell would make the row disagree with what is actually open.
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
  // The agent's binary is the one fact three panes on three jobs have in common.
  it('prefers the name somebody gave the pane to the agent running in it', () => {
    expect(paneName(terminal({ id: 't', agent: 'claude', label: 'auth refactor' }))).toBe('auth refactor')
  })

  it('falls back to the agent, and then to what the pane is running', () => {
    expect(paneName(terminal({ id: 't', agent: 'claude', title: 'node' }))).toBe('Claude Code')
    expect(paneName(terminal({ id: 't', title: 'npm test' }))).toBe('npm test')
  })

  // A pane called "   " is a pane with no name drawn as though it had one.
  it('ignores a name that is only whitespace', () => {
    expect(paneName(terminal({ id: 't', agent: 'claude', label: '   ' }))).toBe('Claude Code')
  })
})

describe('paneNames', () => {
  it('numbers panes that would otherwise read identically', () => {
    const names = paneNames([
      terminal({ id: 'a', agent: 'claude', title: 'node' }),
      terminal({ id: 'b', agent: 'claude', title: 'node' }),
      terminal({ id: 'c', agent: 'claude', title: 'node' })
    ])

    expect(names).toEqual(['Claude Code 1', 'Claude Code 2', 'Claude Code 3'])
  })

  it('leaves a name alone when nothing else in the worktree reads like it', () => {
    const names = paneNames([
      terminal({ id: 'a', agent: 'claude', title: 'node' }),
      terminal({ id: 'b', title: 'npm test' })
    ])

    expect(names).toEqual(['Claude Code', 'npm test'])
  })

  // Numbering somebody's own words back at them would be overruling the one thing the app did not make up.
  it('never numbers a name somebody typed, and counts only the unnamed', () => {
    const names = paneNames([
      terminal({ id: 'a', agent: 'claude', label: 'auth refactor' }),
      terminal({ id: 'b', agent: 'claude', label: 'auth refactor' }),
      terminal({ id: 'c', agent: 'claude', title: 'node' })
    ])

    expect(names).toEqual(['auth refactor', 'auth refactor', 'Claude Code'])
  })
})

describe('paneText', () => {
  // The glyph already says which agent; the word beside it would say it again.
  it('draws nothing beside an agent that nobody named', () => {
    const pane = terminal({ id: 't', agent: 'claude', title: 'node' })
    expect(paneText(pane, paneName(pane))).toBe('')
  })

  it('keeps only the number that tells two unnamed twins apart', () => {
    const panes = [terminal({ id: 'a', agent: 'codex' }), terminal({ id: 'b', agent: 'codex' })]
    const names = paneNames(panes)
    expect(panes.map((pane, index) => paneText(pane, names[index] ?? ''))).toEqual(['1', '2'])
  })

  it('draws a task name and a shell’s name in full', () => {
    const task = terminal({ id: 't', agent: 'claude', label: 'auth refactor' })
    expect(paneText(task, paneName(task))).toBe('auth refactor')
    expect(paneText(terminal({ id: 's', title: 'npm test' }), 'npm test')).toBe('npm test')
  })

  // Typed into a plain shell: the runtime saw the harness in the foreground.
  it('reads an agent found in the foreground the way it reads one the pane was started as', () => {
    const [entry] = agentRows([terminal({ id: 't', title: '✳ Claude Code', foregroundAgent: 'claude' })], 'wt1', 0)
    expect(entry).toMatchObject({ agent: 'claude', label: 'Claude Code', text: '' })
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

    expect(rows.map((entry) => entry.label)).toEqual(['Claude Code 1', 'Claude Code 2'])
  })

  // A pane in another worktree is not on this row and cannot be confused with it.
  it('counts only the panes of the worktree it is listing', () => {
    const rows = agentRows(
      [
        terminal({ id: 'a', agent: 'claude', title: 'node' }),
        terminal({ id: 'b', agent: 'claude', title: 'node', worktreeId: 'other' })
      ],
      'wt1',
      0
    )

    expect(rows.map((entry) => entry.label)).toEqual(['Claude Code'])
  })

  it('calls a named pane what it was named, whole', () => {
    const rows = agentRows(
      [terminal({ id: 'a', agent: 'claude', label: 'rewrite the pager so it streams instead of buffering' })],
      'wt1',
      0
    )

    expect(rows[0]?.label).toBe('rewrite the pager so it streams instead of buffering')
  })

  // `startTask` labels the agent's pane with the worktree's name; the pane goes by the worktree's title.
  it('calls a pane named after its worktree by the worktree title', () => {
    const worktree = {
      id: 'wt1',
      name: 'Add a subtract function to claude',
      branch: 'add-a-subtract-function-to-claude',
      task: 'Add a subtract function to src/math.ts'
    }
    const rows = agentRows(
      [terminal({ id: 'a', agent: 'claude', label: worktree.name }), terminal({ id: 'b', label: 'server' })],
      worktree,
      0
    )

    expect(rows.map((entry) => entry.label)).toEqual(['Add a subtract function to src/math.ts', 'server'])
  })
})

describe('paneLabel', () => {
  it('keeps a title a program set for itself', () => {
    expect(paneLabel(terminal({ id: 't', title: 'npm run build' }))).toBe('npm run build')
  })

  // The default title repeats the worktree row and changes every time the shell cds.
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
  // "last output now ago" was the hover text for a pane that had just printed.
  it('says "now" on its own and everything else with "ago"', () => {
    expect(agoLabel(3_000)).toBe('now')
    expect(agoLabel(45_000)).toBe('45s ago')
    expect(agoLabel(3 * 60_000)).toBe('3m ago')
  })
})

describe('TONE_LABEL', () => {
  // A quiet agent drew amber under the word a grey shell used; two colours, one word.
  it('gives every tone its own word', () => {
    const words = TONES_BY_ATTENTION.map((tone) => TONE_LABEL[tone])
    expect(new Set(words).size).toBe(words.length)
    expect(Object.keys(TONE_LABEL).sort()).toEqual([...TONES_BY_ATTENTION].sort())
  })

  it('pairs each tone with its word', () => {
    expect(TONE_LABEL).toEqual({
      failed: 'failed',
      waiting: 'asking',
      working: 'working',
      quiet: 'stopped',
      idle: 'idle',
      done: 'finished'
    })
  })

  it('calls a quiet agent stopped and a quiet shell idle', () => {
    expect(TONE_LABEL[dotTone('quiet', 'codex')]).toBe('stopped')
    expect(TONE_LABEL[dotTone('quiet', undefined)]).toBe('idle')
  })
})

describe('an agent back at its prompt after a turn', () => {
  // Claude reports the turn ended, then a minute later that it is idle; codex reports nothing.
  it('reads the same with hooks as without', () => {
    const claude = terminal({ id: 'a', agent: 'claude', agentEvent: { event: 'Stop', at: 1_000 } })
    const claudeLater = terminal({
      id: 'b',
      agent: 'claude',
      agentEvent: { event: 'Notification', at: 61_000, detail: 'idle_prompt' }
    })
    const codex = terminal({ id: 'c', agent: 'codex', lastOutputAt: 1_000 })
    const tones = [claude, claudeLater, codex].map((pane) => dotTone(activityOf(pane), paneAgent(pane)))
    expect(tones).toEqual(['quiet', 'quiet', 'quiet'])
  })
})

describe('paneCount', () => {
  const panes = [
    terminal({ id: 'a', worktreeId: 'wt1' }),
    terminal({ id: 'b', worktreeId: 'wt1', running: false, exitCode: 0 }),
    terminal({ id: 'c', worktreeId: 'wt2' }),
    terminal({ id: 'd', worktreeId: 'gone' })
  ]

  // The rail's badge, the Panes tab and the status bar all count with this.
  it('counts the terminals the Panes tab lists, here and across listed worktrees', () => {
    expect(paneCount(panes, ['wt1', 'wt2'], 'wt1')).toEqual({ here: 2, total: 3, worktrees: 2 })
    expect(paneCount(panes, ['wt1', 'wt2'], 'wt1').here).toBe(agentRows(panes, 'wt1', 0).length)
  })

  it('counts nothing here when no worktree is open', () => {
    expect(paneCount(panes, ['wt1', 'wt2'], null)).toEqual({ here: 0, total: 3, worktrees: 2 })
  })
})
