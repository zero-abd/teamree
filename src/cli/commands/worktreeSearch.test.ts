// `worktree search` end to end against a stub runtime: the scope it asks for,
// and grep-shaped lines out of the streamed batches.

import { afterEach, describe, expect, it } from 'vitest'
import type { WorktreeSearchEvent } from '../../shared/search.js'
import type { Streams } from '../output.js'
import { runCli } from '../run.js'
import { startStubRuntime, type StubRuntime } from '../stub-runtime.js'

const WORKTREES = [
  {
    id: 'wt_1',
    projectId: 'p_api',
    name: 'auth',
    branch: 'auth',
    path: '/r/a',
    startedFrom: 'main',
    state: 'ready',
    createdAt: 1
  },
  {
    id: 'wt_2',
    projectId: 'p_api',
    name: 'rate',
    branch: 'rate',
    path: '/r/b',
    startedFrom: 'main',
    state: 'ready',
    createdAt: 2
  }
]

const EVENTS: WorktreeSearchEvent[] = [
  {
    type: 'hits',
    files: [
      { worktreeId: 'wt_1', path: 'src/a.ts', lines: [{ line: 3, column: 1, text: 'limit()', ranges: [[0, 5]] }] }
    ]
  },
  {
    type: 'hits',
    files: [
      { worktreeId: 'wt_2', path: 'src/b.ts', lines: [{ line: 9, column: 3, text: '  limit(2)', ranges: [[2, 7]] }] }
    ]
  },
  { type: 'done', matches: 2, truncated: false, timedOut: false, elapsedMs: 12, engine: 'git' }
]

let stub: StubRuntime | null = null

afterEach(async () => {
  await stub?.close()
  stub = null
})

async function run(argv: string[]): Promise<{ out: string; params: unknown }> {
  stub = await startStubRuntime((method, _params, context) => {
    if (method === 'worktree.list') return WORKTREES
    if (method === 'worktree.search') {
      setTimeout(() => EVENTS.forEach((event) => context.emit('s1', event)), 5)
      return { subscription: 's1' }
    }
    return {}
  })
  let out = ''
  const streams: Streams = { out: (text) => (out += text), err: () => {} }
  await runCli([...argv, '--endpoint', stub.endpoint], { streams, env: {}, cwd: '/work' })
  return { out, params: stub.received.find((request) => request.method === 'worktree.search')?.params }
}

describe('worktree search', () => {
  it('searches one worktree with the options as asked', async () => {
    const { params } = await run(['worktree', 'search', 'auth', 'limit(', '--case', '--include', '*.ts'])
    expect(params).toEqual({ worktreeId: 'wt_1', query: 'limit(', caseSensitive: true, include: ['*.ts'] })
  })

  it('searches the project with --all and prints task:path:line:text', async () => {
    const { out, params } = await run(['worktree', 'search', 'auth', 'limit', '--all'])
    expect(params).toEqual({ projectId: 'p_api', query: 'limit' })
    expect(out.trim().split('\n')).toEqual([
      'auth:src/a.ts:3:limit()',
      'rate:src/b.ts:9:  limit(2)',
      '',
      '2 matches in 2 files'
    ])
  })
})
