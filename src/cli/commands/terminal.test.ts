// The listing, as an agent reads it.
//
// `terminal list` is how a caller finds the pane it just started, and for a
// long time it answered the two questions it is asked — which worktree, which
// pane — with a uuid and a binary name. Both are checked here rather than
// through the runtime, because both are decisions about wording.

import { describe, expect, it } from 'vitest'
import type { Terminal, Worktree } from '../../shared/entities.js'
import { terminalTable } from './terminal.js'

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

function terminal(id: string, worktreeId: string, label?: string): Terminal {
  return {
    id,
    worktreeId,
    title: 'claude',
    cwd: '/repos/api-fix-login',
    shell: '/bin/zsh',
    cols: 80,
    rows: 24,
    running: true,
    busy: false,
    lastOutputAt: 0,
    ...(label === undefined ? {} : { label })
  }
}

describe('the terminal listing', () => {
  it('names the worktree instead of printing its id', () => {
    const text = terminalTable(
      [terminal('t_1', 'wt_0f8c2e1a-5b3d-4a7e-9c11-2d6b8a4f0e93')],
      [worktree('wt_0f8c2e1a-5b3d-4a7e-9c11-2d6b8a4f0e93', 'fix-login')]
    )
    const [, row] = text.split('\n')
    expect(row).toContain('fix-login')
    // Not alongside it: the id is a column nobody can type back, and a row
    // carrying both is a row that has not chosen.
    expect(row).not.toContain('wt_0f8c2e1a-5b3d-4a7e-9c11-2d6b8a4f0e93')
  })

  // A pane whose worktree is not in the listing — removed between the two
  // calls. An id is a poor name and still the only true thing left to say.
  it('falls back to the id when no name is known', () => {
    const text = terminalTable([terminal('t_1', 'wt_gone')], [worktree('wt_1', 'fix-login')])
    expect(text.split('\n')[1]).toContain('wt_gone')
  })

  it('tells three panes of the same agent apart by the name each was given', () => {
    const worktrees = [worktree('wt_1', 'fix-login'), worktree('wt_2', 'fix-login-claude-2')]
    const text = terminalTable(
      [terminal('t_1', 'wt_1', 'fix login'), terminal('t_2', 'wt_2', 'fix login claude 2')],
      worktrees
    )
    expect(text).toContain('fix login claude 2')
    expect(text.split('\n')).toHaveLength(3)
  })

  it('says how to make one when there are none', () => {
    expect(terminalTable([], [])).toBe('No terminals. Create one with: teamree terminal create <worktree>')
  })
})
