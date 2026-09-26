import { describe, expect, it } from 'vitest'
import { emptyProjectContext } from '../../shared/memory.js'
import type { Streams } from '../output.js'
import { runCli } from '../run.js'
import { startStubRuntime, StubError } from '../stub-runtime.js'
import { contextText } from './context.js'

describe('teamree context', () => {
  it('says so in one line when nothing overlaps, and prints nothing with --text', () => {
    expect(contextText(emptyProjectContext('w1'), false)).toBe('No overlap.')
    expect(contextText(emptyProjectContext('w1'), true)).toBe('')
  })

  it('prints the bundle, and what the budget cut', () => {
    const context = { ...emptyProjectContext('w1'), text: 'goal: x', truncated: [{ section: 'siblings', dropped: 2 }] }
    expect(contextText(context, false)).toBe('goal: x\n(cut: 2 siblings)')
    expect(contextText(context, true)).toBe('goal: x')
  })
})

describe('teamree context --check', () => {
  it('asks about one file, resolved from where it runs, and says so when nothing shares it', async () => {
    const texts = ['', 'b (sibling) also changes src/a.ts.']
    const worktree = { id: 'w1', projectId: 'p1', name: 'w1', branch: 'w1', path: '/repo', state: 'ready' }
    const stub = await startStubRuntime((method, params) => {
      if (method === 'worktree.list') return [worktree]
      if (method === 'memory.check') return { worktreeId: 'w1', path: 'src/a.ts', siblings: [], text: texts.shift() }
      throw new StubError('not_found', `${method} ${JSON.stringify(params)}`)
    })
    try {
      let out = ''
      const streams: Streams = { out: (text) => (out += text), err: () => {} }
      const argv = ['context', '--worktree', 'w1', '--check', 'a.ts', '--endpoint', stub.endpoint]
      expect(await runCli(argv, { streams, env: {}, cwd: '/repo/src' })).toBe(0)
      expect(await runCli(argv, { streams, env: {}, cwd: '/repo/src' })).toBe(0)
      expect(out).toBe('No overlap.\nb (sibling) also changes src/a.ts.\n')
      const checks = stub.received.filter((request) => request.method === 'memory.check')
      expect(checks.map((request) => request.params)).toEqual([
        { worktreeId: 'w1', path: '/repo/src/a.ts' },
        { worktreeId: 'w1', path: '/repo/src/a.ts' }
      ])
    } finally {
      await stub.close()
    }
  })
})
