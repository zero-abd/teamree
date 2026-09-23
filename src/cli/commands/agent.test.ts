// `teamree agent event`, as an agent's hook runs it.
//
// It is run by somebody else's program, in the middle of that program's turn,
// with the pane's own state on stdin — so the contract is the opposite of
// every other command's: say nothing, exit 0 whatever happened, and talk to
// exactly the profile whose pane this is. A hook that printed would put its
// output in the agent's context; one that failed would put an error in the
// agent's transcript; one that dialled the default profile would report a
// pane to a runtime that has never heard of it.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExitCode } from '../exit.js'
import type { Streams } from '../output.js'
import { runCli } from '../run.js'
import { startStubRuntime, StubError, type StubHandler, type StubRuntime } from '../stub-runtime.js'

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

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

type Harness = {
  stub: StubRuntime
  dir: string
  run: (argv: string[], stdin?: string) => Promise<{ code: number; out: string; err: string }>
}

async function harness(handler: StubHandler, discovery: 'fresh' | 'none' = 'fresh'): Promise<Harness> {
  const stub = await startStubRuntime(handler)
  cleanups.push(() => stub.close())
  const dir = mkdtempSync(join(tmpdir(), 'teamree-agent-event-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  if (discovery === 'fresh') {
    writeFileSync(
      join(dir, 'runtime.json'),
      JSON.stringify({ endpoint: stub.endpoint, pid: process.pid, version: '0.0.1', startedAt: Date.now() })
    )
  }
  return {
    stub,
    dir,
    run: async (argv, stdin = '') => {
      let out = ''
      let err = ''
      const streams: Streams = { out: (text) => (out += text), err: (text) => (err += text) }
      // The environment names no profile on purpose: the flag is the only
      // thing that may say which runtime this pane belongs to.
      const code = await runCli(argv, { streams, env: {}, cwd: '/work', stdin: async () => stdin })
      return { code, out, err }
    }
  }
}

const NOTIFICATION = JSON.stringify({
  session_id: 'abc',
  hook_event_name: 'Notification',
  notification_type: 'permission_prompt',
  message: 'Claude needs your permission to use Bash',
  cwd: '/repos/api-fix-login'
})

describe('agent event', () => {
  it('reports the event to the profile named on the command line, quoting the notification type', async () => {
    const app = await harness((method, params) => {
      if (method === 'terminal.agentEvent') return { ...TERMINAL, agentEvent: params }
      throw new StubError('unknown_method', method)
    })
    const before = Date.now()
    const result = await app.run(
      ['agent', 'event', '--terminal', 't_1', '--event', 'Notification', '--user-data-dir', app.dir],
      NOTIFICATION
    )

    expect(result).toEqual({ code: ExitCode.Success, out: '', err: '' })
    const [request] = app.stub.received
    expect(request?.method).toBe('terminal.agentEvent')
    expect(request?.params).toMatchObject({ terminalId: 't_1', event: 'Notification', detail: 'permission_prompt' })
    const at = (request?.params as { at: number } | undefined)?.at ?? Number.NaN
    expect(at).toBeGreaterThanOrEqual(before)
    expect(at).toBeLessThanOrEqual(Date.now())
  })

  it('sends no detail for an event whose stdin carries none', async () => {
    const app = await harness(() => TERMINAL)
    await app.run(
      ['agent', 'event', '--terminal', 't_1', '--event', 'Stop', '--user-data-dir', app.dir],
      JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false })
    )
    expect(app.stub.received[0]?.params).toEqual({ terminalId: 't_1', event: 'Stop', at: expect.any(Number) })
  })

  it('takes the flag over the environment, so a hook cannot fire into another profile', async () => {
    const app = await harness(() => TERMINAL)
    const elsewhere = mkdtempSync(join(tmpdir(), 'teamree-other-profile-'))
    cleanups.push(() => rmSync(elsewhere, { recursive: true, force: true }))
    let out = ''
    const code = await runCli(['agent', 'event', '--terminal', 't_1', '--event', 'Stop', '--user-data-dir', app.dir], {
      streams: { out: (text) => (out += text), err: () => {} },
      env: { TEAMREE_USER_DATA_DIR: elsewhere },
      cwd: '/work',
      stdin: async () => '{}'
    })
    expect(code).toBe(ExitCode.Success)
    expect(out).toBe('')
    expect(app.stub.received).toHaveLength(1)
  })

  it('still says nothing and exits 0 with no runtime to talk to', async () => {
    const app = await harness(() => TERMINAL, 'none')
    const result = await app.run(
      ['agent', 'event', '--terminal', 't_1', '--event', 'Stop', '--user-data-dir', app.dir],
      '{}'
    )
    expect(result).toEqual({ code: ExitCode.Success, out: '', err: '' })
  })

  it('still says nothing and exits 0 when the runtime refuses the pane', async () => {
    const app = await harness(() => {
      throw new StubError('not_found', 'no such terminal: t_1')
    })
    const result = await app.run(
      ['agent', 'event', '--terminal', 't_1', '--event', 'Stop', '--user-data-dir', app.dir],
      '{}'
    )
    expect(result).toEqual({ code: ExitCode.Success, out: '', err: '' })
  })

  it('still says nothing and exits 0 when stdin is not JSON', async () => {
    const app = await harness(() => TERMINAL)
    const result = await app.run(
      ['agent', 'event', '--terminal', 't_1', '--event', 'Stop', '--user-data-dir', app.dir],
      'not json'
    )
    expect(result).toEqual({ code: ExitCode.Success, out: '', err: '' })
    expect(app.stub.received[0]?.params).toEqual({ terminalId: 't_1', event: 'Stop', at: expect.any(Number) })
  })

  // The one thing that is still an error: a person typing the command wrong.
  // A hook line is generated, so a usage error is a bug in this app and is
  // worth being loud about — and it can never reach an agent's transcript,
  // because the generated line is never wrong in this way.
  it('rejects an event name it does not know', async () => {
    const app = await harness(() => TERMINAL)
    const result = await app.run(['agent', 'event', '--terminal', 't_1', '--event', 'Nope', '--user-data-dir', app.dir])
    expect(result.code).toBe(ExitCode.Usage)
    expect(app.stub.received).toHaveLength(0)
  })
})
