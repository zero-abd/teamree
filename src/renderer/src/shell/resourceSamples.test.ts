// What the window keeps between two answers from `system.resources`: the last
// thirty readings per row, for the sparkline, and the grouping of panes under
// the worktrees the sidebar already names.

import { describe, expect, it } from 'vitest'
import type { SystemResources, Terminal, Worktree } from '@shared/entities'
import { formatBytes, formatCpu, groupByWorktree, recordSample, SPARKLINE_SAMPLES } from './resourceSamples'

const MB = 1024 * 1024

function sample(over: Partial<SystemResources> = {}): SystemResources {
  return {
    sampledAt: 0,
    cpu: 0,
    rss: 0,
    panes: [],
    app: { pid: 1, cpu: 0, rss: 0, processes: [] },
    ...over
  }
}

const pane = (terminalId: string, worktreeId: string, cpu: number): SystemResources['panes'][number] => ({
  terminalId,
  worktreeId,
  pid: 1,
  cpu,
  rss: 0,
  processes: []
})

describe('recordSample', () => {
  it('appends one reading per row, the app included', () => {
    const history = recordSample(
      {},
      sample({ panes: [pane('t_1', 'wt', 3)], app: { pid: 1, cpu: 7, rss: 0, processes: [] } })
    )
    expect(history).toEqual({ t_1: [3], app: [7] })
  })

  it('keeps the last thirty and no more', () => {
    let history: ReturnType<typeof recordSample> = {}
    for (let index = 0; index < SPARKLINE_SAMPLES + 5; index += 1) {
      history = recordSample(history, sample({ panes: [pane('t_1', 'wt', index)] }))
    }
    expect(history.t_1).toHaveLength(SPARKLINE_SAMPLES)
    expect(history.t_1?.[0]).toBe(5)
  })

  it('forgets a pane that is no longer in the answer', () => {
    const first = recordSample({}, sample({ panes: [pane('t_1', 'wt', 1), pane('t_2', 'wt', 1)] }))
    const second = recordSample(first, sample({ panes: [pane('t_2', 'wt', 2)] }))
    expect(Object.keys(second).sort()).toEqual(['app', 't_2'])
    expect(second.t_2).toEqual([1, 2])
  })
})

describe('formatting', () => {
  it('says memory the way a person would', () => {
    expect(formatBytes(560 * MB)).toBe('560 MB')
    expect(formatBytes(1.25 * 1024 * MB)).toBe('1.25 GB')
    expect(formatBytes(0)).toBe('0 MB')
  })

  it('says cpu to one decimal', () => {
    expect(formatCpu(0)).toBe('0.0%')
    expect(formatCpu(102.94)).toBe('102.9%')
  })
})

describe('groupByWorktree', () => {
  const worktree = (id: string, name: string): Worktree => ({
    id,
    projectId: 'p',
    name,
    branch: name,
    path: `/w/${name}`,
    startedFrom: 'main',
    state: 'ready',
    createdAt: 0
  })
  const terminal = (id: string, worktreeId: string, title: string, label?: string): Terminal => ({
    id,
    worktreeId,
    title,
    cwd: '/w',
    shell: '/bin/zsh',
    cols: 80,
    rows: 24,
    running: true,
    busy: false,
    lastOutputAt: 0,
    ...(label === undefined ? {} : { label })
  })

  it('groups panes under their worktree, in the sidebar order, named the way the sidebar names them', () => {
    const groups = groupByWorktree(
      sample({ panes: [pane('t_b', 'wt_2', 0), pane('t_a', 'wt_1', 0), pane('t_c', 'wt_1', 0)] }),
      [worktree('wt_1', 'fix login'), worktree('wt_2', 'pager')],
      {
        t_a: terminal('t_a', 'wt_1', 'claude'),
        t_b: terminal('t_b', 'wt_2', 'zsh'),
        t_c: terminal('t_c', 'wt_1', 'claude')
      }
    )
    expect(groups.map((group) => group.name)).toEqual(['fix login', 'pager'])
    expect(groups[0]?.panes.map((row) => row.name)).toEqual(['claude 1', 'claude 2'])
  })

  it('keeps a pane whose worktree it cannot name, under the id', () => {
    const groups = groupByWorktree(sample({ panes: [pane('t_a', 'wt_gone', 0)] }), [], {})
    expect(groups).toHaveLength(1)
    expect(groups[0]?.name).toBe('wt_gone')
    expect(groups[0]?.panes[0]?.name).toBe('t_a')
  })
})
