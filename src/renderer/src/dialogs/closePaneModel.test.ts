// When closing a pane is worth stopping somebody over.
//
// The two failures here are opposites and both are real. Asking too rarely puts
// the app back where it started: one click kills an agent mid-task, and the
// pane is the only way to reach it. Asking too often is worse than not asking
// at all — a dialog on every close is a keystroke people learn to press
// through, and having learned it they press through the one that mattered.
//
// So each case below is a claim about which of those it would be.

import { describe, expect, it } from 'vitest'
import type { Terminal } from '@shared/entities'
import { closePaneWarning } from './closePaneModel'

const terminal = (overrides: Partial<Terminal> = {}): Terminal => ({
  id: 't1',
  worktreeId: 'w1',
  title: 'npm test',
  cwd: '/repos/pager',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy: false,
  lastOutputAt: 0,
  ...overrides
})

describe('panes that close without a word', () => {
  // The common case, and the reason this file is a predicate rather than a
  // constant: somebody opens a shell, runs three commands and closes it.
  it('a shell sitting at a prompt', () => {
    expect(closePaneWarning(terminal())).toBeNull()
  })

  it('a pane whose process has already exited', () => {
    expect(closePaneWarning(terminal({ running: false, busy: true, exitCode: 0 }))).toBeNull()
  })

  // `running` is still true between the child being reaped and the last of its
  // output arriving. Asking here would offer to stop something already stopped.
  it('a pane still draining the output of a process that has gone', () => {
    expect(closePaneWarning(terminal({ busy: true, draining: true }))).toBeNull()
  })

  it('a pane the window has no record of', () => {
    expect(closePaneWarning(undefined)).toBeNull()
  })
})

describe('panes worth asking about', () => {
  it('names the pane still producing output', () => {
    const warning = closePaneWarning(terminal({ busy: true }))
    expect(warning?.title).toBe('Stop what is running here?')
    expect(warning?.body).toContain('“npm test”')
    expect(warning?.confirm).toBe('Stop and Close')
  })

  it('names the agent that is working, and quotes the pane’s line', () => {
    const warning = closePaneWarning(terminal({ title: 'claude', agent: 'claude', busy: true }), 'Read 6 lines')
    expect(warning?.title).toBe('Stop Claude Code?')
    expect(warning?.body).toBe('Read 6 lines')
  })

  // The question is what closing would leave unanswered.
  it('quotes the question an asking agent is holding', () => {
    const asking = terminal({
      agent: 'claude',
      agentEvent: { event: 'Notification', at: 1, message: 'Claude needs your permission to use Edit' }
    })
    expect(closePaneWarning(asking, 'Do you want to make this edit to math.ts?')).toEqual({
      title: 'Stop Claude Code?',
      body: 'Do you want to make this edit to math.ts?',
      confirm: 'Stop and Close'
    })
    expect(closePaneWarning(asking, '3. No, and tell Claude…')?.body).toBe('Permission to use Edit')
  })

  // `28-close-agent.png`: the agent had finished its turn minutes before, and its row said stopped.
  it('closes a quiet agent without asking, like a shell', () => {
    expect(closePaneWarning(terminal({ title: 'claude', agent: 'claude', busy: false }))).toBeNull()
    expect(
      closePaneWarning(terminal({ agent: 'claude', busy: false, agentEvent: { event: 'Stop', at: 1 } }), 'Done')
    ).toBeNull()
  })

  it('does not ask about an agent pane whose agent has exited', () => {
    expect(closePaneWarning(terminal({ agent: 'claude', running: false }))).toBeNull()
  })

  // A pane can be opened with no title at all, and "Closing “” kills it" is the
  // sentence that makes a reader stop trusting the rest of the dialog. The name
  // falls back the way the tab's does — to the shell — so it is never empty.
  it('falls back to naming the pane when it has no title', () => {
    const warning = closePaneWarning(terminal({ title: '   ', busy: true }))
    expect(warning?.body).toContain('in “zsh”')
    expect(warning?.body).not.toContain('““')
  })
})

describe('what the question calls the pane', () => {
  it('falls back to the title for a pane nobody named', () => {
    const warning = closePaneWarning(terminal({ busy: true, title: 'npm test' }))
    expect(warning?.body).toContain('in “npm test”')
  })
})
