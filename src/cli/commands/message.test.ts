// `teamree msg` against a stub runtime: what each command sends, how `ask` blocks,
// times out and resumes, and what `wait` hands a supervisor.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Worktree } from '../../shared/entities.js'
import type { TaskMessage } from '../../shared/messages.js'
import type { Streams } from '../output.js'
import { runCli } from '../run.js'
import { StubError, startStubRuntime, type StubRuntime } from '../stub-runtime.js'

const row = (id: string, name: string, parentId?: string): Worktree => ({
  id,
  projectId: 'p1',
  name,
  branch: id,
  path: `/wt/${id}`,
  startedFrom: 'main',
  state: 'ready',
  createdAt: 1,
  ...(parentId === undefined ? {} : { parentId })
})
const WORKTREES = [row('lead', 'Rate limits'), row('tests', 'Write tests', 'lead'), row('docs', 'Docs', 'lead')]
const CHILD_PANE = { TEAMREE_TERMINAL_ID: 'term_2', TEAMREE_WORKTREE_ID: 'tests' }
const LEAD_PANE = { TEAMREE_TERMINAL_ID: 'term_1', TEAMREE_WORKTREE_ID: 'lead' }

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

const message = (id: number, extra: Partial<TaskMessage>): TaskMessage => ({
  id,
  projectId: 'p1',
  kind: 'note',
  from: { worktreeId: 'tests', terminalId: 'term_2' },
  to: { worktreeId: 'lead' },
  text: 'x',
  at: 1,
  state: 'queued',
  ...extra
})

async function cli(messages: TaskMessage[]): Promise<{
  stub: StubRuntime
  run: (argv: string[], env?: NodeJS.ProcessEnv) => Promise<{ code: number; out: string }>
}> {
  const stub = await startStubRuntime((method, params) => {
    if (method === 'worktree.list') return WORKTREES
    if (method === 'message.list') {
      const { kinds } = params as { kinds?: string[] }
      return messages.filter((entry) => kinds === undefined || kinds.includes(entry.kind))
    }
    if (method === 'message.read') {
      const { ids } = params as { ids: number[] }
      for (const entry of messages) if (ids.includes(entry.id)) entry.state = 'read'
      return { read: ids.length }
    }
    if (method === 'message.send') {
      const sent = params as Omit<TaskMessage, 'id' | 'at' | 'state' | 'projectId'>
      const stored = message(messages.length + 1, { ...sent, to: { worktreeId: 'lead' } } as Partial<TaskMessage>)
      messages.push(stored)
      return [stored]
    }
    throw new StubError('unknown_method', method)
  })
  cleanups.push(() => stub.close())
  const dir = mkdtempSync(join(tmpdir(), 'teamree-msg-'))
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
    run: async (argv, env = CHILD_PANE) => {
      let out = ''
      const streams: Streams = { out: (text) => (out += text), err: (text) => (out += text) }
      const code = await runCli(argv, { streams, env: { ...env, TEAMREE_USER_DATA_DIR: dir }, cwd: '/elsewhere' })
      return { code, out }
    }
  }
}

const sends = (stub: StubRuntime): unknown[] =>
  stub.received.filter((call) => call.method === 'message.send').map((call) => call.params)

describe('teamree msg ask', () => {
  it('asks the parent from this pane, blocks until the answer, and marks the answer read', async () => {
    const messages: TaskMessage[] = []
    const { stub, run } = await cli(messages)
    setTimeout(() => messages.push(message(2, { kind: 'reply', replyTo: 1, text: 'postgres' })), 300)
    const { code, out } = await run(['msg', 'ask', 'Which', 'store?', '--options', 'redis, postgres'])
    expect({ code, out }).toEqual({ code: 0, out: 'postgres\n' })
    expect(sends(stub)).toEqual([
      {
        from: { worktreeId: 'tests', terminalId: 'term_2' },
        to: { relation: 'parent' },
        kind: 'ask',
        text: 'Which store?',
        options: ['redis', 'postgres']
      }
    ])
    // Read, so the reply is never pasted into the prompt that already has it.
    expect(messages[1]?.state).toBe('read')
  })

  it('times out with the id to resume, and resumes without asking again', async () => {
    const messages: TaskMessage[] = []
    const { stub, run } = await cli(messages)
    const timedOut = await run(['msg', 'ask', 'Ship?', '--timeout-ms', '300'])
    expect(timedOut.code).toBe(1)
    expect(timedOut.out).toContain('No answer to #1 after 300ms.')
    expect(timedOut.out).toContain('teamree msg ask --resume 1')

    setTimeout(() => messages.push(message(2, { kind: 'reply', replyTo: 1, text: 'yes' })), 300)
    expect(await run(['msg', 'ask', '--resume', '1'])).toEqual({ code: 0, out: 'yes\n' })
    expect(sends(stub)).toHaveLength(1)
  })
})

describe('teamree msg reply, done, note', () => {
  it('replies to whoever asked', async () => {
    const messages = [message(7, { kind: 'ask', text: 'Which?' })]
    const { stub, run } = await cli(messages)
    expect(await run(['msg', 'reply', '7', 'postgres'], LEAD_PANE)).toEqual({ code: 0, out: 'answered #7\n' })
    expect(sends(stub)).toEqual([
      {
        from: { worktreeId: 'lead', terminalId: 'term_1' },
        to: { worktreeId: 'tests', terminalId: 'term_2' },
        kind: 'reply',
        replyTo: 7,
        text: 'postgres'
      }
    ])
  })

  it('reports done to the parent, failed when asked, and a note wherever --to says', async () => {
    const { stub, run } = await cli([])
    expect((await run(['msg', 'done', '--failed', 'Could not reproduce.'])).out).toBe('done: told Rate limits\n')
    await run(['msg', 'note', 'Schema moved.', '--to', 'siblings'])
    expect(sends(stub)).toEqual([
      expect.objectContaining({
        to: { relation: 'parent' },
        kind: 'done',
        outcome: 'failed',
        text: 'Could not reproduce.'
      }),
      expect.objectContaining({ to: { relation: 'siblings' }, kind: 'note', text: 'Schema moved.' })
    ])
  })

  it('refuses done from outside a worktree', async () => {
    const { run } = await cli([])
    const { code, out } = await run(['msg', 'done', 'x'], {})
    expect(code).toBe(1)
    expect(out).toContain('No worktree here')
  })
})

describe('teamree msg inbox', () => {
  it('lists what waits for you outside a pane, open asks included, and marks the rest read', async () => {
    const messages = [
      message(1, { kind: 'ask', to: { you: true }, text: 'Ship?', state: 'read' }),
      message(2, { kind: 'done', to: { you: true }, outcome: 'succeeded', text: 'Shipped.' }),
      message(3, { kind: 'note', to: { worktreeId: 'lead' }, text: 'not yours' })
    ]
    const { run } = await cli(messages)
    const { out } = await run(['msg', 'inbox'], {})
    expect(out).toBe('#1 ask from "Write tests": Ship?\n#2 "Write tests" done (succeeded): Shipped.\n')
    expect(messages.map((entry) => entry.state)).toEqual(['read', 'read', 'queued'])
    expect((await run(['msg', 'inbox'], LEAD_PANE)).out).toBe('#3 note from "Write tests": not yours\n')
  })
})

describe('teamree msg wait', () => {
  it("returns the children's done messages once, and marks them read", async () => {
    const messages = [
      message(1, { kind: 'done', outcome: 'succeeded', text: 'Tests pass.', paths: ['a.ts'] }),
      message(2, { kind: 'note', from: { worktreeId: 'docs' }, text: 'fyi' }),
      message(3, { kind: 'done', from: { worktreeId: 'docs' }, outcome: 'failed', text: 'No.', state: 'delivered' })
    ]
    const { run } = await cli(messages)
    const { code, out } = await run(['msg', 'wait', '--kind', 'done', '--from', 'children'], LEAD_PANE)
    expect(code).toBe(0)
    expect(out).toBe('#1 "Write tests" done (succeeded): Tests pass. Files: 1.\n')
    expect(messages[0]?.state).toBe('read')
    const again = await run(['msg', 'wait', '--kind', 'done', '--timeout-ms', '300'], LEAD_PANE)
    expect(again.code).toBe(1)
  })

  it('refuses an unknown kind', async () => {
    const { run } = await cli([])
    expect((await run(['msg', 'wait', '--kind', 'dispatch'], LEAD_PANE)).code).toBe(2)
  })
})
