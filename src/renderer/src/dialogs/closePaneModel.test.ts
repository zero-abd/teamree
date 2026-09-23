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
  it('names the command still producing output, and what closing costs', () => {
    const warning = closePaneWarning(terminal({ busy: true }))
    expect(warning?.title).toBe('Stop what is running here?')
    expect(warning?.body).toContain('“npm test”')
    expect(warning?.body).toContain('kills the process')
    expect(warning?.confirm).toBe('Stop it and close')
  })

  it('names the agent that is working', () => {
    const warning = closePaneWarning(terminal({ title: 'claude', agent: 'claude', busy: true }))
    expect(warning?.title).toBe('Stop this agent?')
    expect(warning?.body).toContain('claude is working')
  })

  // The expensive one, and the case a `busy` check alone would miss entirely.
  // An agent that has gone quiet is usually holding a question, and this app
  // cannot tell that from finished — so the line names both possibilities
  // rather than asserting either, and does not explain itself further.
  it('asks about a quiet agent, and does not claim to know it is waiting', () => {
    const warning = closePaneWarning(terminal({ title: 'claude', agent: 'claude', busy: false }))
    expect(warning?.title).toBe('Stop this agent?')
    expect(warning?.body).toBe(
      'claude has gone quiet in “claude” — waiting for an answer, or finished. Closing the pane kills it.'
    )
    expect(warning?.body).not.toContain('teamree watches output')
  })

  it('does not ask about an agent pane whose agent has exited', () => {
    expect(closePaneWarning(terminal({ agent: 'claude', running: false }))).toBeNull()
  })

  // A pane can be opened with no title at all, and "Closing “” kills it" is the
  // sentence that makes a reader stop trusting the rest of the dialog.
  it('falls back to naming the pane when it has no title', () => {
    const warning = closePaneWarning(terminal({ title: '   ', busy: true }))
    expect(warning?.body).toContain('this pane')
    expect(warning?.body).not.toContain('““')
  })
})
