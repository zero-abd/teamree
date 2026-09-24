import { describe, expect, it } from 'vitest'
import type { Layout, Terminal, Worktree } from '../../../shared/entities'
import { fileLeaf, fileLeavesIn } from '../../../shared/filePane'
import { presenceFor } from './presence'

const worktree: Worktree = {
  id: 'w1',
  projectId: 'p1',
  name: 'notes',
  branch: 'notes',
  path: '/tmp/notes',
  startedFrom: 'main',
  state: 'ready',
  createdAt: 0
}

const terminal = (id: string): Terminal => ({
  id,
  worktreeId: 'w1',
  title: 'zsh',
  cwd: '/tmp/notes',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy: false,
  lastOutputAt: 0
})

describe('presenceFor', () => {
  it('lists the terminals of a worktree and skips its file panes', () => {
    const layout: Layout = {
      worktreeId: 'w1',
      root: {
        kind: 'split',
        direction: 'row',
        sizes: [0.5, 0.5],
        children: [{ kind: 'leaf', terminalId: 't1' }, fileLeaf('file:1', 'NOTES.md')]
      },
      focusedTerminalId: 'file:1'
    }
    expect(fileLeavesIn(layout.root)).toHaveLength(1)

    const presence = presenceFor(
      {
        source: {
          projects: () => [{ projectId: 'p1', projectKey: 'key', rosterKeys: ['peer'] }],
          worktrees: () => [worktree],
          terminals: () => [terminal('t1')]
        },
        now: () => 1_000
      },
      'peer',
      'me',
      1
    )
    const panes = presence.projects[0]?.worktrees[0]?.panes ?? []
    expect(panes.map((pane) => pane.id)).toEqual(['t1'])
  })

  it('sends the name a pane was given, and nothing for one never named', () => {
    const presence = presenceFor(
      {
        source: {
          projects: () => [{ projectId: 'p1', projectKey: 'key', rosterKeys: ['peer'] }],
          worktrees: () => [worktree],
          terminals: () => [{ ...terminal('t1'), label: 'api server' }, terminal('t2')]
        }
      },
      'peer',
      'me',
      1
    )
    const panes = presence.projects[0]?.worktrees[0]?.panes ?? []
    expect(panes.map((pane) => pane.label)).toEqual(['api server', undefined])
    expect('label' in (panes[1] ?? {})).toBe(false)
  })

  // The reader names the pane; the number it was started with is a fact only the owner has.
  it('sends the number a pane was started with', () => {
    const presence = presenceFor(
      {
        source: {
          projects: () => [{ projectId: 'p1', projectKey: 'key', rosterKeys: ['peer'] }],
          worktrees: () => [worktree],
          terminals: () => [{ ...terminal('t1'), ordinal: 2 }, terminal('t2')]
        }
      },
      'peer',
      'me',
      1
    )
    const panes = presence.projects[0]?.worktrees[0]?.panes ?? []
    expect(panes.map((pane) => pane.ordinal)).toEqual([2, undefined])
  })
})
