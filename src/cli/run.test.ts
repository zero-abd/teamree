import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExitCode } from './exit.js'
import type { Streams } from './output.js'
import { runCli } from './run.js'
import { NO_REPLY, StubError, startStubRuntime, type StubHandler, type StubRuntime } from './stub-runtime.js'

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
    case 'worktree.forget':
      return { forgotten: true }
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
  run: (argv: string[], stdin?: string) => Promise<{ code: number; out: string; err: string }>
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
    run: async (argv, stdin) => {
      let out = ''
      let err = ''
      const streams: Streams = { out: (text) => (out += text), err: (text) => (err += text) }
      const code = await runCli(argv, {
        streams,
        env: { TEAMREE_USER_DATA_DIR: dir },
        cwd: '/work',
        ...(stdin === undefined ? {} : { stdin: () => Promise.resolve(stdin) })
      })
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
    // The runtime's sentence, as every other error prints: no RPC method
    // name in front of it. The method is for scripts, and rides in the JSON.
    expect(result.err).toBe('error: worktree is dirty\n')
    const asJson = await cli.run(['worktree', 'remove', 'fix-login', '--json'])
    const document = JSON.parse(asJson.err) as { error: { message: string; method?: string } }
    expect(document.error.message).toBe('worktree is dirty')
    expect(document.error.method).toBe('worktree.remove')
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

  it('renames a worktree by any selector, and carries the record in --json', async () => {
    const seen: Array<Record<string, unknown>> = []
    const cli = await harness((method, params, context) => {
      if (method !== 'worktree.rename') return defaultHandler(method, params, context)
      seen.push(params as Record<string, unknown>)
      return { ...WORKTREES[0], name: (params as { name: string }).name }
    })

    const text = await cli.run(['worktree', 'rename', 'fix-login', 'login, the winner'])
    expect(text.code).toBe(ExitCode.Success)
    expect(text.out).toContain('login, the winner')

    const json = await cli.run(['worktree', 'rename', 'wt_1', 'again', '--json'])
    expect(soleJsonDocument(json.out)['data']).toMatchObject({ id: 'wt_1', name: 'again', branch: 'feature/fix-login' })
    expect(seen).toEqual([
      { worktreeId: 'wt_1', name: 'login, the winner' },
      { worktreeId: 'wt_1', name: 'again' }
    ])
  })

  it('refuses a blank worktree name without calling the runtime', async () => {
    const seen: string[] = []
    const cli = await harness((method, params, context) => {
      seen.push(method)
      return defaultHandler(method, params, context)
    })

    expect((await cli.run(['worktree', 'rename', 'fix-login', '   '])).code).toBe(ExitCode.Usage)
    expect(seen).not.toContain('worktree.rename')
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
      ['worktree forget', ['worktree', 'forget', 'fix-login']],
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
    expect(result.out.split('\n')[0]).toMatch(/^ID\s+NAME\s+BRANCH\s+STATE\s+PARENT\s+PATH$/)
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

  it('dates a start point by the commit, not by 1970', async () => {
    const cli = await harness((method) => {
      if (method === 'project.list') return PROJECTS
      if (method === 'worktree.startPoints')
        return {
          baseRef: 'main',
          options: [
            {
              ref: 'main',
              kind: 'localBranch',
              sha: 'fbdaa75000000000000000000000000000000000',
              shortSha: 'fbdaa75',
              refName: 'refs/heads/main',
              isBase: true,
              isCurrent: true,
              // Unix seconds, as git's %ct prints them: 2026-09-23T03:11:14Z.
              updatedAt: 1790149874
            }
          ],
          total: 1,
          limit: 50,
          truncated: false
        }
      throw new StubError('unknown_method', method)
    })
    const result = await cli.run(['worktree', 'start-points', 'api'])
    expect(result.out).toContain('2026-09-23')
    expect(result.out).not.toContain('1970')
  })
})

describe('a push that opened a review', () => {
  const pushed =
    (extra: Record<string, unknown> = {}): StubHandler =>
    (method, params) => {
      if (method === 'project.list') return PROJECTS
      if (method === 'worktree.list') return WORKTREES
      if (method === 'worktree.push') {
        void params
        return {
          worktreeId: 'wt_1',
          remote: 'origin',
          branch: 'feature/fix-login',
          alreadyUpToDate: false,
          upstream: 'origin/feature/fix-login',
          setUpstream: true,
          uncommitted: 0,
          pushedAt: 1700000000000,
          ...extra
        }
      }
      throw new StubError('unknown_method', method)
    }

  const REVIEW = 'https://github.com/o/r/compare/main...feature%2Ffix-login?expand=1'

  // On a line of its own and nothing else on it: the next thing that happens to
  // a URL in a terminal is a click or a copy, and both want the whole line.
  it('prints the review URL on its own line', async () => {
    const cli = await harness(pushed({ reviewUrl: REVIEW }))
    const result = await cli.run(['worktree', 'push', 'fix-login'])
    expect(result.out.split('\n')).toContain(REVIEW)
  })

  it('carries it in --json, where a script can read it', async () => {
    const cli = await harness(pushed({ reviewUrl: REVIEW }))
    const document = soleJsonDocument((await cli.run(['worktree', 'push', 'fix-login', '--json'])).out)
    expect((document['data'] as { reviewUrl?: string }).reviewUrl).toBe(REVIEW)
  })

  // A remote teamree cannot name is not an error and not a guess; it is a push
  // with nothing extra said about it.
  it('says nothing extra when the remote is not a forge it knows', async () => {
    const cli = await harness(pushed())
    const result = await cli.run(['worktree', 'push', 'fix-login'])
    expect(result.out).toContain('Pushed feature/fix-login to origin.')
    expect(result.out).not.toContain('http')
  })
})

describe('landing a worktree', () => {
  const landing = (extra: Record<string, unknown> = {}) => ({
    worktreeId: 'wt_1',
    branch: 'feature/fix-login',
    base: 'main',
    host: null,
    published: false,
    unmerged: 1,
    merged: false,
    readAt: 0,
    ...extra
  })
  const landed =
    (read: Record<string, unknown>, calls: [string, unknown][] = []): StubHandler =>
    (method, params) => {
      calls.push([method, params])
      if (method === 'project.list') return PROJECTS
      if (method === 'worktree.list') return WORKTREES
      if (method === 'worktree.landing') return landing(read)
      if (method === 'worktree.mergeIntoBase') {
        return {
          worktreeId: 'wt_1',
          into: 'main',
          checkout: '/repos/api',
          commits: [{ shortSha: 'abc1234', subject: 'Fix login' }],
          fastForward: true,
          dirty: [],
          merged: true
        }
      }
      if (method === 'worktree.createPullRequest') {
        return { worktreeId: 'wt_1', url: 'https://github.com/o/r/pull/12', number: 12, created: true }
      }
      throw new StubError('unknown_method', method)
    }

  it('merges into the base where the origin is no known host', async () => {
    const calls: [string, unknown][] = []
    const cli = await harness(landed({}, calls))
    const result = await cli.run(['worktree', 'land', 'fix-login'])

    expect(result.code).toBe(ExitCode.Success)
    expect(calls).toContainEqual(['worktree.mergeIntoBase', { worktreeId: 'wt_1' }])
    expect(result.out).toContain('Merged feature/fix-login into main in /repos/api (fast-forward).')
  })

  it('opens a pull request on a known host once the branch is published', async () => {
    const calls: [string, unknown][] = []
    const cli = await harness(landed({ host: 'github', published: true }, calls))
    const result = await cli.run(['worktree', 'land', 'fix-login'])

    expect(calls.map(([method]) => method)).toContain('worktree.createPullRequest')
    expect(result.out.split('\n')).toContain('https://github.com/o/r/pull/12')
  })

  it('asks for a push first when the branch is not on the host yet', async () => {
    const cli = await harness(landed({ host: 'github', published: false }))
    const result = await cli.run(['worktree', 'land', 'fix-login'])

    expect(result.code).toBe(ExitCode.Failure)
    expect(result.err).toContain('teamree worktree push fix-login')
  })

  it('does nothing to a branch already in its base', async () => {
    const calls: [string, unknown][] = []
    const cli = await harness(landed({ merged: true, unmerged: 0 }, calls))
    const result = await cli.run(['worktree', 'land', 'fix-login'])

    expect(result.code).toBe(ExitCode.Success)
    expect(calls.map(([method]) => method)).not.toContain('worktree.mergeIntoBase')
    expect(result.out).toContain('already in main')
  })

  it('keeps one run and passes --force through', async () => {
    const calls: [string, unknown][] = []
    const cli = await harness((method, params) => {
      calls.push([method, params])
      if (method === 'project.list') return PROJECTS
      if (method === 'worktree.list') return WORKTREES
      if (method === 'worktree.keep') return { worktree: { ...WORKTREES[0], name: 'fix' }, removed: ['wt_2'] }
      throw new StubError('unknown_method', method)
    })
    const result = await cli.run(['worktree', 'keep', 'fix-login', '--force'])

    expect(calls).toContainEqual(['worktree.keep', { worktreeId: 'wt_1', force: true }])
    expect(result.out).toContain('Kept fix; removed 1 other run. Its branch is still there.')
  })
})

describe('selectors and flags reach the runtime', () => {
  // The hunk number is the CLI's own convenience and never leaves it: the
  // command resolves it against a patch it reads one call earlier and sends the
  // hunk itself, so the runtime is never handed a position it would have to
  // trust.
  it('turns --hunk into the hunk, counting the patch it was told to count', async () => {
    const twoHunks = [
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,3 +1,3 @@',
      ' one',
      '-two',
      '+TWO',
      ' three',
      '@@ -20,3 +20,3 @@',
      ' twenty',
      '-x',
      '+X',
      ' twentytwo',
      ''
    ].join('\n')

    const cli = await harness((method, params) => {
      if (method === 'worktree.diff') {
        return { worktreeId: 'wt_1', path: 'src/app.ts', staged: false, patch: twoHunks, truncated: false, readAt: 1 }
      }
      if (method === 'worktree.stageHunk' || method === 'worktree.unstageHunk') {
        return {
          worktreeId: 'wt_1',
          path: 'src/app.ts',
          staged: method.endsWith('stageHunk'),
          added: 1,
          removed: 1,
          appliedAt: 1
        }
      }
      return defaultHandler(method, params, { id: '', emit: () => {}, respond: () => {} })
    })

    const result = await cli.run(['worktree', 'stage-hunk', 'fix-login', '--path', 'src/app.ts', '--hunk', '2'])
    expect(result.code).toBe(ExitCode.Success)
    // Staging counts the working-tree patch, so the diff it read is the unstaged one.
    expect(cli.stub.received.find((call) => call.method === 'worktree.diff')).toMatchObject({
      params: { worktreeId: 'wt_1', path: 'src/app.ts', staged: false }
    })
    expect(cli.stub.received.at(-1)).toMatchObject({
      method: 'worktree.stageHunk',
      params: {
        worktreeId: 'wt_1',
        path: 'src/app.ts',
        hunk: {
          oldStart: 20,
          oldCount: 3,
          newStart: 20,
          newCount: 3,
          lines: [
            { kind: 'context', text: 'twenty' },
            { kind: 'removed', text: 'x' },
            { kind: 'added', text: 'X' },
            { kind: 'context', text: 'twentytwo' }
          ]
        }
      }
    })

    // And unstaging counts the other patch.
    await cli.run(['worktree', 'unstage-hunk', 'fix-login', '--path', 'src/app.ts', '--hunk', '1'])
    expect(cli.stub.received.filter((call) => call.method === 'worktree.diff').at(-1)).toMatchObject({
      params: { staged: true }
    })
    expect(cli.stub.received.at(-1)).toMatchObject({
      method: 'worktree.unstageHunk',
      params: { hunk: { oldStart: 1, newStart: 1 } }
    })
  })

  it('refuses a hunk number the patch does not have, without calling the runtime', async () => {
    const cli = await harness((method, params) => {
      if (method === 'worktree.diff') {
        return { worktreeId: 'wt_1', path: 'src/app.ts', staged: false, patch: '', truncated: false, readAt: 1 }
      }
      return defaultHandler(method, params, { id: '', emit: () => {}, respond: () => {} })
    })

    const result = await cli.run(['worktree', 'stage-hunk', 'fix-login', '--path', 'src/app.ts', '--hunk', '3'])
    expect(result.code).toBe(ExitCode.Failure)
    expect(cli.stub.received.some((call) => call.method === 'worktree.stageHunk')).toBe(false)
  })

  it('discards a whole path, or the hunk --hunk names of the unstaged patch', async () => {
    const patch = ['diff --git a/src/app.ts b/src/app.ts', '--- a/src/app.ts', '+++ b/src/app.ts']
    const hunks = [...patch, '@@ -1,1 +1,1 @@', '-one', '+ONE', '@@ -9,1 +9,1 @@', '-nine', '+NINE', ''].join('\n')
    const cli = await harness((method, params) => {
      if (method === 'worktree.diff') {
        return { worktreeId: 'wt_1', path: 'src/app.ts', staged: false, patch: hunks, truncated: false, readAt: 1 }
      }
      if (method === 'worktree.discardPath' || method === 'worktree.discardHunk') {
        const outcome = method === 'worktree.discardHunk' ? 'hunk' : 'restored'
        return { worktreeId: 'wt_1', path: 'src/app.ts', outcome, discardedAt: 1 }
      }
      return defaultHandler(method, params, { id: '', emit: () => {}, respond: () => {} })
    })

    expect((await cli.run(['worktree', 'discard', 'fix-login', '--path', 'src/app.ts'])).code).toBe(ExitCode.Success)
    expect(cli.stub.received.at(-1)).toMatchObject({
      method: 'worktree.discardPath',
      params: { worktreeId: 'wt_1', path: 'src/app.ts' }
    })

    await cli.run(['worktree', 'discard', 'fix-login', '--path', 'src/app.ts', '--hunk', '2'])
    expect(cli.stub.received.filter((call) => call.method === 'worktree.diff').at(-1)).toMatchObject({
      params: { staged: false }
    })
    expect(cli.stub.received.at(-1)).toMatchObject({
      method: 'worktree.discardHunk',
      params: { path: 'src/app.ts', hunk: { oldStart: 9, lines: [{ text: 'nine' }, { text: 'NINE' }] } }
    })
  })

  it('unstages a whole path, reading no patch', async () => {
    const cli = await harness((method, params) => {
      if (method === 'worktree.unstagePath') return { worktreeId: 'wt_1', path: 'src/app.ts', unstagedAt: 1 }
      return defaultHandler(method, params, { id: '', emit: () => {}, respond: () => {} })
    })

    const result = await cli.run(['worktree', 'unstage', 'fix-login', '--path', 'src/app.ts'])
    expect(result.code).toBe(ExitCode.Success)
    expect(cli.stub.received.some((call) => call.method === 'worktree.diff')).toBe(false)
    expect(cli.stub.received.at(-1)).toMatchObject({
      method: 'worktree.unstagePath',
      params: { worktreeId: 'wt_1', path: 'src/app.ts' }
    })
  })

  it('needs a path to stage a hunk of', async () => {
    const cli = await harness()
    const result = await cli.run(['worktree', 'stage-hunk', 'fix-login', '--hunk', '1'])
    expect(result.code).toBe(ExitCode.Usage)
  })

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

  it('sets the setup command from the positional tail, and only when one was given', async () => {
    const cli = await harness()

    await cli.run(['project', 'setup', 'api', 'npm ci'])
    expect(cli.stub.received.at(-1)).toMatchObject({
      method: 'project.setPaths',
      params: { projectId: 'p_api', setupCommand: 'npm ci' }
    })

    // Naming no command asks rather than clears, exactly as the path lists do.
    await cli.run(['project', 'setup', 'api'])
    expect(cli.stub.received.at(-1)).toMatchObject({ method: 'project.list' })

    await cli.run(['project', 'setup', 'api', '--clear'])
    expect(cli.stub.received.at(-1)).toMatchObject({
      method: 'project.setPaths',
      params: { projectId: 'p_api', setupCommand: '' }
    })
  })

  it('prints the setup command on its own, and says so when there is none', async () => {
    const cli = await harness((method, params, context) =>
      method === 'project.setPaths'
        ? { ...(PROJECTS[0] as Record<string, unknown>), setupCommand: 'npm ci' }
        : defaultHandler(method, params, context)
    )
    expect((await cli.run(['project', 'setup', 'api', 'npm ci'])).out).toBe('npm ci\n')
    expect((await cli.run(['project', 'setup', 'api'])).out).toMatch(/runs nothing in a new worktree/)
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

  it('presses Return with --enter alone, and wants --text without it', async () => {
    const cli = await harness()
    await cli.run(['terminal', 'send', 't_1', '--enter'])
    expect(cli.stub.received.at(-1)).toMatchObject({ params: { data: '\r' } })
    await cli.run(['terminal', 'send', 't_1', '--text', '', '--enter'])
    expect(cli.stub.received.at(-1)).toMatchObject({ params: { data: '\r' } })
    const sent = cli.stub.received.length
    const bare = await cli.run(['terminal', 'send', 't_1'])
    expect(bare.code).toBe(ExitCode.Usage)
    expect(bare.err).toMatch(/--text is required/)
    expect((await cli.run(['terminal', 'send', 't_1', '--text', ''])).code).toBe(ExitCode.Usage)
    expect(cli.stub.received.length).toBe(sent)
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
describe('worktree create --prompt', () => {
  /** A runtime that makes every worktree ready at once and remembers what it was asked. */
  function readyRuntime(): StubHandler {
    const made: Array<Record<string, unknown>> = []
    return (method, params) => {
      if (method === 'project.list') return PROJECTS
      if (method === 'worktree.create') {
        const name = (params as { name: string }).name
        const worktree = { ...WORKTREES[0], id: `wt_made_${made.length + 1}`, name, state: 'ready' }
        made.push(worktree)
        return worktree
      }
      if (method === 'worktree.list') return made
      if (method === 'terminal.create') return TERMINAL
      throw new StubError('unknown_method', `no handler for ${method}`)
    }
  }

  // The text is the task. It is written on the checkout's record and handed to
  // every pane as the first prompt — a create that only named the worktree
  // started an agent that had never been told what the worktree was for.
  it('stores the text on each worktree and hands it to each agent', async () => {
    const cli = await harness(readyRuntime())
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
      'codex',
      '--prompt',
      'Fix the login page; the form posts twice.',
      '--json'
    ])
    expect(result.code).toBe(ExitCode.Success)

    const creates = cli.stub.received.filter((call) => call.method === 'worktree.create')
    expect(creates.map((call) => (call.params as { task?: string }).task)).toEqual([
      'Fix the login page; the form posts twice.',
      'Fix the login page; the form posts twice.'
    ])
    const panes = cli.stub.received.filter((call) => call.method === 'terminal.create')
    expect(panes.map((call) => (call.params as { prompt?: string }).prompt)).toEqual([
      'Fix the login page; the form posts twice.',
      'Fix the login page; the form posts twice.'
    ])
  })

  it('reads the text from stdin for --prompt -', async () => {
    const cli = await harness(readyRuntime())
    const result = await cli.run(
      ['worktree', 'create', '--project', 'api', '--name', 'fix login', '--agent', 'claude', '--prompt', '-'],
      'Fix the login page.\n\nThe form posts twice.\n'
    )
    expect(result.code).toBe(ExitCode.Success)
    const panes = cli.stub.received.filter((call) => call.method === 'terminal.create')
    expect(panes.map((call) => (call.params as { prompt?: string }).prompt)).toEqual([
      'Fix the login page.\n\nThe form posts twice.'
    ])
  })

  it('refuses a prompt too long for one command line before creating anything', async () => {
    const cli = await harness(readyRuntime())
    const result = await cli.run([
      'worktree',
      'create',
      '--project',
      'api',
      '--name',
      'fix login',
      '--agent',
      'claude',
      '--prompt',
      'x'.repeat(5000)
    ])
    expect(result.code).toBe(ExitCode.Usage)
    expect(result.err).toContain('--prompt')
    expect(cli.stub.received.filter((call) => call.method === 'worktree.create')).toHaveLength(0)
  })

  it('needs an agent to give the prompt to', async () => {
    const cli = await harness(readyRuntime())
    const result = await cli.run([
      'worktree',
      'create',
      '--project',
      'api',
      '--name',
      'fix login',
      '--prompt',
      'Fix the login page.'
    ])
    expect(result.code).toBe(ExitCode.Usage)
    expect(result.err).toContain('--agent')
  })
})

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
    expect(records.map((record) => record.name)).toEqual(['fix login claude', 'fix login claude 2', 'fix login codex'])

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

  // Two of the three panes above run the same binary, so `claude` names none of
  // them. The task does — the same name, suffix and all, that told the three
  // checkouts apart — and without it the listing is three identical rows.
  it('names each pane after the task it is racing, not after the binary', async () => {
    const made: Array<Record<string, unknown>> = []
    const cli = await harness((method, params) => {
      if (method === 'project.list') return PROJECTS
      if (method === 'worktree.create') {
        const name = (params as { name: string }).name
        const worktree = { ...WORKTREES[0], id: `wt_made_${made.length + 1}`, name, state: 'ready' }
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
      'codex'
    ])
    expect(result.code).toBe(ExitCode.Success)

    const labels = cli.stub.received
      .filter((call) => call.method === 'terminal.create')
      .map((call) => call.params as { worktreeId: string; label?: string })
    expect(new Map(labels.map((pane) => [pane.worktreeId, pane.label]))).toEqual(
      new Map([
        ['wt_made_1', 'fix login claude'],
        ['wt_made_2', 'fix login claude 2'],
        ['wt_made_3', 'fix login codex']
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

// Two things an agent does constantly: read the listing to find a pane, and open
// a pane in a worktree it already knows the name of.
describe('pointing the CLI at a worktree', () => {
  it('prints the worktree by name in the listing, not by id', async () => {
    const cli = await harness()
    const result = await cli.run(['terminal', 'list'])
    expect(result.code).toBe(ExitCode.Success)
    expect(result.out).toContain('fix-login')
    expect(result.out).not.toContain('wt_1')
    // The payload is unchanged: a caller parsing JSON addresses panes by id,
    // and the name is the human column.
    const json = soleJsonDocument((await cli.run(['terminal', 'list', '--json'])).out)
    expect(JSON.stringify(json['data'])).toContain('wt_1')
  })

  it('takes the worktree as a positional on terminal create, the way every other command does', async () => {
    const cli = await harness()
    const result = await cli.run(['terminal', 'create', 'fix-login', '--json'])
    expect(result.code).toBe(ExitCode.Success)
    const created = cli.stub.received.find((call) => call.method === 'terminal.create')
    expect((created?.params as { worktreeId: string } | undefined)?.worktreeId).toBe('wt_1')
  })

  it('still takes --worktree, because scripts were written against it', async () => {
    const cli = await harness()
    expect((await cli.run(['terminal', 'create', '--worktree', 'fix-login'])).code).toBe(ExitCode.Success)
  })

  it('asks for a worktree when given none, rather than opening one somewhere', async () => {
    const cli = await harness()
    const result = await cli.run(['terminal', 'create'])
    expect(result.code).toBe(ExitCode.Usage)
    expect(result.err).toMatch(/needs <worktree>/)
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
    expect(data.commands.length).toBe(69)
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

describe('reading a pane as text', () => {
  // The snapshot QA pasted: a zsh prompt's SGR runs, the OSC title, the
  // bracketed-paste brackets and a backspaced typo. Raw, none of it can be
  // grepped; that is the whole of the defect.
  const RAW =
    `\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m${' '.repeat(40)}\r \r` +
    `\x1b]0;abd@mac: ~/repos/teamree\x07` +
    `~/repos/teamree % \x1b[?2004he\bexit\x1b[?2004l\r\r\n`

  const handler: StubHandler = (method, params, context) =>
    method === 'terminal.read' ? { data: RAW } : defaultHandler(method, params, context)

  it('prints the raw buffer by default and the plain text with --plain', async () => {
    const cli = await harness(handler)

    const raw = await cli.run(['terminal', 'read', 't_1'])
    expect(raw.code).toBe(ExitCode.Success)
    expect(raw.out).toBe(RAW)

    const plain = await cli.run(['terminal', 'read', 't_1', '--plain'])
    expect(plain.code).toBe(ExitCode.Success)
    expect(plain.out).toBe('~/repos/teamree % exit\n')
  })

  it('keeps the raw bytes in --json and carries the stripped text beside them', async () => {
    const cli = await harness(handler)

    const asIs = soleJsonDocument((await cli.run(['terminal', 'read', 't_1', '--json'])).out)
    expect((asIs['data'] as Record<string, unknown>)['data']).toBe(RAW)
    expect(asIs['data']).not.toHaveProperty('plain')

    const stripped = soleJsonDocument((await cli.run(['terminal', 'read', 't_1', '--plain', '--json'])).out)
    const data = stripped['data'] as Record<string, unknown>
    expect(data['data']).toBe(RAW)
    expect(data['plain']).toBe('~/repos/teamree % exit\n')
  })
})

describe('a project’s path lists in --json', () => {
  // A script cannot tell a list that is empty from a field this build does not
  // have, so the arrays are always there.
  const BARE = { id: 'p_api', name: 'api', path: '/repos/api', baseRef: 'main' }

  const handler: StubHandler = (method, params, context) => {
    if (method === 'project.list') return [BARE]
    if (method === 'project.setPaths') return BARE
    return defaultHandler(method, params, context)
  }

  function dataOf(out: string): Record<string, unknown> {
    return soleJsonDocument(out)['data'] as Record<string, unknown>
  }

  it('emits both arrays for a project that has configured neither', async () => {
    const cli = await harness(handler)

    for (const argv of [
      ['project', 'linked', 'api'],
      ['project', 'copied', 'api']
    ]) {
      const data = dataOf((await cli.run([...argv, '--json'])).out)
      expect(data['linkedPaths']).toEqual([])
      expect(data['copiedPaths']).toEqual([])
    }
  })

  // The setup command is the same promise in a different type: a script reading
  // `setupCommand` must not have to tell "" apart from a build without it.
  it('emits an empty setup command for a project that has never named one', async () => {
    const cli = await harness(handler)
    expect(dataOf((await cli.run(['project', 'setup', 'api', '--json'])).out)['setupCommand']).toBe('')
    expect(dataOf((await cli.run(['project', 'linked', 'api', '--json'])).out)['setupCommand']).toBe('')
  })

  it('carries the setup command a project does have', async () => {
    const cli = await harness((method, params, context) =>
      method === 'project.setPaths' ? { ...BARE, setupCommand: 'npm ci' } : handler(method, params, context)
    )
    const data = dataOf((await cli.run(['project', 'setup', 'api', 'npm ci', '--json'])).out)
    expect(data['setupCommand']).toBe('npm ci')
    expect(data['linkedPaths']).toEqual([])
  })

  it('emits them after a list is cleared, which is the same JSON as never having set one', async () => {
    const cli = await harness(handler)
    const data = dataOf((await cli.run(['project', 'linked', 'api', '--clear', '--json'])).out)
    expect(data['linkedPaths']).toEqual([])
    expect(data['copiedPaths']).toEqual([])
  })

  it('emits them in the listing, the add and the remove as well', async () => {
    const cli = await harness(handler)

    const listed = soleJsonDocument((await cli.run(['project', 'list', '--json'])).out)
    expect(listed['data']).toEqual([{ ...BARE, linkedPaths: [], copiedPaths: [], setupCommand: '' }])

    const added = dataOf((await cli.run(['project', 'add', './api', '--json'])).out)
    expect(added['linkedPaths']).toEqual([])
    expect(added['copiedPaths']).toEqual([])

    const removed = dataOf((await cli.run(['project', 'remove', 'api', '--json'])).out)
    expect(removed['project']).toMatchObject({ linkedPaths: [], copiedPaths: [] })
  })

  it('still carries the paths a project does have', async () => {
    const cli = await harness((method, params, context) =>
      method === 'project.setPaths' ? { ...BARE, linkedPaths: ['node_modules'] } : handler(method, params, context)
    )
    const data = dataOf((await cli.run(['project', 'linked', 'api', 'node_modules', '--json'])).out)
    expect(data['linkedPaths']).toEqual(['node_modules'])
    expect(data['copiedPaths']).toEqual([])
  })
})

describe('quitting the app', () => {
  /** A stub that answers `app.quit` and then goes, socket and all, as the app does. */
  async function quittingHarness(options: { reply?: boolean; leave?: boolean } = {}): Promise<Harness> {
    const { reply = true, leave = true } = options
    let stub: StubRuntime | undefined
    const cli = await harness((method, params, context) => {
      if (method !== 'app.quit') return defaultHandler(method, params, context)
      if (leave) setTimeout(() => void stub?.close(), 10)
      return reply ? { quitting: true, pid: 4242 } : NO_REPLY
    })
    stub = cli.stub
    return cli
  }

  it('asks the app to quit and returns once the endpoint has gone', async () => {
    const cli = await quittingHarness()
    const result = await cli.run(['quit'])

    expect(result.code).toBe(ExitCode.Success)
    expect(cli.stub.received.map((entry) => entry.method)).toContain('app.quit')
    expect(result.out).toContain('pid')
    expect(result.out).toContain('4242')
    expect(existsSync(cli.stub.endpoint)).toBe(false)
  })

  // The quit takes the connection the reply was travelling on, so losing it is
  // not evidence of failure. The endpoint is.
  it('counts a connection that died mid-quit as a quit, once the endpoint is gone', async () => {
    const cli = await quittingHarness({ reply: false })
    const result = await cli.run(['quit', '--json'])

    expect(result.code).toBe(ExitCode.Success)
    const data = soleJsonDocument(result.out)['data'] as Record<string, unknown>
    expect(data['quit']).toBe(true)
    expect(data['pid']).toBe(null)
  })

  it('fails when the app was asked and the endpoint is still there', async () => {
    const cli = await quittingHarness({ leave: false })
    const result = await cli.run(['quit', '--timeout-ms', '50', '--json'])

    expect(result.code).toBe(ExitCode.Failure)
    const document = JSON.parse(result.err) as { error: { code: string } }
    expect(document.error.code).toBe('quit_timeout')
  })

  it("passes the app's refusal over unsaved files on, and asks with force when told to", async () => {
    const asked: unknown[] = []
    const cli = await harness((method, params, context) => {
      if (method !== 'app.quit') return defaultHandler(method, params, context)
      asked.push(params)
      if ((params as { force?: boolean }).force !== true)
        throw new StubError('conflict', 'Unsaved in the app: src/math.ts')
      return { quitting: true, pid: 4242 }
    })
    const refused = await cli.run(['quit'])
    expect(refused.code).toBe(ExitCode.Failure)
    expect(refused.err).toContain('src/math.ts')

    await cli.run(['quit', '--force', '--timeout-ms', '10'])
    expect(asked).toEqual([{}, { force: true }])
  })

  it('says nothing is running rather than pretending it quit one', async () => {
    const cli = await harness(defaultHandler, { discovery: 'none' })
    const result = await cli.run(['quit'])

    expect(result.code).toBe(ExitCode.NoRuntime)
    expect(result.err).toMatch(/not running/)
  })
})
