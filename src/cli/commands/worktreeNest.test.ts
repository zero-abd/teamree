// `worktree nest`: which worktree goes where, what it sends, and what it says back.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Worktree } from '../../shared/entities.js'
import type { WorktreeNest } from '../../shared/nesting.js'
import type { Streams } from '../output.js'
import { runCli } from '../run.js'
import { StubError, startStubRuntime, type StubRuntime } from '../stub-runtime.js'

const row = (id: string, name: string, parentId?: string): Worktree => ({
  id,
  projectId: 'p1',
  name,
  branch: name.replace(/ /g, '-'),
  path: `/wt/api/${name.replace(/ /g, '-')}`,
  startedFrom: 'main',
  state: 'ready',
  createdAt: 1,
  ...(parentId === undefined ? {} : { parentId })
})
const WORKTREES = [row('w1', 'rework auth'), row('w2', 'migration', 'w1'), row('w4', 'docs')]

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

type Answer = (params: { worktreeId: string; parentId: string | null; dryRun?: boolean }) => WorktreeNest

async function cli(
  answer: Answer,
  env: NodeJS.ProcessEnv = {}
): Promise<{ stub: StubRuntime; run: (argv: string[]) => Promise<{ code: number; out: string }> }> {
  const stub = await startStubRuntime((method, params) => {
    if (method === 'worktree.list') return WORKTREES
    if (method === 'worktree.nest') return answer(params as Parameters<Answer>[0])
    throw new StubError('unknown_method', method)
  })
  cleanups.push(() => stub.close())
  const dir = mkdtempSync(join(tmpdir(), 'teamree-nest-'))
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
      const code = await runCli(argv, { streams, env: { ...env, TEAMREE_USER_DATA_DIR: dir }, cwd: '/elsewhere' })
      return { code, out }
    }
  }
}

const sent = (stub: StubRuntime): unknown => stub.received.find((call) => call.method === 'worktree.nest')?.params
const moved =
  (change: WorktreeNest['change'], extra: Partial<WorktreeNest> = {}): Answer =>
  ({ worktreeId, parentId, dryRun }) => ({
    worktree: {
      ...(WORKTREES.find((worktree) => worktree.id === worktreeId) as Worktree),
      ...(parentId ? { parentId } : {})
    },
    change,
    dryRun: dryRun === true,
    ...extra
  })

describe('worktree nest', () => {
  it('--under sends the move and says where it went', async () => {
    const { stub, run } = await cli(moved('nest'))
    const result = await run(['worktree', 'nest', 'docs', '--under', 'w1'])
    expect(result).toEqual({ code: 0, out: 'nested docs under rework auth\n' })
    expect(sent(stub)).toEqual({ worktreeId: 'w4', parentId: 'w1' })
  })

  it('here is the calling pane, which goes along for the limits; --rebase is passed through', async () => {
    const { stub, run } = await cli(moved('rebase'), { TEAMREE_WORKTREE_ID: 'w4', TEAMREE_TERMINAL_ID: 'term_7' })
    const result = await run(['worktree', 'nest', 'here', '--under', 'migration', '--rebase'])
    expect(result.out).toBe('rebased docs onto migration and nested it under migration\n')
    expect(sent(stub)).toEqual({ worktreeId: 'w4', parentId: 'w2', rebase: true, fromTerminalId: 'term_7' })
  })

  it('--top with --dry-run names the commits the diff would gain', async () => {
    const { stub, run } = await cli(moved('unnest', { inherited: 3 }))
    const result = await run(['worktree', 'nest', 'w2', '--top', '--dry-run'])
    expect(result.out).toBe('would move migration to the top level; 3 commits from rework auth will show in the diff\n')
    expect(sent(stub)).toEqual({ worktreeId: 'w2', parentId: null, dryRun: true })
  })

  it('says when nothing moved, and a dry run that needs a rebase says so', async () => {
    expect((await (await cli(moved('none'))).run(['worktree', 'nest', 'w2', '--under', 'w1'])).out).toBe(
      'migration is already under rework auth\n'
    )
    expect((await (await cli(moved('rebase'))).run(['worktree', 'nest', 'w4', '--under', 'w1', '--dry-run'])).out).toBe(
      'would rebase docs onto rework-auth and nest it under rework auth\n'
    )
  })

  it('needs exactly one of --under and --top', async () => {
    const { stub, run } = await cli(moved('nest'))
    expect((await run(['worktree', 'nest', 'w4'])).code).not.toBe(0)
    expect((await run(['worktree', 'nest', 'w4', '--under', 'w1', '--top'])).code).not.toBe(0)
    expect(sent(stub)).toBeUndefined()
  })

  it("passes the runtime's refusal through with its reason", async () => {
    const { run } = await cli(() => {
      throw new StubError('conflict', 'Would conflict in 3 files')
    })
    const result = await run(['worktree', 'nest', 'w4', '--under', 'w1', '--rebase', '--json'])
    expect(result.code).not.toBe(0)
    expect(JSON.parse(result.out)).toMatchObject({
      ok: false,
      error: { code: 'conflict', message: 'Would conflict in 3 files' }
    })
  })
})
