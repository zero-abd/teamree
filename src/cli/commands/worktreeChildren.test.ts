// Child tasks from the CLI: where `create` puts a worktree from inside and outside a pane,
// what `list --tree` prints, and `remove --children`.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Project, Worktree } from '../../shared/entities.js'
import type { Streams } from '../output.js'
import { runCli } from '../run.js'
import { StubError, startStubRuntime, type StubRuntime } from '../stub-runtime.js'
import { listText } from './worktree.js'

const PROJECT: Project = { id: 'p1', name: 'api', path: '/repos/api', baseRef: 'main' }
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
const WORKTREES = [
  row('w1', 'rework auth'),
  row('w2', 'migration', 'w1'),
  row('w3', 'seed', 'w2'),
  row('w4', 'docs'),
  row('w5', 'tests', 'w1')
]

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function cli(
  env: NodeJS.ProcessEnv = {},
  refuse?: string
): Promise<{ stub: StubRuntime; run: (argv: string[]) => Promise<{ code: number; out: string }> }> {
  const stub = await startStubRuntime((method, params) => {
    if (method === 'project.list') return [PROJECT]
    if (method === 'worktree.list') return WORKTREES
    if (method === 'worktree.remove') return { removed: true }
    if (method === 'worktree.create') {
      if (refuse !== undefined) throw new StubError('child_limit', refuse)
      const asked = params as { name: string; parentId?: string }
      return { ...row('w9', asked.name, asked.parentId), state: 'creating' }
    }
    throw new StubError('unknown_method', method)
  })
  cleanups.push(() => stub.close())
  const dir = mkdtempSync(join(tmpdir(), 'teamree-children-'))
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

const created = (stub: StubRuntime): unknown => stub.received.find((call) => call.method === 'worktree.create')?.params
const PANE = { TEAMREE_WORKTREE_ID: 'w2', TEAMREE_TERMINAL_ID: 'term_7' }

describe('worktree create', () => {
  it('--parent here is the pane’s worktree, and the pane goes along for the limits', async () => {
    const { stub, run } = await cli(PANE)
    expect((await run(['worktree', 'create', '--parent', 'here', '--name', 'fixtures', '--json'])).code).toBe(0)
    expect(created(stub)).toEqual({ projectId: 'p1', name: 'fixtures', parentId: 'w2', fromTerminalId: 'term_7' })
  })

  it('makes a child of the pane’s worktree by default, and a top-level task with --top', async () => {
    const child = await cli(PANE)
    await child.run(['worktree', 'create', '--name', 'fixtures'])
    expect(created(child.stub)).toMatchObject({ parentId: 'w2' })

    const top = await cli(PANE)
    expect((await top.run(['worktree', 'create', '--top', '--project', 'api', '--name', 'x'])).code).toBe(0)
    expect(created(top.stub)).toEqual({ projectId: 'p1', name: 'x', fromTerminalId: 'term_7' })
  })

  it('takes an explicit parent id outside a pane, and needs --project without one', async () => {
    const { stub, run } = await cli()
    const result = await run(['worktree', 'create', '--parent', 'w1', '--name', 'migration'])
    expect(result.out).toContain('parent: rework auth')
    expect(created(stub)).toEqual({ projectId: 'p1', name: 'migration', parentId: 'w1' })
    expect((await run(['worktree', 'create', '--name', 'x'])).code).not.toBe(0)
  })

  it('refuses --from with a parent, and --parent with --top', async () => {
    const { stub, run } = await cli()
    expect((await run(['worktree', 'create', '--parent', 'w1', '--from', 'main', '--name', 'x'])).code).not.toBe(0)
    expect((await run(['worktree', 'create', '--parent', 'w1', '--top', '--name', 'x'])).code).not.toBe(0)
    expect(created(stub)).toBeUndefined()
  })

  it('passes the runtime’s child_limit refusal through', async () => {
    const { run } = await cli(PANE, '6 open children under rework auth')
    const result = await run(['worktree', 'create', '--parent', 'w1', '--name', 'x', '--json'])
    expect(result.code).not.toBe(0)
    expect(JSON.parse(result.out)).toMatchObject({
      ok: false,
      error: { code: 'child_limit', message: '6 open children under rework auth' }
    })
  })
})

describe('worktree list', () => {
  it('--tree indents each child under its parent', () => {
    expect(listText(WORKTREES, true)).toBe(
      [
        'ID  NAME         BRANCH       STATE  PATH',
        'w1  rework auth  rework-auth  ready  /wt/api/rework-auth',
        'w2    migration  migration    ready  /wt/api/migration',
        'w3      seed     seed         ready  /wt/api/seed',
        'w5    tests      tests        ready  /wt/api/tests',
        'w4  docs         docs         ready  /wt/api/docs'
      ].join('\n')
    )
  })

  it('names each row’s parent', () => {
    expect(listText(WORKTREES.slice(0, 2), false).split('\n')).toEqual([
      'ID  NAME         BRANCH       STATE  PARENT  PATH',
      'w1  rework auth  rework-auth  ready  -       /wt/api/rework-auth',
      'w2  migration    migration    ready  w1      /wt/api/migration'
    ])
  })
})

describe('worktree remove', () => {
  it('--children takes the whole subtree and says how many went', async () => {
    const { stub, run } = await cli()
    const result = await run(['worktree', 'remove', 'w1', '--children'])
    expect(result.out).toContain('removed worktree rework auth (w1) and 3 children')
    expect(stub.received.find((call) => call.method === 'worktree.remove')?.params).toMatchObject({
      worktreeId: 'w1',
      children: true
    })
  })
})
