// The table `teamree resources` prints: the same tree the status bar's
// popover draws, one line per pane, the processes under it, and the app
// itself last.

import { describe, expect, it } from 'vitest'
import type { SystemResources, Terminal, Worktree } from '../../shared/entities.js'
import { formatBytes, resourcesTable } from './resources.js'

function worktree(id: string, name: string): Worktree {
  return {
    id,
    projectId: 'p_api',
    name,
    branch: `feature/${name}`,
    path: `/repos/api-${name}`,
    startedFrom: 'origin/main',
    state: 'ready',
    createdAt: 1
  }
}

function terminal(id: string, worktreeId: string, title: string, label?: string): Terminal {
  return {
    id,
    worktreeId,
    title,
    cwd: '/repos/api',
    shell: '/bin/zsh',
    cols: 80,
    rows: 24,
    running: true,
    busy: false,
    lastOutputAt: 0,
    ...(label === undefined ? {} : { label })
  }
}

const MB = 1024 * 1024

const sample: SystemResources = {
  sampledAt: 1000,
  cpu: 105.2,
  rss: 560 * MB,
  panes: [
    {
      terminalId: 't_1',
      worktreeId: 'wt_1',
      pid: 600,
      cpu: 102.9,
      rss: 63 * MB,
      processes: [
        { pid: 600, ppid: 500, cpu: 0, rss: 3 * MB, command: 'zsh' },
        { pid: 601, ppid: 600, cpu: 98.7, rss: 50 * MB, command: 'node' },
        { pid: 602, ppid: 601, cpu: 4.2, rss: 10 * MB, command: 'git' }
      ]
    },
    { terminalId: 't_2', worktreeId: 'wt_1', pid: 700, cpu: 0, rss: 2 * MB, processes: [] },
    { terminalId: 't_3', worktreeId: 'wt_gone', pid: 800, cpu: 0.3, rss: 1 * MB, processes: [] }
  ],
  app: { pid: 500, cpu: 2, rss: 494 * MB, processes: [] }
}

describe('formatBytes', () => {
  it('rounds to the unit a person would say', () => {
    expect(formatBytes(0)).toBe('0 MB')
    expect(formatBytes(512 * 1024)).toBe('0.5 MB')
    expect(formatBytes(560 * MB)).toBe('560 MB')
    expect(formatBytes(1.25 * 1024 * MB)).toBe('1.25 GB')
  })
})

describe('the resources table', () => {
  const text = resourcesTable(
    sample,
    [terminal('t_1', 'wt_1', 'claude', 'fix login'), terminal('t_2', 'wt_1', 'zsh'), terminal('t_3', 'wt_gone', 'zsh')],
    [worktree('wt_1', 'fix-login')]
  )
  const lines = text.split('\n')

  it('opens with the totals', () => {
    expect(lines[0]).toBe('total  105.2%  560 MB')
  })

  it('names the worktree and the pane, then the processes under it', () => {
    expect(text).toContain('fix-login')
    expect(text).toContain('fix login')
    const pane = lines.findIndex((line) => line.includes('fix login'))
    expect(lines[pane]).toMatch(/600\s+102\.9%\s+63 MB/)
    expect(lines[pane + 1]).toMatch(/^\s+600\s+0\.0%\s+3 MB\s+zsh$/)
    expect(lines[pane + 2]).toMatch(/^\s+601\s+98\.7%\s+50 MB\s+node$/)
    expect(lines[pane + 3]).toMatch(/^\s+602\s+4\.2%\s+10 MB\s+git$/)
  })

  it('falls back to the title and the worktree id where nothing better is known', () => {
    const row = lines.find((line) => line.includes('wt_gone'))
    expect(row).toMatch(/wt_gone\s+zsh\s+800/)
  })

  it('puts the app last, on its own', () => {
    expect(lines[lines.length - 1]).toMatch(/^teamree\s+app\s+500\s+2\.0%\s+494 MB$/)
  })

  it('names the pane by its title when nobody named it', () => {
    const row = lines.find((line) => line.includes('700'))
    expect(row).toMatch(/fix-login\s+zsh\s+700/)
  })
})
