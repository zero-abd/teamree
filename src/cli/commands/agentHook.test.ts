// `teamree agent check` and `agent event --context`, as Claude Code's hooks run them:
// hook JSON on stdin, the documented `hookSpecificOutput` on stdout when a sibling
// overlaps, and nothing at all otherwise, whatever goes wrong.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_RUNTIME_SETTINGS } from '../../shared/settings.js'
import { emptyProjectContext } from '../../shared/memory.js'
import { ExitCode } from '../exit.js'
import type { Streams } from '../output.js'
import { runCli } from '../run.js'
import { NO_REPLY, startStubRuntime, StubError, type StubHandler } from '../stub-runtime.js'

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/claude-${name}.json`, import.meta.url), 'utf8')

const TERMINAL = {
  id: 't_1',
  worktreeId: 'wt_1',
  title: 'claude',
  cwd: '/repos/api-fix-login',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy: false,
  lastOutputAt: 0
}

const WARNING = [
  'rate-limits (sibling: "Add per-user rate limits") also changes src/auth.ts — would conflict.',
  'Coordinate first: teamree msg ask --to rate-limits "<question>", or pick another file.'
].join('\n')

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function harness(handler: StubHandler, discovery: 'fresh' | 'none' = 'fresh') {
  const stub = await startStubRuntime(handler)
  cleanups.push(() => stub.close())
  const dir = mkdtempSync(join(tmpdir(), 'teamree-agent-hook-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  if (discovery === 'fresh') {
    writeFileSync(
      join(dir, 'runtime.json'),
      JSON.stringify({ endpoint: stub.endpoint, pid: process.pid, version: '0.0.1', startedAt: Date.now() })
    )
  }
  const run = async (argv: string[], stdin = ''): Promise<{ code: number; out: string; err: string }> => {
    let out = ''
    let err = ''
    const streams: Streams = { out: (text) => (out += text), err: (text) => (err += text) }
    const code = await runCli([...argv, '--user-data-dir', dir], {
      streams,
      env: {},
      cwd: '/work',
      stdin: async () => stdin
    })
    return { code, out, err }
  }
  return { stub, run }
}

const check = (text: string, path = '/repos/api-fix-login/src/auth.ts'): StubHandler => {
  return (method) => {
    if (method === 'memory.check') return { worktreeId: 'wt_1', path, siblings: [], text }
    throw new StubError('not_found', method)
  }
}

describe('agent check, before an edit', () => {
  it('hands Claude Code the warning as PreToolUse additionalContext, and never a decision', async () => {
    const { stub, run } = await harness(check(WARNING))
    const result = await run(['agent', 'check', '--terminal', 't_1', '--timeout', '1000'], fixture('pre-tool-use-edit'))

    expect(result).toEqual({
      code: ExitCode.Success,
      out: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: WARNING } })}\n`,
      err: ''
    })
    const output = JSON.parse(result.out) as { hookSpecificOutput: Record<string, unknown> }
    expect(output.hookSpecificOutput).not.toHaveProperty('permissionDecision')
    expect(stub.received).toEqual([
      {
        id: expect.any(String),
        method: 'memory.check',
        params: { terminalId: 't_1', path: '/repos/api-fix-login/src/auth.ts', hook: true }
      }
    ])
  })

  it('reads the target of a Write, and of a MultiEdit given relative to the session’s folder', async () => {
    const { stub, run } = await harness(check(''))
    await run(['agent', 'check', '--terminal', 't_1'], fixture('pre-tool-use-write'))
    await run(['agent', 'check', '--terminal', 't_1'], fixture('pre-tool-use-multiedit'))
    expect(stub.received.map((request) => (request.params as { path: string }).path)).toEqual([
      '/repos/api-fix-login/src/limiter.ts',
      '/repos/api-fix-login/src/routes.ts'
    ])
  })

  it('prints nothing when no sibling shares the file', async () => {
    const { run } = await harness(check(''))
    expect(await run(['agent', 'check', '--terminal', 't_1'], fixture('pre-tool-use-edit'))).toEqual({
      code: ExitCode.Success,
      out: '',
      err: ''
    })
  })

  describe('fails open', () => {
    it('on a runtime error', async () => {
      const { run } = await harness(() => {
        throw new StubError('internal', 'boom')
      })
      expect(await run(['agent', 'check', '--terminal', 't_1'], fixture('pre-tool-use-edit'))).toEqual({
        code: ExitCode.Success,
        out: '',
        err: ''
      })
    })

    it('with no runtime running', async () => {
      const { run } = await harness(check(WARNING), 'none')
      expect(await run(['agent', 'check', '--terminal', 't_1'], fixture('pre-tool-use-edit'))).toEqual({
        code: ExitCode.Success,
        out: '',
        err: ''
      })
    })

    it('on a runtime that does not answer in time', async () => {
      const { run } = await harness(() => NO_REPLY)
      const started = Date.now()
      const result = await run(
        ['agent', 'check', '--terminal', 't_1', '--timeout', '100'],
        fixture('pre-tool-use-edit')
      )
      expect(result).toEqual({ code: ExitCode.Success, out: '', err: '' })
      expect(Date.now() - started).toBeLessThan(2000)
    })

    it('on stdin that is not the hook’s JSON, without calling the runtime', async () => {
      const { stub, run } = await harness(check(WARNING))
      for (const stdin of ['', 'not json', '[]', JSON.stringify({ tool_name: 'Edit', tool_input: {} })]) {
        expect(await run(['agent', 'check', '--terminal', 't_1'], stdin)).toEqual({
          code: ExitCode.Success,
          out: '',
          err: ''
        })
      }
      expect(stub.received).toEqual([])
    })
  })
})

describe('agent event --context, at session start', () => {
  const sessionStart = (settings: object, text: string): StubHandler => {
    return (method, params) => {
      if (method === 'terminal.agentEvent') return TERMINAL
      if (method === 'settings.get') return { ...DEFAULT_RUNTIME_SETTINGS, ...settings }
      if (method === 'project.context') {
        return { ...emptyProjectContext((params as { worktreeId: string }).worktreeId), text }
      }
      throw new StubError('not_found', method)
    }
  }
  const argv = ['agent', 'event', '--terminal', 't_1', '--event', 'SessionStart', '--context']
  const bundle = [
    'goal: Fix login redirect',
    'sibling rate-limits: Add per-user rate limits',
    '  conflict: src/auth.ts'
  ]

  it('adds the overlap to the session in under 400 tokens, after reporting the event', async () => {
    const { stub, run } = await harness(sessionStart({}, bundle.join('\n')))
    const result = await run(argv, fixture('session-start'))
    const context = ['teamree: live sibling worktrees overlap this one.', ...bundle].join('\n')
    expect(result).toEqual({
      code: ExitCode.Success,
      out: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } })}\n`,
      err: ''
    })
    expect(stub.received.map((request) => request.method)).toEqual([
      'terminal.agentEvent',
      'settings.get',
      'project.context'
    ])
    expect(stub.received[2]?.params).toEqual({ worktreeId: 'wt_1', budgetTokens: 380, format: 'text' })
  })

  it('heads earlier work from Jac Graph Memory as such when nothing overlaps', async () => {
    const earlier = 'earlier: #7 rate-limit-the-api (merged): Counters live in the database'
    const { run } = await harness(sessionStart({}, earlier))
    const context = `teamree: earlier work like this task.\n${earlier}`
    expect((await run(argv, fixture('session-start'))).out).toBe(
      `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } })}\n`
    )
  })

  it('prints nothing when nothing overlaps', async () => {
    const { run } = await harness(sessionStart({}, ''))
    expect((await run(argv, fixture('session-start'))).out).toBe('')
  })

  it('prints nothing, and asks for no context, with Warn Agents About Overlaps off', async () => {
    const { stub, run } = await harness(sessionStart({ warnAgentsAboutOverlaps: false }, bundle.join('\n')))
    expect(await run(argv, fixture('session-start'))).toEqual({ code: ExitCode.Success, out: '', err: '' })
    expect(stub.received.map((request) => request.method)).not.toContain('project.context')
  })

  it('stays silent without --context, as every other event does', async () => {
    const { stub, run } = await harness(sessionStart({}, bundle.join('\n')))
    expect((await run(argv.slice(0, -1), fixture('session-start'))).out).toBe('')
    expect(stub.received.map((request) => request.method)).toEqual(['terminal.agentEvent'])
  })
})
