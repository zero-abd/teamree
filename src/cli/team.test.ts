// Teamwork commands, driven end to end: a real unix socket, the real protocol,
// the real argument parser, and a stub runtime on the other end. Same shape as
// run.test.ts, because these commands are subject to the same contract — one
// JSON document, errors on stderr, the documented exit codes.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_REMOTE_WRITE_BYTES } from '../shared/methods.js'
import { ExitCode } from './exit.js'
import type { Streams } from './output.js'
import { runCli } from './run.js'
import { StubError, startStubRuntime, type StubHandler, type StubRuntime } from './stub-runtime.js'

const NOW = 1_700_000_000_000

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
  }
]

const ANA = 'key-ana-aaaa'
const BO = 'key-bo-bbbb'
const ANN = 'key-ann-cccc'

const PANE_CLAUDE = {
  id: 'peer:AAAABBBBCCCC:t_7',
  title: 'claude',
  shell: '/bin/zsh',
  agent: 'claude',
  running: true,
  busy: true,
  cols: 120,
  rows: 40,
  quietForMs: 2_000
}

const PANE_SHELL = {
  id: 'peer:AAAABBBBCCCC:t_8',
  title: 'zsh',
  shell: '/bin/zsh',
  running: true,
  busy: false,
  quietForMs: 45_000
}

const PANE_BO = {
  id: 'peer:DDDDEEEEFFFF:t_1',
  title: 'zsh',
  shell: '/bin/zsh',
  running: false,
  exitCode: 1,
  busy: false,
  quietForMs: 600_000
}

const PRESENCE = {
  state: 'read',
  projectId: 'p_api',
  worktrees: [
    {
      id: 'w_ana',
      name: 'fix-login',
      branch: 'feature/fix-login',
      state: 'ready',
      panes: [PANE_CLAUDE, PANE_SHELL],
      handle: 'ana',
      publicKey: ANA,
      heardAt: NOW - 3_000,
      live: true
    },
    {
      id: 'w_bo',
      name: 'docs',
      branch: 'docs',
      state: 'ready',
      panes: [PANE_BO],
      handle: 'bo',
      publicKey: BO,
      heardAt: NOW - 600_000,
      live: false
    }
  ],
  teammates: [
    { handle: 'ana', publicKey: ANA, connected: true, heardAt: NOW - 3_000 },
    { handle: 'bo', publicKey: BO, connected: false, heardAt: NOW - 600_000 },
    // On the roster and never heard from: a colleague whose app has never been
    // up while yours was. It must still appear.
    { handle: 'ann', publicKey: ANN, connected: false, heardAt: null }
  ],
  readAt: NOW
}

const STATUS = {
  state: 'read',
  projectId: 'p_api',
  relay: { url: 'wss://relay.example/v1/relay', source: 'repository' },
  disabledReason: null,
  origin: { ok: true },
  enrolled: true,
  links: [
    { publicKey: ANA, handle: 'ana', phase: 'connected', since: NOW - 10_000, attempts: 1 },
    {
      publicKey: BO,
      handle: 'bo',
      phase: 'waiting',
      detail: 'their machine has not arrived',
      since: NOW - 5_000,
      attempts: 3
    }
  ],
  readAt: NOW
}

const MEMBERS = {
  projectId: 'p_api',
  members: [
    { handle: 'ana', publicKey: ANA, addedAt: '2026-01-02', file: '.teamree/members/ana.pub', isSelf: false },
    { handle: 'me', publicKey: 'key-me-dddd', addedAt: '2026-01-03', file: '.teamree/members/me.pub', isSelf: true }
  ],
  problems: [],
  self: { handle: 'me', publicKey: 'key-me-dddd' },
  selfFile: '.teamree/members/me.pub',
  enrolled: true,
  watched: true,
  readAt: NOW
}

const RELAY = {
  projectId: 'p_api',
  file: '.teamree/relay',
  url: 'wss://relay.example/v1/relay',
  source: 'repository',
  problem: null,
  onDisk: { url: 'wss://relay.example/v1/relay', problem: null },
  override: { name: 'TEAMREE_RELAY_URL', value: null },
  readAt: NOW
}

const WATCHERS = {
  projectId: 'p_api',
  panes: [
    {
      terminalId: 't_12',
      watchers: [{ handle: 'ana', publicKey: ANA, since: NOW - 1_000 }],
      typists: [{ handle: 'ana', publicKey: ANA, since: NOW - 900, at: NOW - 100, writes: 4, bytes: 12, refused: 0 }],
      muted: false
    }
  ],
  readAt: NOW
}

const WRITE_LOG = {
  writes: [
    {
      at: NOW - 5_000,
      handle: 'ana',
      publicKey: ANA,
      projectId: 'p_api',
      terminalId: 't_12',
      bytes: 3,
      returns: 1,
      outcome: 'written'
    },
    {
      at: NOW - 1_000,
      handle: 'bo',
      publicKey: BO,
      projectId: 'p_api',
      terminalId: 't_12',
      bytes: 1,
      returns: 0,
      outcome: 'muted',
      reason: 'that pane is muted'
    }
  ],
  problem: null,
  readAt: NOW
}

const START_POINTS = {
  baseRef: 'origin/main',
  options: [
    {
      ref: 'origin/main',
      kind: 'remoteBranch',
      sha: 'a'.repeat(40),
      shortSha: 'aaaaaaa',
      refName: 'origin/main',
      isBase: true,
      isCurrent: false,
      updatedAt: NOW
    },
    {
      ref: 'main',
      kind: 'localBranch',
      sha: 'b'.repeat(40),
      shortSha: 'bbbbbbb',
      refName: 'main',
      isBase: false,
      isCurrent: true,
      updatedAt: NOW
    }
  ],
  total: 57,
  limit: 2,
  truncated: true
}

const LAYOUT = {
  worktreeId: 'wt_1',
  root: {
    kind: 'split',
    direction: 'row',
    sizes: [0.5, 0.5],
    children: [
      { kind: 'leaf', terminalId: 't_1' },
      { kind: 'leaf', terminalId: 't_2' }
    ]
  },
  focusedTerminalId: 't_2'
}

/** Fresh so a test can push its own pane output without touching the others. */
function teamHandler(overrides: Partial<Record<string, StubHandler>> = {}): StubHandler {
  return (method, params, context) => {
    const override = overrides[method]
    if (override) return override(method, params, context)
    switch (method) {
      case 'project.list':
        return PROJECTS
      case 'worktree.list':
        return WORKTREES
      case 'teamwork.status':
        return STATUS
      case 'teamwork.presence':
        return PRESENCE
      case 'members.list':
        return MEMBERS
      case 'members.join':
        return MEMBERS
      case 'teamwork.relay':
        return RELAY
      case 'teamwork.setRelay':
        return RELAY
      case 'teamwork.watchers':
        return WATCHERS
      case 'teamwork.mute':
        return WATCHERS
      case 'teamwork.writeLog':
        return WRITE_LOG
      case 'teamwork.type':
        return { written: true }
      case 'worktree.startPoints':
        return START_POINTS
      case 'layout.get':
        return LAYOUT
      case 'teamwork.watch':
        context.emit('sub_watch', { type: 'data', data: 'npm test\n' })
        return { subscription: 'sub_watch', cols: 120, rows: 40, handle: 'ana' }
      case 'unsubscribe':
        return { unsubscribed: true }
      default:
        throw new StubError('unknown_method', `no handler for ${method}`)
    }
  }
}

type Harness = {
  stub: StubRuntime
  run: (argv: string[]) => Promise<{ code: number; out: string; err: string }>
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function harness(
  handler: StubHandler = teamHandler(),
  options: { discovery?: 'fresh' | 'none' } = {}
): Promise<Harness> {
  const stub = await startStubRuntime(handler)
  cleanups.push(() => stub.close())
  const dir = mkdtempSync(join(tmpdir(), 'teamree-team-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))

  if ((options.discovery ?? 'fresh') !== 'none') {
    writeFileSync(
      join(dir, 'runtime.json'),
      JSON.stringify({
        endpoint: stub.endpoint,
        pid: process.pid,
        version: '0.0.1',
        platform: process.platform,
        startedAt: Date.now()
      })
    )
  }

  return {
    stub,
    run: async (argv) => {
      let out = ''
      let err = ''
      const streams: Streams = { out: (text) => (out += text), err: (text) => (err += text) }
      const code = await runCli(argv, { streams, env: { TEAMREE_USER_DATA_DIR: dir }, cwd: '/work' })
      return { code, out, err }
    }
  }
}

function soleJsonDocument(out: string): Record<string, unknown> {
  expect(out.endsWith('\n')).toBe(true)
  const lines = out.split('\n').filter((line) => line.length > 0)
  expect(lines).toHaveLength(1)
  return JSON.parse(lines[0] as string) as Record<string, unknown>
}

/** Snapshot windows are short so the suite does not spend a second per watch. */
const FAST_WATCH = ['--quiet-ms', '20', '--timeout-ms', '2000']

describe('--json on every teamwork command', () => {
  it('prints exactly one JSON document per command, naming that command', async () => {
    const cli = await harness()
    const invocations: Array<[string, string[]]> = [
      ['team status', ['team', 'status', 'api']],
      ['team members', ['team', 'members', 'api']],
      ['team join', ['team', 'join', 'api']],
      ['team relay show', ['team', 'relay', 'show', 'api']],
      ['team relay set', ['team', 'relay', 'set', 'api', 'wss://relay.example/v1/relay']],
      ['team panes', ['team', 'panes', 'api']],
      ['team watch', ['team', 'watch', 'api', 'ana', '--pane', 't_7', ...FAST_WATCH]],
      ['team type', ['team', 'type', 'api', 'ana', '--pane', 't_7', '--text', 'y']],
      ['team watchers', ['team', 'watchers', 'api']],
      ['team mute', ['team', 'mute', 't_12']],
      ['team unmute', ['team', 'unmute', 't_12']],
      ['team write-log', ['team', 'write-log']],
      ['worktree start-points', ['worktree', 'start-points', 'api']],
      ['worktree layout', ['worktree', 'layout', 'fix-login']]
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

  it('keeps stdout empty and puts the error on stderr when the runtime refuses', async () => {
    const cli = await harness(
      teamHandler({
        'teamwork.status': () => {
          throw new StubError('not_found', 'no project with id p_api')
        }
      })
    )
    const result = await cli.run(['team', 'status', 'api', '--json'])
    expect(result.code).toBe(ExitCode.Failure)
    expect(result.out).toBe('')
    const document = JSON.parse(result.err) as { ok: boolean; exitCode: number; error: { code: string } }
    expect(document).toMatchObject({ ok: false, exitCode: 1 })
    expect(document.error.code).toBe('not_found')
  })
})

describe('team status', () => {
  it('answers the four questions separately', async () => {
    const cli = await harness()
    const result = await cli.run(['team', 'status', 'api'])
    expect(result.code).toBe(ExitCode.Success)
    expect(result.out).toContain('teamwork:')
    expect(result.out).toContain('on')
    expect(result.out).toContain('wss://relay.example/v1/relay (repository)')
    expect(result.out).toMatch(/ana\s+connected\s+yes/)
    expect(result.out).toMatch(/bo\s+waiting\s+no/)
    expect(result.out).toContain('their machine has not arrived')
  })

  it('still lists a teammate the roster has but no link does', async () => {
    const cli = await harness()
    const result = await cli.run(['team', 'status', 'api'])
    expect(result.out).toMatch(/ann\s+no link\s+no\s+never/)
  })

  it('says "not configured" rather than "offline", and still exits 0', async () => {
    const cli = await harness(
      teamHandler({
        'teamwork.status': () => ({
          ...STATUS,
          relay: null,
          disabledReason: 'no relay is configured for this project',
          origin: { ok: false, reason: 'this checkout has no origin remote' },
          enrolled: false,
          links: []
        })
      })
    )
    const result = await cli.run(['team', 'status', 'api'])
    expect(result.code).toBe(ExitCode.Success)
    expect(result.out).toContain('off - no relay is configured')
    expect(result.out).toContain('relay:')
    expect(result.out).toContain('none')
    expect(result.out).toContain('not shared - this checkout has no origin remote')
    expect(result.out).toContain('teamree team join')
  })

  // The beat between `project.add` and the reconcile it sets off. The runtime
  // answers that it has not read this project, which is neither "teamwork is
  // off" nor a failure, and a script that branched on `disabledReason` here
  // would be branching on a finding nobody has made.
  it('says a project teamwork has not read yet is exactly that, and still exits 0', async () => {
    const cli = await harness(
      teamHandler({
        'teamwork.status': () => ({ state: 'unread', projectId: 'p_api', readAt: NOW })
      })
    )
    const result = await cli.run(['team', 'status', 'api'])
    expect(result.code).toBe(ExitCode.Success)
    expect(result.out).toContain('not read yet')
    expect(result.out).toContain('Ask again in a moment.')
    // And no roster table under it, invented out of a second question the
    // runtime cannot answer about this project either.
    expect(cli.stub.received.some((request) => request.method === 'teamwork.presence')).toBe(false)
  })

  it('resolves the project by id, by name and by path', async () => {
    const cli = await harness()
    for (const token of ['p_web', 'web', '/repos/web']) {
      await cli.run(['team', 'status', token])
      expect(cli.stub.received.at(-1)).toMatchObject({ method: 'teamwork.presence', params: { projectId: 'p_web' } })
    }
  })
})

describe('team members and team join', () => {
  it('marks which key is this machine and where joining would write', async () => {
    const cli = await harness()
    const result = await cli.run(['team', 'members', 'api'])
    expect(result.out).toMatch(/me\s+yes\s+2026-01-03/)
    expect(result.out).toContain('.teamree/members/ana.pub')
    expect(result.out).toContain('watched:')
  })

  it('says the file still has to be committed', async () => {
    const cli = await harness()
    const result = await cli.run(['team', 'join', 'api'])
    expect(result.code).toBe(ExitCode.Success)
    expect(result.out).toContain('Commit and push it')
  })

  it('passes --handle through and omits it when absent', async () => {
    const cli = await harness()
    await cli.run(['team', 'join', 'api', '--handle', 'ana'])
    expect(cli.stub.received.at(-1)).toMatchObject({
      method: 'members.join',
      params: { projectId: 'p_api', handle: 'ana' }
    })
    await cli.run(['team', 'join', 'api'])
    expect(cli.stub.received.at(-1)?.params).toEqual({ projectId: 'p_api' })
  })
})

describe('team relay', () => {
  it('reports both places the URL could have come from', async () => {
    const cli = await harness()
    const result = await cli.run(['team', 'relay', 'show', 'api'])
    expect(result.out).toContain('wss://relay.example/v1/relay')
    expect(result.out).toContain('TEAMREE_RELAY_URL=(not set)')
  })

  it('sends the URL verbatim, letting the runtime be the one validator', async () => {
    const cli = await harness()
    await cli.run(['team', 'relay', 'set', 'api', '  wss://relay.example/v1/relay  '])
    expect(cli.stub.received.at(-1)).toMatchObject({
      method: 'teamwork.setRelay',
      params: { projectId: 'p_api', url: '  wss://relay.example/v1/relay  ' }
    })
  })

  it('passes the runtime refusal on as exit 1 with its own words', async () => {
    const cli = await harness(
      teamHandler({
        'teamwork.setRelay': () => {
          throw new StubError('bad_relay_url', 'that is not a relay URL: use wss:// rather than https://')
        }
      })
    )
    const result = await cli.run(['team', 'relay', 'set', 'api', 'https://relay.example'])
    expect(result.code).toBe(ExitCode.Failure)
    expect(result.err).toContain('use wss:// rather than https://')
    expect(result.out).toBe('')
  })

  it('warns when an override means the file it just wrote is not what this machine dials', async () => {
    const cli = await harness(
      teamHandler({
        'teamwork.setRelay': () => ({
          ...RELAY,
          url: 'wss://other.example/v1/relay',
          source: 'environment',
          override: { name: 'TEAMREE_RELAY_URL', value: 'wss://other.example/v1/relay' }
        })
      })
    )
    const result = await cli.run(['team', 'relay', 'set', 'api', 'wss://relay.example/v1/relay'])
    expect(result.out).toContain('TEAMREE_RELAY_URL is set')
    expect(result.out).toContain('wss://other.example/v1/relay')
  })
})

describe('teammate and pane selectors', () => {
  it('accepts a handle, a handle in the wrong case, and a public key prefix', async () => {
    const cli = await harness()
    for (const token of ['ana', 'ANA', 'key-ana']) {
      const result = await cli.run(['team', 'watch', 'api', token, '--pane', 't_7', ...FAST_WATCH, '--json'])
      expect(result.code, result.err).toBe(ExitCode.Success)
      expect((soleJsonDocument(result.out)['data'] as { handle: string }).handle).toBe('ana')
    }
  })

  it('refuses an ambiguous key prefix rather than picking one', async () => {
    const cli = await harness()
    const result = await cli.run(['team', 'watch', 'api', 'key-an', '--json'])
    expect(result.code).toBe(ExitCode.Failure)
    expect(result.out).toBe('')
    const document = JSON.parse(result.err) as { error: { code: string; data: { matches: unknown[] } } }
    expect(document.error.code).toBe('ambiguous_selector')
    expect(document.error.data.matches).toHaveLength(2)
  })

  it('names the roster when the teammate is not on it', async () => {
    const cli = await harness()
    const result = await cli.run(['team', 'watch', 'api', 'nobody'])
    expect(result.code).toBe(ExitCode.Failure)
    expect(result.err).toContain('No teammate matches "nobody"')
    expect(result.err).toContain('ana, bo, ann')
  })

  it('refuses to guess which of several panes, and lists them', async () => {
    const cli = await harness()
    const result = await cli.run(['team', 'watch', 'api', 'ana', '--json'])
    expect(result.code).toBe(ExitCode.Failure)
    const document = JSON.parse(result.err) as { error: { code: string; data: { panes: unknown[] } } }
    expect(document.error.code).toBe('ambiguous_pane')
    expect(document.error.data.panes).toHaveLength(2)
  })

  it('takes the only pane when there is only one', async () => {
    const cli = await harness()
    const result = await cli.run(['team', 'watch', 'api', 'bo', ...FAST_WATCH, '--json'])
    expect(result.code, result.err).toBe(ExitCode.Success)
    expect((soleJsonDocument(result.out)['data'] as { paneId: string }).paneId).toBe('peer:DDDDEEEEFFFF:t_1')
  })

  it("accepts either the pane id or the owner's own terminal id", async () => {
    const cli = await harness()
    for (const token of ['peer:AAAABBBBCCCC:t_8', 't_8']) {
      await cli.run(['team', 'watch', 'api', 'ana', '--pane', token, ...FAST_WATCH])
      expect(cli.stub.received.find((entry) => entry.method === 'teamwork.watch')).toBeDefined()
      expect(cli.stub.received.filter((entry) => entry.method === 'teamwork.watch').at(-1)).toMatchObject({
        params: { paneId: 'peer:AAAABBBBCCCC:t_8' }
      })
    }
  })

  it('says which panes exist when none matches', async () => {
    const cli = await harness()
    const result = await cli.run(['team', 'watch', 'api', 'ana', '--pane', 't_99'])
    expect(result.code).toBe(ExitCode.Failure)
    expect(result.err).toContain('no pane matching "t_99"')
  })
})

describe('team watch', () => {
  it('takes a bounded snapshot and releases the subscription', async () => {
    const cli = await harness()
    const result = await cli.run(['team', 'watch', 'api', 'ana', '--pane', 't_7', ...FAST_WATCH])
    expect(result.code, result.err).toBe(ExitCode.Success)
    expect(result.out).toContain('npm test')
    expect(cli.stub.received.some((entry) => entry.method === 'unsubscribe')).toBe(true)
  })

  it("reports the owner's pty size rather than negotiating one", async () => {
    const cli = await harness()
    const seen = await cli.run(['team', 'watch', 'api', 'ana', '--pane', 't_7', ...FAST_WATCH, '--json'])
    expect(soleJsonDocument(seen.out)['data']).toMatchObject({ cols: 120, rows: 40, reason: 'quiet' })

    // A pane whose owner sent no dimensions letterboxes to 80x24.
    const unsized = await cli.run(['team', 'watch', 'api', 'ana', '--pane', 't_8', ...FAST_WATCH, '--json'])
    expect(soleJsonDocument(unsized.out)['data']).toMatchObject({ cols: 80, rows: 24 })
  })

  it('announces bytes the relay dropped rather than presenting a gap as output', async () => {
    const cli = await harness(
      teamHandler({
        'teamwork.watch': (_method, _params, context) => {
          context.emit('sub_watch', { type: 'elided', bytes: 4096 })
          context.emit('sub_watch', { type: 'data', data: 'tail\n' })
          return { subscription: 'sub_watch', cols: 80, rows: 24, handle: 'ana' }
        }
      })
    )
    const result = await cli.run(['team', 'watch', 'api', 'ana', '--pane', 't_7', ...FAST_WATCH])
    expect(result.out).toContain('[4096 bytes elided by the relay]')
    expect(result.out).toContain('tail')
  })

  it('stops on an exit and says so', async () => {
    const cli = await harness(
      teamHandler({
        'teamwork.watch': (_method, _params, context) => {
          context.emit('sub_watch', { type: 'data', data: 'done\n' })
          context.emit('sub_watch', { type: 'exit', exitCode: 3 })
          return { subscription: 'sub_watch', cols: 80, rows: 24, handle: 'ana' }
        }
      })
    )
    const result = await cli.run(['team', 'watch', 'api', 'ana', '--pane', 't_7', ...FAST_WATCH, '--json'])
    expect(result.code).toBe(ExitCode.Success)
    expect(soleJsonDocument(result.out)['data']).toMatchObject({ reason: 'exit', exitCode: 3 })
  })

  it('stops on a lost link rather than showing a frozen pane as live', async () => {
    const cli = await harness(
      teamHandler({
        'teamwork.watch': (_method, _params, context) => {
          context.emit('sub_watch', { type: 'lost', reason: 'their machine went away' })
          return { subscription: 'sub_watch', cols: 80, rows: 24, handle: 'ana' }
        }
      })
    )
    const result = await cli.run(['team', 'watch', 'api', 'ana', '--pane', 't_7', ...FAST_WATCH])
    expect(result.code).toBe(ExitCode.Success)
    expect(result.out).toContain('[link lost: their machine went away]')
  })

  it('says plainly when a pane had nothing to say', async () => {
    const cli = await harness(
      teamHandler({
        'teamwork.watch': () => ({ subscription: 'sub_watch', cols: 80, rows: 24, handle: 'ana' })
      })
    )
    const result = await cli.run(['team', 'watch', 'api', 'ana', '--pane', 't_7', ...FAST_WATCH])
    expect(result.out).toContain('[ana: nothing to read]')
  })

  it('refuses --follow together with --json, because --json promises one document', async () => {
    const cli = await harness()
    const result = await cli.run(['team', 'watch', 'api', 'ana', '--pane', 't_7', '--follow', '--json'])
    expect(result.code).toBe(ExitCode.Usage)
    expect(result.out).toBe('')
    const document = JSON.parse(result.err) as { exitCode: number; error: { code: string; message: string } }
    expect(document.exitCode).toBe(2)
    expect(document.error.message).toContain('--follow and --json')
  })

  it('streams under --follow and stops when the pane exits, printing each byte once', async () => {
    const cli = await harness(
      teamHandler({
        'teamwork.watch': (_method, _params, context) => {
          context.emit('sub_watch', { type: 'data', data: 'line one\n' })
          context.emit('sub_watch', { type: 'data', data: 'line two\n' })
          context.emit('sub_watch', { type: 'exit', exitCode: 0 })
          return { subscription: 'sub_watch', cols: 80, rows: 24, handle: 'ana' }
        }
      })
    )
    const result = await cli.run(['team', 'watch', 'api', 'ana', '--pane', 't_7', '--follow'])
    expect(result.code).toBe(ExitCode.Success)
    expect(result.out).toBe('line one\nline two\n\n[pane exited 0]\n')
    expect(cli.stub.received.some((entry) => entry.method === 'unsubscribe')).toBe(true)
  })

  it('surfaces a refusal to open the watch as exit 1', async () => {
    const cli = await harness(
      teamHandler({
        'teamwork.watch': () => {
          throw new StubError('not_found', 'bo is not connected, so their pane cannot be read')
        }
      })
    )
    const result = await cli.run(['team', 'watch', 'api', 'bo', ...FAST_WATCH])
    expect(result.code).toBe(ExitCode.Failure)
    expect(result.err).toContain('is not connected')
  })
})

describe('team type', () => {
  it('sends the text verbatim and appends a return only with --enter', async () => {
    const cli = await harness()
    await cli.run(['team', 'type', 'api', 'ana', '--pane', 't_7', '--text', 'npm test'])
    expect(cli.stub.received.at(-1)).toMatchObject({
      method: 'teamwork.type',
      params: { projectId: 'p_api', paneId: 'peer:AAAABBBBCCCC:t_7', data: 'npm test' }
    })
    await cli.run(['team', 'type', 'api', 'ana', '--pane', 't_7', '--text', 'npm test', '--enter'])
    expect(cli.stub.received.at(-1)).toMatchObject({ params: { data: 'npm test\r' } })
  })

  it('refuses an oversized write locally, as a usage error with the number in it', async () => {
    const cli = await harness()
    const result = await cli.run([
      'team',
      'type',
      'api',
      'ana',
      '--pane',
      't_7',
      '--text',
      'x'.repeat(MAX_REMOTE_WRITE_BYTES + 1)
    ])
    expect(result.code).toBe(ExitCode.Usage)
    expect(result.err).toContain(String(MAX_REMOTE_WRITE_BYTES))
    // Nothing was attempted: the cap is checked before a pane is even resolved.
    expect(cli.stub.received.some((entry) => entry.method === 'teamwork.type')).toBe(false)
  })

  it('passes a mute straight through rather than swallowing the keystroke', async () => {
    const cli = await harness(
      teamHandler({
        'teamwork.type': () => {
          throw new StubError('muted', 'that pane is muted')
        }
      })
    )
    const result = await cli.run(['team', 'type', 'api', 'ana', '--pane', 't_7', '--text', 'y', '--json'])
    expect(result.code).toBe(ExitCode.Failure)
    expect(result.out).toBe('')
    const document = JSON.parse(result.err) as { error: { code: string } }
    expect(document.error.code).toBe('muted')
  })

  it('insists on --text', async () => {
    const cli = await harness()
    const result = await cli.run(['team', 'type', 'api', 'ana'])
    expect(result.code).toBe(ExitCode.Usage)
    expect(result.err).toContain('--text is required')
  })
})

describe('team panes', () => {
  it('lists every teammate pane with the id the other commands take', async () => {
    const cli = await harness()
    const result = await cli.run(['team', 'panes', 'api'])
    expect(result.out).toContain('peer:AAAABBBBCCCC:t_7')
    expect(result.out).toContain('peer:DDDDEEEEFFFF:t_1')
    expect(result.out).toMatch(/bo\s+peer:DDDDEEEEFFFF:t_1\s+docs\s+zsh\s+exit 1\s+no/)
  })

  it('restricts to one teammate', async () => {
    const cli = await harness()
    const result = await cli.run(['team', 'panes', 'api', '--teammate', 'ana', '--json'])
    const data = soleJsonDocument(result.out)['data'] as { panes: Array<{ paneId: string }> }
    expect(data.panes.map((pane) => pane.paneId)).toEqual(['peer:AAAABBBBCCCC:t_7', 'peer:AAAABBBBCCCC:t_8'])
  })

  // The same beat `team status` reports as "not read yet", reaching a command
  // whose whole output is a list. An empty table here would read as "this
  // teammate has no panes", so the wait gets an exit and a code of its own —
  // which is the one thing an agent can branch on without parsing prose.
  it('refuses rather than printing an empty table for a project teamwork has not read', async () => {
    const cli = await harness(
      teamHandler({
        'teamwork.presence': () => ({ state: 'unread', projectId: 'p_api', readAt: NOW })
      })
    )
    const result = await cli.run(['team', 'panes', 'api', '--json'])
    expect(result.code).toBe(ExitCode.Failure)
    const document = JSON.parse(result.err) as { error: { code: string; hint: string } }
    expect(document.error.code).toBe('not_read_yet')
    expect(document.error.hint).toContain('Ask again in a moment.')
  })
})

describe('the owner half: watchers, mute, write log', () => {
  it('names who is reading and who has typed', async () => {
    const cli = await harness()
    const result = await cli.run(['team', 'watchers', 'api'])
    expect(result.out).toMatch(/t_12/)
    expect(result.out).toContain('ana (4 writes, 0 refused)')
  })

  it('mutes and unmutes the same pane through the one method', async () => {
    const cli = await harness()
    await cli.run(['team', 'mute', 't_12'])
    expect(cli.stub.received.at(-1)).toMatchObject({
      method: 'teamwork.mute',
      params: { terminalId: 't_12', muted: true }
    })
    await cli.run(['team', 'unmute', 't_12'])
    expect(cli.stub.received.at(-1)).toMatchObject({ params: { terminalId: 't_12', muted: false } })
  })

  it('says a mute stops the bytes rather than hiding the pane', async () => {
    const cli = await harness()
    const result = await cli.run(['team', 'mute', 't_12'])
    expect(result.out).toContain('keeps streaming')
    expect(result.out).toContain('Reading it right now: ana.')
  })

  it('prints the record with byte counts and never the bytes', async () => {
    const cli = await harness()
    const result = await cli.run(['team', 'write-log'])
    expect(result.out).toMatch(/ana\s+t_12\s+3\s+1\s+written/)
    expect(result.out).toContain('that pane is muted')
  })

  it('passes --limit through and warns when the record is incomplete', async () => {
    const cli = await harness(
      teamHandler({ 'teamwork.writeLog': () => ({ ...WRITE_LOG, problem: 'log file truncated' }) })
    )
    const result = await cli.run(['team', 'write-log', '--limit', '5'])
    expect(cli.stub.received.at(-1)).toMatchObject({ method: 'teamwork.writeLog', params: { limit: 5 } })
    expect(result.out).toContain('The record may be incomplete: log file truncated')
  })
})

describe('worktree start-points and layout', () => {
  it('lists refs, marks the base and the current one, and reports the cap', async () => {
    const cli = await harness()
    const result = await cli.run(['worktree', 'start-points', 'api'])
    expect(result.out).toMatch(/origin\/main\s+remoteBranch\s+aaaaaaa\s+base/)
    expect(result.out).toMatch(/main\s+localBranch\s+bbbbbbb\s+current/)
    expect(result.out).toContain('Showing 2 of 57')
  })

  it('passes --limit through and resolves the project by path', async () => {
    const cli = await harness()
    await cli.run(['worktree', 'start-points', '/repos/api', '--limit', '10'])
    expect(cli.stub.received.at(-1)).toMatchObject({
      method: 'worktree.startPoints',
      params: { projectId: 'p_api', limit: 10 }
    })
  })

  it('draws the pane tree and marks the focused pane', async () => {
    const cli = await harness()
    const result = await cli.run(['worktree', 'layout', 'feature/fix-login'])
    expect(result.code, result.err).toBe(ExitCode.Success)
    expect(result.out).toContain('row split (50%/50%)')
    expect(result.out).toContain('t_2  <- focused')
    expect(cli.stub.received.at(-1)).toMatchObject({ method: 'layout.get', params: { worktreeId: 'wt_1' } })
  })

  it('says so when a worktree has no panes', async () => {
    const cli = await harness(teamHandler({ 'layout.get': () => ({ ...LAYOUT, root: null, focusedTerminalId: null }) }))
    const result = await cli.run(['worktree', 'layout', 'fix-login'])
    expect(result.out).toContain('(no panes)')
  })
})

describe('exit codes and usage', () => {
  it('returns 2 for a missing argument on every team command that takes one', async () => {
    const cli = await harness()
    const invocations = [
      ['team', 'status'],
      ['team', 'members'],
      ['team', 'join'],
      ['team', 'relay', 'show'],
      ['team', 'relay', 'set', 'api'],
      ['team', 'watch', 'api'],
      ['team', 'type', 'api'],
      ['team', 'panes'],
      ['team', 'watchers'],
      ['team', 'mute'],
      ['team', 'unmute'],
      ['worktree', 'start-points'],
      ['worktree', 'layout']
    ]
    for (const argv of invocations) {
      const result = await cli.run(argv)
      expect(result.code, argv.join(' ')).toBe(ExitCode.Usage)
      expect(result.out).toBe('')
    }
  })

  it('returns 2 for a bare team group and 0 for its help', async () => {
    const cli = await harness(teamHandler(), { discovery: 'none' })
    expect((await cli.run(['team'])).code).toBe(ExitCode.Usage)
    const help = await cli.run(['team', '--help'])
    expect(help.code).toBe(ExitCode.Success)
    expect(help.out).toContain('team watch')
    expect(help.out).toContain('team relay set')
  })

  it('returns 3 when no runtime is listening, for a team command like any other', async () => {
    const cli = await harness(teamHandler(), { discovery: 'none' })
    const result = await cli.run(['team', 'status', 'api'])
    expect(result.code).toBe(ExitCode.NoRuntime)
    expect(result.out).toBe('')
  })

  it('documents itself without a runtime', async () => {
    const cli = await harness(teamHandler(), { discovery: 'none' })
    const result = await cli.run(['team', 'watch', '--help'])
    expect(result.code).toBe(ExitCode.Success)
    expect(result.out).toContain('--follow')
    expect(result.out).toContain('bounded snapshot')
  })
})
