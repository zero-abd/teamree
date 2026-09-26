// Presence v2 sends which files a worktree changed. This holds the claim in docs/teamwork.md that it
// never sends what is in them, nor a byte a pane printed: real git, a real snapshot, searched for both.

import { afterEach, describe, expect, it } from 'vitest'
import type { Terminal, Worktree } from '../../src/shared/entities'
import { createTempRepo, type TempRepo } from '../../src/main/git/testRepository'
import { presenceFor } from '../../src/main/teamwork/peer/presence'
import { readTaskGitDetails } from '../../src/main/teamwork/peer/presenceDetails'

const COMMITTED = 'committed-secret-4f1c'
const EDITED = 'edited-secret-9a2e'
const UNTRACKED = 'untracked-secret-77d0'

const repos: TempRepo[] = []
afterEach(async () => {
  for (const repo of repos.splice(0)) await repo.cleanup()
})

describe('a presence snapshot', () => {
  it('names changed paths and carries none of their contents or any scrollback', async () => {
    const repo = await createTempRepo()
    repos.push(repo)
    await repo.git(['checkout', '-b', 'task'])
    await repo.write('src/config.ts', `export const key = '${COMMITTED}'\n`)
    await repo.commit('add config')
    await repo.write('README.md', `${EDITED}\n`)
    await repo.write('.env.local', `TOKEN=${UNTRACKED}\n`)

    const details = await readTaskGitDetails(repo.runner, { worktreePath: repo.repoPath, baseRef: 'main' })
    const worktree: Worktree = {
      id: 'w1',
      projectId: 'p1',
      name: 'config',
      branch: 'task',
      path: repo.repoPath,
      startedFrom: 'main',
      state: 'ready',
      createdAt: 0,
      task: 'Move the key into config'
    }
    const pane: Terminal = {
      id: 't1',
      worktreeId: 'w1',
      title: 'claude',
      cwd: repo.repoPath,
      shell: '/bin/zsh',
      cols: 80,
      rows: 24,
      running: true,
      busy: false,
      agent: 'claude',
      lastOutputAt: 0
    }
    const snapshot = presenceFor(
      {
        source: {
          projects: () => [{ projectId: 'p1', projectKey: 'key', rosterKeys: ['peer'] }],
          worktrees: () => [worktree],
          terminals: () => [pane],
          details: () => details
        },
        taskDetails: true
      },
      'peer',
      'me',
      1
    )

    const wire = JSON.stringify(snapshot)
    expect([...(snapshot.projects[0]?.worktrees[0]?.paths ?? [])].sort()).toEqual([
      '.env.local',
      'README.md',
      'src/config.ts'
    ])
    for (const secret of [COMMITTED, EDITED, UNTRACKED]) expect(wire).not.toContain(secret)
    // A pane crosses as its facts; nothing on it could hold a line of output.
    expect(Object.keys(snapshot.projects[0]?.worktrees[0]?.panes[0] ?? {}).sort()).toEqual(
      ['agent', 'busy', 'cols', 'id', 'quietForMs', 'rows', 'running', 'shell', 'title'].sort()
    )
  })
})
