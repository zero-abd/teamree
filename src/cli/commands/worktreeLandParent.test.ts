// `worktree land` and `worktree update` on a child: here from the pane, into and from its parent.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Worktree, WorktreeLanding, WorktreeMerge, WorktreeUpdate } from '../../shared/entities.js'
import { PANE_IDENTITY_ENV } from '../../shared/tasks.js'
import type { Streams } from '../output.js'
import { runCli } from '../run.js'
import { StubError, startStubRuntime, type StubRuntime } from '../stub-runtime.js'

const row = (id: string, name: string, branch: string, parentId?: string): Worktree => ({
  id,
  projectId: 'p1',
  name,
  branch,
  path: `/wt/api/${branch}`,
  startedFrom: 'main',
  state: 'ready',
  createdAt: 1,
  ...(parentId === undefined ? {} : { parentId, baseRef: 'rework-auth' })
})
const WORKTREES = [row('w1', 'rework auth', 'rework-auth'), row('w2', 'tests', 'rework-auth--tests', 'w1')]
const IN_CHILD = { [PANE_IDENTITY_ENV.worktreeId]: 'w2', [PANE_IDENTITY_ENV.terminalId]: 't2' }

const LANDING: WorktreeLanding = {
  worktreeId: 'w2',
  branch: 'rework-auth--tests',
  base: 'rework-auth',
  host: null,
  published: false,
  unmerged: 2,
  merged: false,
  readAt: 0,
  parent: { worktreeId: 'w1', name: 'rework auth' }
}
const MERGE: WorktreeMerge = {
  worktreeId: 'w2',
  into: 'rework-auth',
  checkout: '/wt/api/rework-auth',
  commits: [],
  fastForward: true,
  dirty: [],
  merged: true
}
const update = (overrides: Partial<WorktreeUpdate> = {}): WorktreeUpdate => ({
  worktreeId: 'w2',
  baseRef: 'rework-auth',
  mode: 'rebase',
  outcome: 'updated',
  conflicts: [],
  updatedAt: 0,
  ...overrides
})

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function cli(
  answers: Record<string, (params: unknown) => unknown>
): Promise<{ stub: StubRuntime; run: (argv: string[]) => Promise<{ code: number; out: string }> }> {
  const stub = await startStubRuntime((method, params) => {
    if (method === 'worktree.list') return WORKTREES
    const answer = answers[method]
    if (answer === undefined) throw new StubError('unknown_method', method)
    return answer(params)
  })
  cleanups.push(() => stub.close())
  const dir = mkdtempSync(join(tmpdir(), 'teamree-land-'))
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
      const env = { ...IN_CHILD, TEAMREE_USER_DATA_DIR: dir }
      return { code: await runCli(argv, { streams, env, cwd: '/elsewhere' }), out }
    }
  }
}

const sent = (stub: StubRuntime, method: string): unknown[] =>
  stub.received.filter((call) => call.method === method).map((call) => call.params)

describe('worktree land here, from a child', () => {
  it('merges into the parent, even with --merge absent', async () => {
    const { stub, run } = await cli({ 'worktree.landing': () => LANDING, 'worktree.mergeIntoBase': () => MERGE })
    const result = await run(['worktree', 'land', 'here'])

    expect(result.code).toBe(0)
    expect(sent(stub, 'worktree.mergeIntoBase')).toEqual([{ worktreeId: 'w2' }])
    expect(result.out).toBe('Merged rework-auth--tests into rework auth (fast-forward).\n')
  })

  it("says the parent's refusal and exits non-zero", async () => {
    const { run } = await cli({
      'worktree.landing': () => LANDING,
      'worktree.mergeIntoBase': () => {
        throw new StubError('conflict', "rework auth's agent is working")
      }
    })
    const result = await run(['worktree', 'land', 'here'])

    expect(result.code).toBe(1)
    expect(result.out).toContain("rework auth's agent is working")
  })
})

describe('worktree update', () => {
  it('brings the parent into the calling pane’s child', async () => {
    const { stub, run } = await cli({ 'worktree.update': () => update() })
    const result = await run(['worktree', 'update', 'here'])

    expect(result.code).toBe(0)
    expect(sent(stub, 'worktree.update')).toEqual([{ worktreeId: 'w2' }])
    expect(result.out).toBe('Rebased rework-auth--tests onto rework-auth.\n')
  })

  it('says when there was nothing to bring in', async () => {
    const { run } = await cli({ 'worktree.update': () => update({ outcome: 'upToDate' }) })
    expect((await run(['worktree', 'update', 'here'])).out).toBe('rework-auth--tests already has rework-auth.\n')
  })

  it('stops on conflicts with the paths, and --abort undoes it', async () => {
    const { stub, run } = await cli({
      'worktree.update': () => update({ mode: 'merge', outcome: 'conflicts', conflicts: ['auth.ts'] }),
      'worktree.abortUpdate': () => ({ worktreeId: 'w2', aborted: 'merge' })
    })
    const stopped = await run(['worktree', 'update', 'here'])
    expect(stopped.code).toBe(1)
    expect(stopped.out).toContain('Conflicts in auth.ts')

    const aborted = await run(['worktree', 'update', 'here', '--abort'])
    expect(aborted.code).toBe(0)
    expect(sent(stub, 'worktree.abortUpdate')).toEqual([{ worktreeId: 'w2' }])
    expect(aborted.out).toBe('Aborted the merge.\n')
  })
})
