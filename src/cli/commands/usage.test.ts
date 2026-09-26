// `worktree usage` against a stub runtime: which worktrees it asks for, and what it prints with
// Show Cost off and on.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Project, Worktree } from '../../shared/entities.js'
import type { WorktreeUsage } from '../../shared/tasks.js'
import type { Streams } from '../output.js'
import { runCli } from '../run.js'
import { StubError, startStubRuntime, type StubRuntime } from '../stub-runtime.js'

const PROJECT: Project = { id: 'p1', name: 'api', path: '/repos/api', baseRef: 'main' }
const row = (id: string, name: string, parentId?: string): Worktree => ({
  id,
  projectId: 'p1',
  name,
  branch: name,
  path: `/wt/api/${name}`,
  startedFrom: 'main',
  state: 'ready',
  createdAt: 1,
  ...(parentId === undefined ? {} : { parentId })
})
const WORKTREES = [row('w1', 'rework'), row('w2', 'migration', 'w1'), row('w3', 'docs')]

const usage = (worktreeId: string, output: number, extra: Partial<WorktreeUsage> = {}): WorktreeUsage => ({
  worktreeId,
  input: 0,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: output / 1e5,
  sessions: 1,
  unknownPanes: 0,
  readAt: 1,
  ...extra
})
const USAGE = [
  usage('w1', 1_200_000, {
    subtree: { input: 0, output: 3_400_000, cacheRead: 0, cacheWrite: 0, costUsd: 34, sessions: 2 }
  }),
  usage('w2', 2_200_000),
  usage('w3', 0, { sessions: 0, costUsd: 0, unknownPanes: 1 })
]

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function cli(
  showCost: boolean,
  env: NodeJS.ProcessEnv = {}
): Promise<{ stub: StubRuntime; run: (argv: string[]) => Promise<{ code: number; out: string }> }> {
  const stub = await startStubRuntime((method, params) => {
    if (method === 'project.list') return [PROJECT]
    if (method === 'worktree.list') return WORKTREES
    if (method === 'settings.get')
      return { shareTaskDetails: true, showCost, jacMemoryAddon: false, showInMenuBar: true }
    if (method === 'worktree.usage') {
      const { worktreeId } = params as { worktreeId?: string }
      return worktreeId === undefined ? USAGE : USAGE.filter((each) => each.worktreeId === worktreeId)
    }
    throw new StubError('unknown_method', method)
  })
  cleanups.push(() => stub.close())
  const dir = mkdtempSync(join(tmpdir(), 'teamree-usage-cli-'))
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

const asked = (stub: StubRuntime): unknown => stub.received.find((call) => call.method === 'worktree.usage')?.params

describe('worktree usage', () => {
  it('prints tokens only, in tree order, with the parent’s total beside it', async () => {
    const { stub, run } = await cli(false)
    const result = await run(['worktree', 'usage'])
    expect(result.code).toBe(0)
    expect(asked(stub)).toEqual({})
    expect(result.out.trimEnd().split('\n')).toEqual([
      'NAME         TOKENS    WITH CHILDREN',
      'rework       1.2M tok  3.4M tok',
      '  migration  2.2M tok',
      'docs         ? tok'
    ])
  })

  it('adds ≈$ with Show Cost on', async () => {
    const { run } = await cli(true)
    expect((await run(['worktree', 'usage'])).out).toContain('1.2M tok · ≈$12.00  3.4M tok · ≈$34.00')
  })

  it('here is the calling pane’s worktree, and --json is the runtime’s answer', async () => {
    const { stub, run } = await cli(false, { TEAMREE_WORKTREE_ID: 'w2', TEAMREE_TERMINAL_ID: 'term_7' })
    const result = await run(['worktree', 'usage', 'here', '--json'])
    expect(asked(stub)).toEqual({ worktreeId: 'w2' })
    expect(JSON.parse(result.out)).toMatchObject({ ok: true, data: [{ worktreeId: 'w2', output: 2_200_000 }] })
  })

  it('narrows to a project', async () => {
    const { stub, run } = await cli(false)
    await run(['worktree', 'usage', '--project', 'api'])
    expect(asked(stub)).toEqual({ projectId: 'p1' })
  })
})
