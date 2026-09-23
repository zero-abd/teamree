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
      return {
        version: '9.9.9',
        endpoint: '/tmp/teamree.sock',
        pid: 4242,
        platform: 'darwin',
        startedAt: 1700000000000
      }
    case 'project.list':
      return PROJECTS
    case 'project.add':
      return PROJECTS[0]
    case 'project.remove':
      return { removed: true }
    case 'project.setPaths':
      return { ...PROJECTS[0], linkedPaths: ['node_modules', '.venv'] }
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
      return {
        terminal: { ...TERMINAL, id: 't_2' },
        layout: { worktreeId: 'wt_1', root: null, focusedTerminalId: 't_2' }
      }
    case 'terminal.rename':
      return { ...TERMINAL, label: 'auth refactor' }
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

describe('naming a pane from the CLI', () => {
  // An agent reading this listing is in exactly the position the sidebar is:
  // three panes running the same binary, and only the name says which is which.
  it('shows a pane’s name in the listing and in the JSON', async () => {
    const cli = await harness((method, params, context) =>
      method === 'terminal.list'
        ? [TERMINAL, { ...TERMINAL, id: 't_2', label: 'auth refactor' }]
        : defaultHandler(method, params, context)
    )

    const text = await cli.run(['terminal', 'list'])
    expect(text.out).toContain('auth refactor')

    const json = await cli.run(['terminal', 'list', '--json'])
    const document = soleJsonDocument(json.out)
    expect(JSON.stringify(document['data'])).toContain('auth refactor')
  })

  it('renames a pane, and clears the name when told none', async () => {
    const seen: Array<Record<string, unknown>> = []
    const cli = await harness((method, params, context) => {
      if (method !== 'terminal.rename') return defaultHandler(method, params, context)
      seen.push(params as Record<string, unknown>)
      return { ...TERMINAL, label: (params as { label: string | null }).label ?? undefined }
    })

    expect((await cli.run(['terminal', 'rename', 't_1', '--name', 'auth refactor'])).code).toBe(ExitCode.Success)
    expect((await cli.run(['terminal', 'rename', 't_1'])).code).toBe(ExitCode.Success)
    expect(seen).toEqual([
      { terminalId: 't_1', label: 'auth refactor' },
      { terminalId: 't_1', label: null }
    ])
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
      ['terminal rename', ['terminal', 'rename', 't_1', '--name', 'auth refactor']],
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

  it('sets a path list from the positional tail, and only when one was given', async () => {
    const cli = await harness()

    await cli.run(['project', 'linked', 'api', 'node_modules', '.venv'])
    expect(cli.stub.received.at(-1)).toMatchObject({
      method: 'project.setPaths',
      params: { projectId: 'p_api', linkedPaths: ['node_modules', '.venv'] }
    })

    // Naming no paths asks rather than empties: the read is answered from the
    // project the selector already fetched, so nothing is written.
    await cli.run(['project', 'copied', 'api'])
    expect(cli.stub.received.at(-1)).toMatchObject({ method: 'project.list' })

    await cli.run(['project', 'copied', 'api', '--clear'])
    expect(cli.stub.received.at(-1)).toMatchObject({
      method: 'project.setPaths',
      params: { projectId: 'p_api', copiedPaths: [] }
    })
  })

  it('prints a path list one per line, and says so when there is none', async () => {
    const cli = await harness()
    expect((await cli.run(['project', 'linked', 'api', 'node_modules', '.venv'])).out).toBe('node_modules\n.venv\n')
    expect((await cli.run(['project', 'copied', 'api'])).out).toMatch(/copies nothing into new worktrees/)
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

// Several attempts at one task, from a shell: the flag is repeatable, and each
// repeat is a whole worktree with its own agent in it.
describe('worktree create --agent, repeated', () => {
  it('creates one worktree per repeat, names them apart, and starts each agent', async () => {
    const made: Array<Record<string, unknown>> = []
    const cli = await harness((method, params) => {
      if (method === 'project.list') return PROJECTS
      if (method === 'worktree.create') {
        const name = (params as { name: string }).name
        const worktree = {
          ...WORKTREES[0],
          id: `wt_made_${made.length + 1}`,
          name,
          branch: name.replace(/\W+/g, '-'),
          path: `/repos/api-${made.length + 1}`,
          state: 'ready'
        }
        made.push(worktree)
        return worktree
      }
      if (method === 'worktree.list') return made
      if (method === 'terminal.create') return TERMINAL
      throw new StubError('unknown_method', `no handler for ${method}`)
    })

    const result = await cli.run([
      'worktree',
      'create',
      '--project',
      'api',
      '--name',
      'fix login',
      '--agent',
      'claude',
      '--agent',
      'claude',
      '--agent',
      'codex',
      '--json'
    ])

    expect(result.code).toBe(ExitCode.Success)
    const records = soleJsonDocument(result.out)['data'] as Array<{ id: string; name: string }>
    expect(records).toHaveLength(3)
    expect(records.map((record) => record.name)).toEqual(['fix login', 'fix login claude 2', 'fix login codex'])

    // All three branch from the same place, which is what makes them comparable.
    const creates = cli.stub.received.filter((call) => call.method === 'worktree.create')
    expect(creates).toHaveLength(3)
    expect(creates.every((call) => (call.params as { projectId: string }).projectId === 'p_api')).toBe(true)

    // One pane each, running the agent that worktree was made for. The waits run
    // in parallel, so the pairing is what matters rather than the order.
    const panes = cli.stub.received
      .filter((call) => call.method === 'terminal.create')
      .map((call) => call.params as { worktreeId: string; command: string })
    expect(panes).toHaveLength(3)
    expect(new Map(panes.map((pane) => [pane.worktreeId, pane.command]))).toEqual(
      new Map([
        ['wt_made_1', 'claude'],
        ['wt_made_2', 'claude'],
        ['wt_made_3', 'codex']
      ])
    )
  })

  it('leaves a create with no --agent exactly as it was: one record, no pane', async () => {
    const cli = await harness()
    const result = await cli.run(['worktree', 'create', '--project', 'api', '--name', 'x', '--json'])
    const record = soleJsonDocument(result.out)['data'] as { id: string }
    expect(record.id).toBe('wt_1')
    expect(cli.stub.received.some((call) => call.method === 'terminal.create')).toBe(false)
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
    // Kept in step with EXPECTED in command-table.test.ts, which names them all.
    expect(data.commands.length).toBe(51)
    expect(data.commands.map((command) => command.name)).toContain('terminal send')
  })
})

describe('the CLI on the subject of itself', () => {
  const CLI_STATUS = {
    installable: true,
    platform: 'darwin',
    source: '/Applications/teamree.app/Contents/Resources/cli/teamree',
    destination: '/usr/local/bin/teamree',
    directory: '/usr/local/bin',
    state: 'elsewhere',
    resolved: '/Users/ann/Downloads/teamree.app/Contents/Resources/cli/teamree',
    needsAdministrator: true,
    onPath: 'login',
    readAt: 1700000000000
  }

  const handler: StubHandler = (method) => {
    if (method === 'cli.status') return CLI_STATUS
    if (method === 'cli.install') {
      return {
        outcome: 'replaced',
        replaced: CLI_STATUS.resolved,
        administrator: true,
        status: { ...CLI_STATUS, state: 'linked', resolved: CLI_STATUS.source, needsAdministrator: true }
      }
    }
    return defaultHandler(method, undefined, { id: 'x', emit: () => {}, respond: () => {} })
  }

  it('names the other copy a link leads to, which is the confusing one', async () => {
    const cli = await harness(handler)
    const result = await cli.run(['cli', 'status'])
    expect(result.code).toBe(ExitCode.Success)
    expect(result.out).toContain('/usr/local/bin/teamree')
    expect(result.out).toContain('/Users/ann/Downloads/teamree.app/Contents/Resources/cli/teamree')
    expect(result.out).toContain('which is not this app')
    expect(result.out).toContain('needed to write /usr/local/bin')
  })

  it('says what installing actually did, password included', async () => {
    const cli = await harness(handler)
    const result = await cli.run(['cli', 'install'])
    expect(result.code).toBe(ExitCode.Success)
    expect(result.out).toContain('now points at /Applications/teamree.app/Contents/Resources/cli/teamree')
    expect(result.out).toContain('used to point at /Users/ann/Downloads')
    expect(result.out).toContain('An administrator password was asked for.')
  })

  it('passes a refusal on as a failure rather than swallowing it', async () => {
    const cli = await harness((method) => {
      if (method === 'cli.install') throw new StubError('conflict', 'There is a regular file at /usr/local/bin/teamree')
      return handler(method, undefined, { id: 'x', emit: () => {}, respond: () => {} })
    })
    const result = await cli.run(['cli', 'install'])
    expect(result.code).toBe(ExitCode.Failure)
    expect(result.err).toContain('regular file')
  })
})
