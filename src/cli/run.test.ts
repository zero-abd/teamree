import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExitCode } from './exit.js'
import type { Streams } from './output.js'
import { runCli } from './run.js'
import { StubError, startStubRuntime, type StubHandler, type StubRuntime } from './stub-runtime.js'

const PROJECTS = [
  { id: 'p_api', name: 'api', path: '/repos/api', baseRef: 'origin/main' },
  { id: 'p_web', name: 'web', path: '/repos/web', baseRef: 'origin/main' }
]

const WORKTREES = [
  {
    id: 'wt_1',
    projectId: 'p_api',
    name: 'fix-login',
    branch: 'feature/fix-login',
    path: '/repos/api-fix-login',
    startedFrom: 'origin/main',
    state: 'ready',
    createdAt: 1
  },
  {
    id: 'wt_2',
    projectId: 'p_api',
    name: 'dupe',
    branch: 'feature/dupe',
    path: '/repos/api-dupe',
    startedFrom: 'origin/main',
    state: 'ready',
    createdAt: 2
  },
  {
    id: 'wt_3',
    projectId: 'p_web',
    name: 'dupe',
    branch: 'feature/dupe-web',
    path: '/repos/web-dupe',
    startedFrom: 'origin/main',
    state: 'ready',
    createdAt: 3
  }
]

const TERMINAL = {
  id: 't_1',
  worktreeId: 'wt_1',
  title: 'zsh',
  cwd: '/repos/api-fix-login',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true
}

const defaultHandler: StubHandler = (method) => {
  switch (method) {
    case 'status.get':
      return { version: '9.9.9', endpoint: '/tmp/teamree.sock', pid: 4242, platform: 'darwin', startedAt: 1700000000000 }
    case 'project.list':
      return PROJECTS
    case 'project.add':
      return PROJECTS[0]
    case 'project.remove':
      return { removed: true }
    case 'worktree.list':
      return WORKTREES
    case 'worktree.create':
      return WORKTREES[0]
    case 'worktree.remove':
      return { removed: true }
    case 'worktree.status':
      return {
        worktreeId: 'wt_1',
        branch: 'feature/fix-login',
        ahead: 2,
        behind: 0,
        staged: 1,
        unstaged: 3,
        untracked: 0,
        conflicted: 0,
        readAt: 1700000000000
      }
    case 'terminal.list':
      return [TERMINAL]
    case 'terminal.create':
      return TERMINAL
    case 'terminal.write':
      return { written: true }
    case 'terminal.read':
      return { data: 'build ok\n' }
    case 'terminal.split':
      return { terminal: { ...TERMINAL, id: 't_2' }, layout: { worktreeId: 'wt_1', root: null, focusedTerminalId: 't_2' } }
    case 'terminal.close':
      return { closed: true }
    default:
      throw new StubError('unknown_method', `no handler for ${method}`)
  }
}

type Harness = {
  stub: StubRuntime
  dir: string
  run: (argv: string[]) => Promise<{ code: number; out: string; err: string }>
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function harness(
  handler: StubHandler = defaultHandler,
  options: { discovery?: 'fresh' | 'stale' | 'none' | 'malformed' } = {}
): Promise<Harness> {
  const stub = await startStubRuntime(handler)
  cleanups.push(() => stub.close())
  const dir = mkdtempSync(join(tmpdir(), 'teamree-run-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))

  const mode = options.discovery ?? 'fresh'
  if (mode === 'malformed') writeFileSync(join(dir, 'runtime.json'), '{ nope')
  else if (mode !== 'none') {
    writeFileSync(
      join(dir, 'runtime.json'),
      JSON.stringify({
        endpoint: stub.endpoint,
        pid: mode === 'stale' ? 0x7ffffff0 : process.pid,
        version: '0.0.1',
        platform: process.platform,
        startedAt: Date.now()
      })
    )
  }

  return {
    stub,
    dir,
    run: async (argv) => {
      let out = ''
      let err = ''
      const streams: Streams = { out: (text) => (out += text), err: (text) => (err += text) }
      const code = await runCli(argv, { streams, env: { TEAMREE_USER_DATA_DIR: dir }, cwd: '/work' })
      return { code, out, err }
    }
  }
}

/** Asserts stdout holds exactly one JSON document and returns it. */
function soleJsonDocument(out: string): Record<string, unknown> {
  expect(out.endsWith('\n')).toBe(true)
  const lines = out.split('\n').filter((line) => line.length > 0)
  expect(lines).toHaveLength(1)
  return JSON.parse(lines[0] as string) as Record<string, unknown>
}

describe('exit codes', () => {
  it('returns 0 on success', async () => {
    const cli = await harness()
    expect((await cli.run(['status'])).code).toBe(ExitCode.Success)
  })

  it('returns 2 for an unknown command, a bare group, and a bad invocation', async () => {
    const cli = await harness()
    expect((await cli.run(['frobnicate'])).code).toBe(ExitCode.Usage)
    expect((await cli.run(['worktree'])).code).toBe(ExitCode.Usage)
    expect((await cli.run(['worktree', 'remove'])).code).toBe(ExitCode.Usage)
    expect((await cli.run(['status', '--nope'])).code).toBe(ExitCode.Usage)
    expect((await cli.run(['terminal', 'split', 't_1', '--direction', 'sideways'])).code).toBe(ExitCode.Usage)
  })

  it('returns 3 when no discovery file exists', async () => {
    const cli = await harness(defaultHandler, { discovery: 'none' })
    const result = await cli.run(['status'])
    expect(result.code).toBe(ExitCode.NoRuntime)
    expect(result.out).toBe('')
    expect(result.err).toMatch(/not running/)
    expect(result.err).toMatch(/npm run dev/)
  })

  it('returns 3 for a stale discovery file rather than hanging on a dead socket', async () => {
    const cli = await harness(defaultHandler, { discovery: 'stale' })
    const result = await cli.run(['status'])
    expect(result.code).toBe(ExitCode.NoRuntime)
    expect(result.err).toMatch(/stale/)
  })

  it('returns 3 when the discovery file is unreadable', async () => {
    const cli = await harness(defaultHandler, { discovery: 'malformed' })
    expect((await cli.run(['status'])).code).toBe(ExitCode.NoRuntime)
  })

  it('returns 1 when the runtime refuses the call', async () => {
    const cli = await harness((method) => {
      if (method === 'worktree.list') return WORKTREES
      throw new StubError('git_failed', 'worktree is dirty')
    })
    const result = await cli.run(['worktree', 'remove', 'fix-login'])
    expect(result.code).toBe(ExitCode.Failure)
    expect(result.err).toMatch(/worktree is dirty/)
  })

  it('returns 1 for an ambiguous selector', async () => {
    const cli = await harness()
    const result = await cli.run(['worktree', 'status', 'dupe', '--json'])
    expect(result.code).toBe(ExitCode.Failure)
    expect(result.out).toBe('')
    const document = JSON.parse(result.err) as { ok: boolean; error: { code: string } }
    expect(document.ok).toBe(false)
    expect(document.error.code).toBe('ambiguous_selector')
  })
})

describe('--json output', () => {
  it('prints exactly one JSON document per command', async () => {
    const cli = await harness()
    const invocations: Array<[string, string[]]> = [
      ['status', ['status']],
      ['project list', ['project', 'list']],
      ['project add', ['project', 'add', './api']],
      ['project remove', ['project', 'remove', 'api']],
      ['worktree list', ['worktree', 'list']],
      ['worktree create', ['worktree', 'create', '--project', 'api', '--name', 'fix']],
      ['worktree remove', ['worktree', 'remove', 'fix-login']],
      ['worktree status', ['worktree', 'status', 'fix-login']],
      ['terminal list', ['terminal', 'list']],
      ['terminal create', ['terminal', 'create', '--worktree', 'fix-login']],
      ['terminal read', ['terminal', 'read', 't_1']],
      ['terminal send', ['terminal', 'send', 't_1', '--text', 'ls']],
      ['terminal split', ['terminal', 'split', 't_1', '--direction', 'row']],
      ['terminal close', ['terminal', 'close', 't_1']]
    ]
    for (const [name, argv] of invocations) {
      const result = await cli.run([...argv, '--json'])
      expect(result.code, `${name}: ${result.err}`).toBe(ExitCode.Success)
      expect(result.err).toBe('')
      const document = soleJsonDocument(result.out)
      expect(document['ok']).toBe(true)
      expect(document['command']).toBe(name)
      expect(document).toHaveProperty('data')
    }
  })

  it('keeps stdout clean when the command fails', async () => {
    const cli = await harness(() => {
      throw new StubError('internal', 'boom')
    })
    const result = await cli.run(['status', '--json'])
    expect(result.out).toBe('')
    const document = JSON.parse(result.err) as { ok: boolean; exitCode: number; error: { code: string } }
    expect(document).toMatchObject({ ok: false, exitCode: 1 })
    expect(document.error.code).toBe('internal')
  })

  it('reports usage errors as JSON on stderr too', async () => {
    const cli = await harness()
    const result = await cli.run(['worktree', 'remove', '--json'])
    expect(result.out).toBe('')
    const document = JSON.parse(result.err) as { exitCode: number; error: { code: string } }
    expect(document.exitCode).toBe(2)
    expect(document.error.code).toBe('usage')
  })

  it('accepts --json before the command', async () => {
    const cli = await harness()
    const result = await cli.run(['--json', 'project', 'list'])
    expect(soleJsonDocument(result.out)['command']).toBe('project list')
  })
})

describe('text output', () => {
  it('renders status as fields', async () => {
    const cli = await harness()
    const result = await cli.run(['status'])
    expect(result.out).toMatch(/version:\s+9\.9\.9/)
    expect(result.out).toMatch(/pid:\s+4242/)
    expect(result.out).toContain('runtime.json')
  })

  it('renders a table with a header', async () => {
    const cli = await harness()
    const result = await cli.run(['worktree', 'list'])
    expect(result.out.split('\n')[0]).toMatch(/^ID\s+NAME\s+BRANCH\s+STATE\s+PATH$/)
    expect(result.out).toContain('feature/fix-login')
  })

  it('explains an empty list', async () => {
    const cli = await harness((method) => {
      if (method === 'project.list') return []
      throw new StubError('unknown_method', method)
    })
    expect((await cli.run(['project', 'list'])).out).toMatch(/No projects tracked/)
  })

  it('prints terminal scrollback raw', async () => {
    const cli = await harness()
    expect((await cli.run(['terminal', 'read', 't_1'])).out).toBe('build ok\n')
  })
})

describe('selectors and flags reach the runtime', () => {
  it('resolves a worktree name to its id', async () => {
    const cli = await harness()
    await cli.run(['worktree', 'remove', 'fix-login', '--force', '--delete-branch'])
    expect(cli.stub.received.at(-1)).toMatchObject({
      method: 'worktree.remove',
      params: { worktreeId: 'wt_1', force: true, deleteBranch: true }
    })
  })

  it('resolves a worktree by branch and by id prefix', async () => {
    const cli = await harness()
    await cli.run(['terminal', 'list', '--worktree', 'feature/dupe-web'])
    expect(cli.stub.received.at(-1)).toMatchObject({ method: 'terminal.list', params: { worktreeId: 'wt_3' } })
    await cli.run(['terminal', 'list', '--worktree', 'wt_2'])
    expect(cli.stub.received.at(-1)).toMatchObject({ params: { worktreeId: 'wt_2' } })
  })

  it('resolves a project by path for worktree create', async () => {
    const cli = await harness()
    await cli.run(['worktree', 'create', '--project', '/repos/web', '--name', 'x', '--from', 'main'])
    expect(cli.stub.received.at(-1)).toMatchObject({
      method: 'worktree.create',
      params: { projectId: 'p_web', name: 'x', startedFrom: 'main' }
    })
  })

  it('resolves project add paths against the cwd', async () => {
    const cli = await harness()
    await cli.run(['project', 'add', './sub'])
    expect(cli.stub.received.at(-1)).toMatchObject({ method: 'project.add', params: { path: '/work/sub' } })
  })

  it('appends a carriage return only with --enter', async () => {
    const cli = await harness()
    await cli.run(['terminal', 'send', 't_1', '--text', 'npm test'])
    expect(cli.stub.received.at(-1)).toMatchObject({ params: { data: 'npm test' } })
    await cli.run(['terminal', 'send', 't_1', '--text', 'npm test', '--enter'])
    expect(cli.stub.received.at(-1)).toMatchObject({ params: { data: 'npm test\r' } })
  })

  it('passes --tail-bytes through as a number', async () => {
    const cli = await harness()
    await cli.run(['terminal', 'read', 't_1', '--tail-bytes', '2048'])
    expect(cli.stub.received.at(-1)).toMatchObject({ params: { terminalId: 't_1', tailBytes: 2048 } })
  })

  it('honours --endpoint instead of discovery', async () => {
    const cli = await harness(defaultHandler, { discovery: 'none' })
    const result = await cli.run(['status', '--endpoint', cli.stub.endpoint, '--json'])
    expect(result.code).toBe(ExitCode.Success)
    expect((soleJsonDocument(result.out)['data'] as { endpointSource: string }).endpointSource).toBe('--endpoint')
  })
})

describe('help', () => {
  it('prints the root help for no arguments and for --help', async () => {
    const cli = await harness(defaultHandler, { discovery: 'none' })
    for (const argv of [[], ['--help'], ['-h'], ['help']]) {
      const result = await cli.run(argv)
      expect(result.code).toBe(ExitCode.Success)
      expect(result.out).toContain('teamree <command>')
      expect(result.out).toContain('worktree create')
    }
  })

  it('prints command help without needing a runtime', async () => {
    const cli = await harness(defaultHandler, { discovery: 'none' })
    const result = await cli.run(['worktree', 'create', '--help'])
    expect(result.code).toBe(ExitCode.Success)
    expect(result.out).toContain('--from <ref>')
    expect((await cli.run(['help', 'worktree', 'create'])).out).toBe(result.out)
  })

  it('prints group help', async () => {
    const cli = await harness(defaultHandler, { discovery: 'none' })
    const result = await cli.run(['terminal', '--help'])
    expect(result.code).toBe(ExitCode.Success)
    expect(result.out).toContain('terminal send')
  })

  it('emits the whole surface as one JSON document', async () => {
    const cli = await harness(defaultHandler, { discovery: 'none' })
    const result = await cli.run(['--help', '--json'])
    const document = soleJsonDocument(result.out)
    const data = document['data'] as { commands: Array<{ name: string }> }
    expect(data.commands.length).toBe(14)
    expect(data.commands.map((command) => command.name)).toContain('terminal send')
  })
})
