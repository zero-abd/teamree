// A same-size edit whose timestamps match the index entry must still reach the copy.

import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createGitRunner } from './gitProcess'
import { createTempRepo, type TempRepo } from './testRepository'
import { snapshotWorktree } from './worktreeTrash'

const repos: TempRepo[] = []
afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

it('copies an edit git would only catch by reading the file (racily clean entry)', async () => {
  const repo = await createTempRepo()
  repos.push(repo)
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo.repoPath, encoding: 'utf8' }).trim()
  await repo.write('src/math.ts', 'export const add = (a, b) => a + b\n')
  await repo.commit('add math')
  git('config', 'core.trustctime', 'false')

  const file = path.join(repo.repoPath, 'src/math.ts')
  const stamp = path.join(repo.repoPath, '.git', 'stamp')
  // `touch -r` copies nanoseconds, which a Date cannot carry.
  execFileSync('touch', ['-r', file, stamp])
  // Same size, same timestamps as the index entry: only git's racy-clean check can see this.
  await writeFile(file, 'export const sub = (a, b) => a - b\n')
  execFileSync('touch', ['-r', stamp, file])
  // The real index is as new as the entry, so git treats the entry as racy and reads the file.
  execFileSync('touch', ['-r', stamp, path.join(repo.repoPath, '.git', 'index')])
  // A second later the copy is taken, as when a delete follows an agent's quick edit.
  await new Promise((resolve) => setTimeout(resolve, 1100))

  const entry = await snapshotWorktree(createGitRunner(), {
    repoPath: repo.repoPath,
    worktree: {
      id: 'wt_1',
      projectId: 'proj_1',
      name: 'math',
      branch: 'main',
      path: repo.repoPath,
      startedFrom: 'main',
      createdAt: 1
    },
    worktreePath: repo.repoPath,
    kind: 'remove',
    now: 1
  })
  expect(git('show', `${entry.sha}:src/math.ts`)).toBe('export const sub = (a, b) => a - b')
})
