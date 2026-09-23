// One `ps` call, read into a tree, read back per pane.
//
// The fixture is a whole machine's worth of rows rather than the few that
// matter, because the aggregation's job is to leave most of them out: a pid
// whose parent is not in any pane's tree belongs to nobody here, and a pane
// whose child has already gone still has to come back as a row.

import { describe, expect, it } from 'vitest'
import { aggregateResources, killTarget } from './resourceTree'
import { parsePsTable } from './psTable'

const PS = [
  '  PID  PPID  %CPU    RSS COMM',
  '    1     0   0.1   8192 /sbin/launchd',
  '  500     1   2.0 409600 /Applications/teamree.app/Contents/MacOS/teamree',
  '  501   500   1.5 204800 /Applications/teamree.app/Contents/Frameworks/teamree Helper (Renderer).app/Contents/MacOS/teamree Helper (Renderer)',
  '  502   500   0.5 102400 /Applications/teamree.app/Contents/Frameworks/teamree Helper (GPU).app/Contents/MacOS/teamree Helper (GPU)',
  '  600   500   0.0   3072 /bin/zsh',
  '  601   600  98.7  51200 /usr/local/bin/node',
  '  602   601   4.2  10240 /usr/bin/git',
  '  700   500   0.0   2048 /bin/zsh',
  '  800     1  12.0  65536 /usr/local/bin/node',
  '  900   950   0.0   1024 /usr/bin/sleep',
  ''
].join('\n')

describe('parsePsTable', () => {
  it('reads every numeric row and drops the header', () => {
    const rows = parsePsTable(PS)
    expect(rows).toHaveLength(10)
    expect(rows[0]).toEqual({ pid: 1, ppid: 0, cpu: 0.1, rss: 8192 * 1024, command: 'launchd' })
  })

  it('keeps only the basename of a command, spaces and all', () => {
    const helper = parsePsTable(PS).find((row) => row.pid === 501)
    expect(helper?.command).toBe('teamree Helper (Renderer)')
  })

  it('reports rss in bytes', () => {
    expect(parsePsTable(PS).find((row) => row.pid === 601)?.rss).toBe(51200 * 1024)
  })

  it('reads a Linux table, where comm is already a bare name', () => {
    const rows = parsePsTable('    PID    PPID %CPU   RSS COMMAND\n   1234       1  0.0  1000 node\n')
    expect(rows).toEqual([{ pid: 1234, ppid: 1, cpu: 0, rss: 1_024_000, command: 'node' }])
  })

  it('answers nothing for an empty or garbled table', () => {
    expect(parsePsTable('')).toEqual([])
    expect(parsePsTable('ps: illegal option\n')).toEqual([])
  })
})

const panes = [
  { terminalId: 'term_a', worktreeId: 'wt_1', pid: 600 },
  { terminalId: 'term_b', worktreeId: 'wt_1', pid: 700 },
  // The child died between the pane list and the ps call.
  { terminalId: 'term_gone', worktreeId: 'wt_2', pid: 999 }
]

describe('aggregateResources', () => {
  const sample = aggregateResources({ sampledAt: 1000, processes: parsePsTable(PS), panes, appPid: 500 })

  it('gives each pane its whole process tree, root first', () => {
    const a = sample.panes.find((pane) => pane.terminalId === 'term_a')
    expect(a?.processes.map((process) => process.pid)).toEqual([600, 601, 602])
    expect(a?.cpu).toBeCloseTo(102.9)
    expect(a?.rss).toBe((3072 + 51200 + 10240) * 1024)
  })

  it('returns a pane with no children as a row of its own', () => {
    const b = sample.panes.find((pane) => pane.terminalId === 'term_b')
    expect(b?.processes.map((process) => process.pid)).toEqual([700])
    expect(b?.cpu).toBe(0)
  })

  it('keeps a pane whose child is already gone, with nothing under it', () => {
    const gone = sample.panes.find((pane) => pane.terminalId === 'term_gone')
    expect(gone).toEqual({ terminalId: 'term_gone', worktreeId: 'wt_2', pid: 999, cpu: 0, rss: 0, processes: [] })
  })

  it('attributes an orphaned pid to nobody', () => {
    // 800 was reparented to launchd; 900's parent is not in the table at all.
    const everyPid = [...sample.panes, sample.app].flatMap((row) => row.processes.map((process) => process.pid))
    expect(everyPid).not.toContain(800)
    expect(everyPid).not.toContain(900)
    expect(everyPid).not.toContain(1)
  })

  it('counts the app as its own row, without the panes it spawned', () => {
    expect(sample.app.pid).toBe(500)
    expect(sample.app.processes.map((process) => process.pid)).toEqual([500, 501, 502])
    expect(sample.app.rss).toBe((409600 + 204800 + 102400) * 1024)
  })

  it('totals the panes and the app, and nothing else', () => {
    expect(sample.rss).toBe((409600 + 204800 + 102400 + 3072 + 51200 + 10240 + 2048) * 1024)
    expect(sample.cpu).toBeCloseTo(2.0 + 1.5 + 0.5 + 0.0 + 98.7 + 4.2 + 0.0)
    expect(sample.sampledAt).toBe(1000)
  })
})

describe('killTarget', () => {
  const sample = aggregateResources({ sampledAt: 1000, processes: parsePsTable(PS), panes, appPid: 500 })

  it("names a pane's own child as a group, so the whole tree is signalled", () => {
    expect(killTarget(sample, 600)).toEqual({ kind: 'group', pid: 600, terminalId: 'term_a' })
  })

  it('names a process inside a pane as one process', () => {
    expect(killTarget(sample, 602)).toEqual({ kind: 'process', pid: 602, terminalId: 'term_a' })
  })

  it('refuses teamree itself and every helper of it', () => {
    expect(killTarget(sample, 500)).toBeNull()
    expect(killTarget(sample, 501)).toBeNull()
    expect(killTarget(sample, 502)).toBeNull()
  })

  it('refuses a pid that belongs to no pane', () => {
    expect(killTarget(sample, 800)).toBeNull()
    expect(killTarget(sample, 1)).toBeNull()
    expect(killTarget(sample, 999)).toBeNull()
    expect(killTarget(sample, -600)).toBeNull()
  })
})
