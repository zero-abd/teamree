// Tokens per worktree from fake Claude Code and Codex stores in a scratch directory. The owner's real
// stores are never named: both variables point at scratch, and `home` is scratch too.

import { appendFile, mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentKind, Worktree } from '../../shared/entities'
import { claudeProjectSlug } from '../terminals/agent-conversations'
import { UsageService } from './usageService'

let base = ''
let worktrees: Worktree[] = []
let terminals: { worktreeId: string; agent?: AgentKind }[] = []

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'teamree-usage-')))
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(base, 'claude'))
  vi.stubEnv('CODEX_HOME', path.join(base, 'codex'))
  worktrees = []
  terminals = []
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(base, { recursive: true, force: true })
})

async function worktree(id: string, name: string, parentId?: string): Promise<Worktree> {
  const checkout = path.join(base, 'worktrees', 'api', name)
  await mkdir(checkout, { recursive: true })
  const made: Worktree = {
    id,
    projectId: 'p1',
    name,
    branch: name,
    path: checkout,
    startedFrom: 'main',
    state: 'ready',
    createdAt: 1,
    ...(parentId === undefined ? {} : { parentId })
  }
  worktrees.push(made)
  return made
}

function service(): UsageService {
  return new UsageService({ worktrees: () => worktrees, terminals: () => terminals, home: path.join(base, 'home') })
}

const line = (value: unknown): string => `${JSON.stringify(value)}\n`

function reply(
  cwd: string,
  id: string | undefined,
  usage: Record<string, unknown>,
  model = 'claude-sonnet-4-5-20250929'
): unknown {
  return {
    type: 'assistant',
    cwd,
    sessionId: 's',
    message: { ...(id === undefined ? {} : { id }), model, role: 'assistant', usage }
  }
}

async function claudeFile(cwd: string, relative: string, lines: unknown[]): Promise<string> {
  const file = path.join(base, 'claude', 'projects', claudeProjectSlug(cwd), relative)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, lines.map(line).join(''), 'utf8')
  return file
}

async function codexFile(cwd: string, name: string, lines: unknown[]): Promise<string> {
  const directory = path.join(base, 'codex', 'sessions', '2026', '09', '20')
  await mkdir(directory, { recursive: true })
  const meta = { type: 'session_meta', payload: { id: name, cwd, originator: 'codex_cli_rs' } }
  const file = path.join(directory, `rollout-2026-09-20T10-00-00-${name}.jsonl`)
  await writeFile(file, [meta, ...lines].map(line).join(''), 'utf8')
  return file
}

const turn = (model: string): unknown => ({ type: 'turn_context', payload: { cwd: '/x', model } })
function tokenCount(input: number, cached: number, output: number): unknown {
  return {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } }
    }
  }
}

describe('Claude Code transcripts', () => {
  it('counts each reply once, cache reads and writes included, and skips a torn line', async () => {
    const one = await worktree('w1', 'login')
    const usage = {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 200
    }
    const file = await claudeFile(one.path, 's1.jsonl', [
      { type: 'user', cwd: one.path, message: { role: 'user', content: 'fix it' } },
      reply(one.path, 'msg_1', { ...usage, output_tokens: 1 }),
      reply(one.path, 'msg_1', usage),
      reply(one.path, 'msg_2', {
        input_tokens: 3,
        output_tokens: 7,
        cache_creation_input_tokens: 400,
        cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 300 }
      })
    ])
    await appendFile(file, '{"type":"assistant","message":{"usage":{"input_to\n')

    const [read] = await service().usage({ worktreeId: 'w1' })
    expect(read).toMatchObject({
      worktreeId: 'w1',
      input: 13,
      output: 12,
      cacheRead: 1000,
      cacheWrite: 600,
      sessions: 1
    })
    // Sonnet 4.5: $3 in, $15 out, reads 0.1x, 5-minute writes 1.25x, 1-hour writes 2x.
    const expected = (13 * 3 + 12 * 15 + 1000 * 0.3 + 300 * 3.75 + 300 * 6) / 1e6
    expect(read?.costUsd).toBeCloseTo(expected, 10)
  })

  it('takes a resumed session and a subagent into the same count without double-counting', async () => {
    const one = await worktree('w1', 'login')
    const usage = { input_tokens: 100, output_tokens: 50 }
    await claudeFile(one.path, 's1.jsonl', [reply(one.path, 'msg_1', usage)])
    await claudeFile(one.path, 's2.jsonl', [reply(one.path, 'msg_1', usage), reply(one.path, 'msg_2', usage)])
    await claudeFile(one.path, 's2/subagents/agent-a.jsonl', [reply(one.path, 'msg_3', usage)])

    const [read] = await service().usage({ worktreeId: 'w1' })
    expect(read).toMatchObject({ input: 300, output: 150, sessions: 2 })
  })

  it('counts a cwd below the checkout, and never a sibling whose slug starts the same', async () => {
    const one = await worktree('w1', 'fix')
    const other = await worktree('w2', 'fix-login')
    const below = path.join(one.path, 'src')
    await mkdir(below)
    await claudeFile(below, 'a.jsonl', [reply(below, 'msg_a', { input_tokens: 1, output_tokens: 1 })])
    await claudeFile(other.path, 'b.jsonl', [reply(other.path, 'msg_b', { input_tokens: 50, output_tokens: 50 })])

    const read = await service().usage({})
    expect(read.find((each) => each.worktreeId === 'w1')).toMatchObject({ input: 1, output: 1, sessions: 1 })
    expect(read.find((each) => each.worktreeId === 'w2')).toMatchObject({ input: 50, output: 50, sessions: 1 })
  })

  it('keeps the tokens of an unpriced model and leaves the cost null', async () => {
    const one = await worktree('w1', 'login')
    await claudeFile(one.path, 's1.jsonl', [
      reply(one.path, 'msg_1', { input_tokens: 5, output_tokens: 5 }, 'claude-next-9')
    ])
    const [read] = await service().usage({ worktreeId: 'w1' })
    expect(read).toMatchObject({ input: 5, output: 5, costUsd: null })
  })
})

describe('Codex rollouts', () => {
  it("adds each running total's growth under the model named, cached input as cache reads", async () => {
    const one = await worktree('w1', 'login')
    await codexFile(one.path, 'c1', [
      turn('gpt-5-codex'),
      tokenCount(1000, 400, 50),
      tokenCount(1000, 400, 50),
      tokenCount(3000, 2000, 150)
    ])
    await codexFile(path.join(base, 'elsewhere'), 'c2', [turn('gpt-5-codex'), tokenCount(9999, 0, 9999)])

    const [read] = await service().usage({ worktreeId: 'w1' })
    expect(read).toMatchObject({ input: 1000, cacheRead: 2000, output: 150, cacheWrite: 0, sessions: 1 })
    expect(read?.costUsd).toBeCloseTo((1000 * 1.25 + 2000 * 0.125 + 150 * 10) / 1e6, 10)
  })

  it('takes a running total that starts again as new tokens', async () => {
    const one = await worktree('w1', 'login')
    await codexFile(one.path, 'c1', [turn('gpt-5'), tokenCount(100, 0, 10), tokenCount(40, 0, 4)])
    const [read] = await service().usage({ worktreeId: 'w1' })
    expect(read).toMatchObject({ input: 140, output: 14 })
  })
})

describe('reading again', () => {
  it('leaves an unchanged file unread and reads only what was appended', async () => {
    const one = await worktree('w1', 'login')
    const first = reply(one.path, 'msg_1', { input_tokens: 10, output_tokens: 10 })
    const file = await claudeFile(one.path, 's1.jsonl', [first])
    const rollout = await codexFile(one.path, 'c1', [turn('gpt-5'), tokenCount(100, 0, 10)])
    const fixed = new Date(Date.UTC(2026, 8, 20, 10))
    await utimes(file, fixed, fixed)
    const usage = service()
    expect((await usage.usage({ worktreeId: 'w1' }))[0]).toMatchObject({ input: 110, output: 20 })

    // Same size and time but different bytes: a reader that re-reads would see 90.
    await writeFile(file, line(reply(one.path, 'msg_1', { input_tokens: 90, output_tokens: 10 })), 'utf8')
    await utimes(file, fixed, fixed)
    expect((await usage.usage({ worktreeId: 'w1' }))[0]).toMatchObject({ input: 110, output: 20 })

    await appendFile(file, line(reply(one.path, 'msg_2', { input_tokens: 1, output_tokens: 1 })))
    await appendFile(rollout, line(tokenCount(150, 0, 15)))
    expect((await usage.usage({ worktreeId: 'w1' }))[0]).toMatchObject({ input: 161, output: 26 })
  })

  it('holds a half-written line until its newline arrives', async () => {
    const one = await worktree('w1', 'login')
    const file = await claudeFile(one.path, 's1.jsonl', [])
    const whole = line(reply(one.path, 'msg_1', { input_tokens: 7, output_tokens: 3 }))
    await writeFile(file, whole.slice(0, 40), 'utf8')
    const usage = service()
    expect((await usage.usage({ worktreeId: 'w1' }))[0]).toMatchObject({ input: 0, sessions: 0 })
    await appendFile(file, whole.slice(40))
    expect((await usage.usage({ worktreeId: 'w1' }))[0]).toMatchObject({ input: 7, output: 3, sessions: 1 })
  })
})

describe('roll-up', () => {
  it("gives a parent its subtree's total beside its own, and a leaf none", async () => {
    const parent = await worktree('w1', 'rework')
    const child = await worktree('w2', 'migration', 'w1')
    const grandchild = await worktree('w3', 'seed', 'w2')
    await claudeFile(parent.path, 'a.jsonl', [reply(parent.path, 'm1', { input_tokens: 1, output_tokens: 1 })])
    await claudeFile(child.path, 'b.jsonl', [reply(child.path, 'm2', { input_tokens: 10, output_tokens: 10 })])
    await codexFile(grandchild.path, 'c', [turn('mystery-model'), tokenCount(100, 0, 100)])

    const read = await service().usage({ worktreeId: 'w1' })
    expect(read).toHaveLength(1)
    expect(read[0]).toMatchObject({ input: 1, output: 1, sessions: 1 })
    expect(read[0]?.costUsd).not.toBeNull()
    expect(read[0]?.subtree).toEqual({
      input: 111,
      output: 111,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: null,
      sessions: 3
    })

    const leaf = await service().usage({ worktreeId: 'w3' })
    expect(leaf[0]?.subtree).toBeUndefined()
  })

  it('counts agent panes it cannot read, never as zero', async () => {
    await worktree('w1', 'login')
    terminals = [{ worktreeId: 'w1', agent: 'gemini' }, { worktreeId: 'w1', agent: 'claude' }, { worktreeId: 'w1' }]
    expect((await service().usage({ worktreeId: 'w1' }))[0]).toMatchObject({ unknownPanes: 1, sessions: 0 })
  })

  it('answers every worktree of a project', async () => {
    await worktree('w1', 'login')
    await worktree('w2', 'docs')
    worktrees.push({ ...worktrees[0]!, id: 'w9', projectId: 'p2' })
    expect((await service().usage({ projectId: 'p1' })).map((each) => each.worktreeId)).toEqual(['w1', 'w2'])
  })
})
