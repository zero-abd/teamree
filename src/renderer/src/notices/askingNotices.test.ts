import { describe, expect, it } from 'vitest'
import type { Layout, PaneNode, Terminal, Worktree } from '@shared/entities'
import { hiddenAsks, type AskingState } from './askingNotices'

function terminal(id: string, worktreeId: string, overrides: Partial<Terminal> = {}): Terminal {
  return {
    id,
    worktreeId,
    title: 'claude',
    cwd: '/w',
    shell: '/bin/zsh',
    cols: 80,
    rows: 24,
    running: true,
    busy: false,
    lastOutputAt: 0,
    agent: 'claude',
    ...overrides
  }
}

const asking = (id: string, worktreeId: string): Terminal =>
  terminal(id, worktreeId, {
    agentEvent: {
      event: 'Notification',
      at: 5,
      detail: 'permission_prompt',
      message: 'Claude needs your permission to use Bash'
    },
    screenMenu: { prompt: 'p', choices: [{ label: 'Yes', keys: ['1'] }] }
  })

const worktree = (id: string, name: string): Worktree => ({ id, name }) as Worktree
const tabs = (...ids: string[]): Extract<PaneNode, { kind: 'split' }> => ({
  kind: 'split',
  direction: 'row',
  sizes: ids.map(() => 1 / ids.length),
  children: ids.map((terminalId) => ({ kind: 'leaf', terminalId })),
  tabs: true,
  shown: ids[0]
})

function state(overrides: Partial<AskingState> = {}): AskingState {
  const layouts: Record<string, Layout> = {
    w1: { worktreeId: 'w1', root: tabs('a', 'b'), focusedTerminalId: 'a' },
    w2: { worktreeId: 'w2', root: { kind: 'leaf', terminalId: 'c' }, focusedTerminalId: 'c' }
  }
  return {
    terminals: { a: terminal('a', 'w1'), b: asking('b', 'w1'), c: asking('c', 'w2') },
    worktrees: [worktree('w1', 'session migration'), worktree('w2', 'payment retries')],
    layouts,
    activeWorktreeId: 'w1',
    expandedTerminalId: null,
    focusedWatchId: null,
    covered: false,
    ...overrides
  }
}

describe('hiddenAsks', () => {
  it('lists an asking pane of another worktree and one behind another tab, not one on screen', () => {
    expect(hiddenAsks(state()).map((ask) => ask.terminal.id)).toEqual(['b', 'c'])
    const shownB = state({
      layouts: {
        ...state().layouts,
        w1: { worktreeId: 'w1', root: { ...tabs('a', 'b'), shown: 'b' }, focusedTerminalId: 'b' }
      }
    })
    expect(hiddenAsks(shownB).map((ask) => ask.terminal.id)).toEqual(['c'])
  })

  it('names the worktree and quotes the question', () => {
    const [first] = hiddenAsks(state({ activeWorktreeId: 'w2' }))
    expect(first?.worktreeName).toBe('session migration')
    expect(first?.question).toBe('Permission to use Bash')
  })

  it('lists every asking pane while a page covers the panes', () => {
    const shown = state({ activeWorktreeId: 'w2' })
    expect(hiddenAsks(shown).map((ask) => ask.terminal.id)).toEqual(['b'])
    expect(hiddenAsks({ ...shown, covered: true }).map((ask) => ask.terminal.id)).toEqual(['b', 'c'])
  })

  it('keys an ask by what it asks, so a new question comes back after a dismissal', () => {
    const [before] = hiddenAsks(state())
    const again = asking('b', 'w1')
    again.agentEvent = { ...again.agentEvent!, at: 9 }
    const [after] = hiddenAsks(state({ terminals: { ...state().terminals, b: again } }))
    expect(before?.key).not.toBe(after?.key)
  })

  it('leaves out a pane that is not asking or has exited', () => {
    const quiet = state({
      terminals: { c: terminal('c', 'w2'), d: { ...asking('d', 'w2'), running: false, exitCode: 0 } }
    })
    expect(hiddenAsks(quiet)).toEqual([])
  })
})
