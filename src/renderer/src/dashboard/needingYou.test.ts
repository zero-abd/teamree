import { describe, expect, it } from 'vitest'
import type { Layout, Terminal } from '@shared/entities'
import { panesNeedingYou, stepNeedingYou, type NeedingState } from './needingYou'

function terminal(id: string, worktreeId: string, overrides: Partial<Terminal> = {}): Terminal {
  return {
    id,
    worktreeId,
    title: 'claude',
    cwd: `/checkouts/${worktreeId}`,
    shell: '/bin/zsh',
    cols: 80,
    rows: 24,
    running: true,
    busy: false,
    agent: 'claude',
    lastOutputAt: 100,
    ...overrides
  }
}

const leaf = (worktreeId: string, terminalId: string): Layout => ({
  worktreeId,
  root: { kind: 'leaf', terminalId },
  focusedTerminalId: terminalId
})

const asking = { screenSays: 'waiting' } as const
const finished = { running: false, exitCode: 0, tookTurn: true } as const

/** Four worktrees in one project; A is working, B and D ask, C finished and has not been read. */
function window(front: string): NeedingState {
  const ids = ['wa', 'wb', 'wc', 'wd']
  const terminals = [
    terminal('a', 'wa', { busy: true }),
    terminal('b', 'wb', asking),
    terminal('c', 'wc', finished),
    terminal('d', 'wd', asking)
  ]
  const on = terminals.find((entry) => entry.id === front)
  return {
    projects: [{ id: 'p1' }],
    worktrees: ids.map((id) => ({ id, projectId: 'p1' })),
    layouts: Object.fromEntries(terminals.map((entry) => [entry.worktreeId, leaf(entry.worktreeId, entry.id)])),
    activeWorktreeId: on?.worktreeId ?? null,
    focusedWatchId: null,
    terminals: Object.fromEntries(terminals.map((entry) => [entry.id, entry])),
    // Looking at a pane marks it read, as `focusPane` does.
    paneSeenAt: on === undefined ? {} : { [on.id]: 200 }
  }
}

const walk = (from: string, step: 1 | -1, times: number): string[] => {
  const visited: string[] = []
  let here = from
  for (let turn = 0; turn < times; turn++) {
    here = stepNeedingYou(window(here), step)?.terminalId ?? here
    visited.push(here)
  }
  return visited
}

describe('going to the next pane that needs you', () => {
  it('visits asking panes, then the unread finished one, and wraps', () => {
    expect(walk('a', 1, 4)).toEqual(['b', 'd', 'c', 'b'])
  })

  it('goes back the same way', () => {
    expect(walk('a', -1, 4)).toEqual(['c', 'd', 'b', 'c'])
  })

  it('puts failed after asking, and finished panes oldest first', () => {
    const state = window('a')
    state.terminals = {
      ...state.terminals,
      c: terminal('c', 'wc', { ...finished, lastOutputAt: 300 }),
      d: terminal('d', 'wd', { ...finished, lastOutputAt: 150 }),
      a: terminal('a', 'wa', { running: false, exitCode: 1 })
    }
    state.activeWorktreeId = null
    expect(panesNeedingYou(state).map((pane) => pane.terminalId)).toEqual(['b', 'a', 'd', 'c'])
  })

  it('has nowhere to go when nothing else needs you', () => {
    const state = window('b')
    state.terminals = { b: terminal('b', 'wb', asking), a: terminal('a', 'wa', { busy: true }) }
    expect(stepNeedingYou(state, 1)).toBeNull()
    expect(stepNeedingYou({ ...state, terminals: {} }, -1)).toBeNull()
  })
})
