// `worktree diff --base`: the whole branch against its base, asked of the runtime as one flag.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Worktree } from '../../shared/entities.js'
import type { Streams } from '../output.js'
import { runCli } from '../run.js'
import { StubError, startStubRuntime } from '../stub-runtime.js'

const WORKTREE: Worktree = {
  id: 'w1',
  projectId: 'p1',
  name: 'fix typo',
  branch: 'fix-typo',
  path: '/wt/api/fix-typo',
  startedFrom: 'main',
  state: 'ready',
  createdAt: 1
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

it('sends base and prints the patch as git wrote it', async () => {
  const stub = await startStubRuntime((method, params) => {
    if (method === 'worktree.list') return [WORKTREE]
    if (method === 'worktree.diff') {
      return {
        worktreeId: 'w1',
        staged: false,
        patch: 'diff --git a/README.md b/README.md\n',
        truncated: false,
        readAt: 1
      }
    }
    throw new StubError('unknown_method', `${method} ${JSON.stringify(params)}`)
  })
  cleanups.push(() => stub.close())
  const dir = mkdtempSync(join(tmpdir(), 'teamree-diff-base-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(
    join(dir, 'runtime.json'),
    JSON.stringify({
      endpoint: stub.endpoint,
      pid: process.pid,
      version: '0.0.1',
      platform: process.platform,
      startedAt: 1
    })
  )
  let out = ''
  const streams: Streams = { out: (text) => (out += text), err: (text) => (out += text) }

  const code = await runCli(['worktree', 'diff', 'fix typo', '--base'], {
    streams,
    env: { TEAMREE_USER_DATA_DIR: dir },
    cwd: '/elsewhere'
  })

  expect(code).toBe(0)
  expect(stub.received.find((call) => call.method === 'worktree.diff')?.params).toEqual({
    worktreeId: 'w1',
    base: true
  })
  expect(out).toContain('diff --git a/README.md b/README.md')
})
