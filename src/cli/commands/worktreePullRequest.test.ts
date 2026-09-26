// `worktree pr`: commit, push and open a pull request in one command, from wherever the branch stands.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Worktree, WorktreeLanding, WorktreeStatus } from '../../shared/entities.js'
import { PANE_IDENTITY_ENV } from '../../shared/tasks.js'
import { ExitCode } from '../exit.js'
import type { Streams } from '../output.js'
import { runCli } from '../run.js'
import { StubError, startStubRuntime, type StubRuntime } from '../stub-runtime.js'

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
const HERE = { [PANE_IDENTITY_ENV.worktreeId]: 'w1', [PANE_IDENTITY_ENV.terminalId]: 't1' }

const landing = (overrides: Partial<WorktreeLanding> = {}): WorktreeLanding => ({
  worktreeId: 'w1',
  branch: 'fix-login',
  base: 'main',
  host: 'github',
  published: true,
  unmerged: 1,
  merged: false,
  readAt: 0,
  ...overrides
})
const status = (overrides: Partial<WorktreeStatus> = {}): WorktreeStatus => ({
  worktreeId: 'w1',
  branch: 'fix-login',
  upstream: 'origin/fix-login',
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  readAt: 0,
  ...overrides
})
const MADE = { worktreeId: 'w1', url: 'https://github.com/o/r/pull/12', number: 12, created: true }
const PUSHED = { worktreeId: 'w1', branch: 'fix-login', remote: 'origin', upstream: 'origin/fix-login' }

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function cli(
  answers: Record<string, (params: unknown) => unknown>
): Promise<{ stub: StubRuntime; run: (argv: string[]) => Promise<{ code: number; out: string }> }> {
  const stub = await startStubRuntime((method, params) => {
    if (method === 'worktree.list') return [WORKTREE]
    const answer = answers[method]
    if (answer === undefined) throw new StubError('unknown_method', method)
    return answer(params)
  })
  cleanups.push(() => stub.close())
  const dir = mkdtempSync(join(tmpdir(), 'teamree-pr-'))
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
  return {
    stub,
    run: async (argv) => {
      let out = ''
      const streams: Streams = { out: (text) => (out += text), err: (text) => (out += text) }
      const env = { ...HERE, TEAMREE_USER_DATA_DIR: dir }
      return { code: await runCli(argv, { streams, env, cwd: '/elsewhere' }), out }
    }
  }
}

const STEPS = ['worktree.commit', 'worktree.push', 'worktree.createPullRequest']
const methods = (stub: StubRuntime): string[] =>
  stub.received.map((call) => call.method).filter((method) => method !== 'worktree.list')
const sent = (stub: StubRuntime, method: string): unknown[] =>
  stub.received.filter((call) => call.method === method).map((call) => call.params)

describe('worktree pr', () => {
  it('commits, publishes and creates from a dirty, unpublished branch, here by default', async () => {
    const { stub, run } = await cli({
      'worktree.landing': () => landing({ published: false }),
      'worktree.status': () => status({ upstream: null, unstaged: 2 }),
      'worktree.commit': () => ({ worktreeId: 'w1', sha: 'abc', shortSha: 'abc', message: 'Fix login', paths: [] }),
      'worktree.push': () => PUSHED,
      'worktree.createPullRequest': () => MADE
    })
    const result = await run(['worktree', 'pr', '-m', 'Fix login'])

    expect(result.code).toBe(ExitCode.Success)
    expect(methods(stub).filter((method) => STEPS.includes(method))).toEqual(STEPS)
    expect(sent(stub, 'worktree.commit')).toEqual([{ worktreeId: 'w1', message: 'Fix login', all: true }])
    expect(sent(stub, 'worktree.createPullRequest')).toEqual([{ worktreeId: 'w1' }])
    expect(result.out).toContain('Pull request #12:\nhttps://github.com/o/r/pull/12')
  })

  it('only creates once the host has every commit, as a draft with the title given', async () => {
    const { stub, run } = await cli({
      'worktree.landing': () => landing(),
      'worktree.status': () => status(),
      'worktree.createPullRequest': () => MADE
    })
    const result = await run(['worktree', 'pr', 'here', '--draft', '--title', 'Fix the login loop'])

    expect(result.code).toBe(ExitCode.Success)
    expect(sent(stub, 'worktree.push')).toEqual([])
    expect(sent(stub, 'worktree.createPullRequest')).toEqual([
      { worktreeId: 'w1', title: 'Fix the login loop', draft: true }
    ])
  })

  it('pushes the commits a published branch has not sent', async () => {
    const { stub, run } = await cli({
      'worktree.landing': () => landing(),
      'worktree.status': () => status({ ahead: 2 }),
      'worktree.push': () => PUSHED,
      'worktree.createPullRequest': () => MADE
    })
    expect((await run(['worktree', 'pr'])).code).toBe(ExitCode.Success)
    expect(sent(stub, 'worktree.push')).toHaveLength(1)
  })

  it('names the step that failed, after the ones that ran', async () => {
    const { stub, run } = await cli({
      'worktree.landing': () => landing({ published: false }),
      'worktree.status': () => status({ upstream: null, ahead: 1 }),
      'worktree.push': () => {
        throw new StubError('git_failed', 'rejected: fetch first')
      },
      'worktree.createPullRequest': () => MADE
    })
    const result = await run(['worktree', 'pr'])

    expect(result.code).toBe(ExitCode.Failure)
    expect(result.out).toContain('Publish failed: rejected: fetch first')
    expect(sent(stub, 'worktree.createPullRequest')).toEqual([])
  })

  it('asks for a message before committing, and refuses a branch that lands by merging', async () => {
    const dirty = await cli({
      'worktree.landing': () => landing(),
      'worktree.status': () => status({ untracked: 1 })
    })
    const refused = await dirty.run(['worktree', 'pr'])
    expect(refused.code).toBe(ExitCode.Failure)
    expect(refused.out).toContain('1 uncommitted; pass --message')
    expect(sent(dirty.stub, 'worktree.commit')).toEqual([])

    const child = await cli({
      'worktree.landing': () => landing({ host: null, parent: { worktreeId: 'w0', name: 'rework auth' } }),
      'worktree.status': () => status()
    })
    const merged = await child.run(['worktree', 'pr'])
    expect(merged.code).toBe(ExitCode.Failure)
    expect(merged.out).toContain('teamree worktree land')
  })
})
