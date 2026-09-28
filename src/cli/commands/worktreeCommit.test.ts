// `worktree commit` refused by a hook: git's one line is not enough to fix what the hook found.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { GitHookFailedData, Worktree } from '../../shared/entities.js'
import { ExitCode } from '../exit.js'
import { runCli } from '../run.js'
import { StubError, startStubRuntime } from '../stub-runtime.js'

const WORKTREE: Worktree = {
  id: 'w1',
  projectId: 'p1',
  name: 'fix login',
  branch: 'fix-login',
  path: '/wt/api/fix-login',
  startedFrom: 'main',
  state: 'ready',
  createdAt: 1
}
const OUTPUT = [
  'lint failed',
  'src/app.ts:3:1  no-unused-vars  x is never read',
  'src/app.ts:9:5  eqeqeq',
  '… 4 more lines'
].join('\n')

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

it('prints a refusing hook’s whole output to stderr and exits non-zero', async () => {
  const stub = await startStubRuntime((method) => {
    if (method === 'worktree.list') return [WORKTREE]
    const data: GitHookFailedData = { kind: 'hook', hook: 'pre-commit', output: OUTPUT }
    throw new StubError('git_failed', 'pre-commit hook failed: lint failed', data)
  })
  cleanups.push(() => stub.close())
  const dir = mkdtempSync(join(tmpdir(), 'teamree-commit-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const runtime = {
    endpoint: stub.endpoint,
    pid: process.pid,
    version: '0.0.1',
    platform: process.platform,
    startedAt: 1
  }
  writeFileSync(join(dir, 'runtime.json'), JSON.stringify(runtime))
  let out = ''
  let err = ''
  const code = await runCli(['worktree', 'commit', 'w1', '-m', 'Fix login'], {
    streams: { out: (text) => (out += text), err: (text) => (err += text) },
    env: { TEAMREE_USER_DATA_DIR: dir },
    cwd: '/elsewhere'
  })

  expect(code).toBe(ExitCode.Failure)
  expect(out).toBe('')
  expect(err).toBe(`error: pre-commit hook failed: lint failed\n${OUTPUT}\n`)
})
