// A worktree's past conversations, read from fake Claude Code and Codex stores
// in scratch directories. The owner's real stores are never named here.

import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeProjectSlug } from './agent-conversations'
import { listConversations, MAX_CONVERSATIONS, PROMPT_CHARS } from './conversation-list'

const created: string[] = []
let base = ''
let checkout = ''

beforeEach(async () => {
  // Resolved, as the agents record it: the Mac's tmpdir sits behind a symlink.
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'teamree-conversations-')))
  created.push(base)
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(base, 'claude'))
  vi.stubEnv('CODEX_HOME', path.join(base, 'codex'))
  checkout = path.join(base, 'wt.one')
  await mkdir(checkout, { recursive: true })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const line = (value: unknown): string => JSON.stringify(value)
const at = (minute: number): string => new Date(Date.UTC(2026, 8, 20, 10, minute)).toISOString()

/** A Claude Code transcript for `cwd`, under the slug its store uses. */
async function claudeTranscript(cwd: string, sessionId: string, lines: unknown[]): Promise<string> {
  const directory = path.join(base, 'claude', 'projects', claudeProjectSlug(cwd))
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, `${sessionId}.jsonl`)
  await writeFile(file, `${lines.map(line).join('\n')}\n`, 'utf8')
  return file
}

function userLine(cwd: string, text: unknown, minute: number, extra: Record<string, unknown> = {}): unknown {
  return {
    type: 'user',
    cwd,
    sessionId: 's',
    timestamp: at(minute),
    message: { role: 'user', content: text },
    ...extra
  }
}

function assistantLine(cwd: string, id: string, minute: number): unknown {
  return {
    type: 'assistant',
    cwd,
    timestamp: at(minute),
    message: { id, role: 'assistant', content: [{ type: 'text', text: 'ok' }] }
  }
}

/** A Codex rollout under the dated folders its store uses. */
async function codexRollout(cwd: string, sessionId: string, day: string, lines: unknown[]): Promise<void> {
  const directory = path.join(base, 'codex', 'sessions', '2026', '09', day)
  await mkdir(directory, { recursive: true })
  const meta = { timestamp: at(0), type: 'session_meta', payload: { id: sessionId, cwd, originator: 'codex_cli_rs' } }
  const file = path.join(directory, `rollout-2026-09-${day}T10-00-00-${sessionId}.jsonl`)
  await writeFile(file, `${[meta, ...lines].map(line).join('\n')}\n`, 'utf8')
}

function codexEvent(type: 'user_message' | 'agent_message', message: string, minute: number): unknown {
  return { timestamp: at(minute), type: 'event_msg', payload: { type, message } }
}

describe('Claude Code conversations', () => {
  it('reads the first prompt, the time of the last line and the message count', async () => {
    await claudeTranscript(checkout, 'c-1', [
      { type: 'user', isMeta: true, cwd: checkout, timestamp: at(1), message: { content: 'Caveat: local commands' } },
      userLine(checkout, '<command-name>/model</command-name>', 1),
      userLine(checkout, 'fix the login redirect\nand add a test', 2),
      assistantLine(checkout, 'msg_1', 3),
      // One reply streamed as two lines is still one message.
      assistantLine(checkout, 'msg_1', 3),
      userLine(checkout, [{ type: 'tool_result', tool_use_id: 't', content: 'done' }], 4),
      userLine(checkout, [{ type: 'text', text: 'now the logout' }], 5),
      assistantLine(checkout, 'msg_2', 6)
    ])

    const [conversation, ...rest] = await listConversations(checkout, base)
    expect(rest).toEqual([])
    expect(conversation).toEqual({
      agent: 'claude',
      sessionId: 'c-1',
      prompt: 'fix the login redirect',
      updatedAt: Date.parse(at(6)),
      messages: 4
    })
  })

  it('prefers a name the conversation was given', async () => {
    await claudeTranscript(checkout, 'c-1', [
      userLine(checkout, 'fix the login redirect', 2),
      { type: 'summary', summary: 'Login redirect fix', leafUuid: 'x' },
      { type: 'custom-title', customTitle: 'auth work', sessionId: 'c-1' }
    ])
    const [conversation] = await listConversations(checkout, base)
    expect(conversation?.title).toBe('auth work')
    expect(conversation?.prompt).toBe('fix the login redirect')
  })

  it('truncates a long first prompt', async () => {
    await claudeTranscript(checkout, 'c-1', [userLine(checkout, 'x'.repeat(PROMPT_CHARS * 3), 2)])
    const [conversation] = await listConversations(checkout, base)
    expect(conversation?.prompt.length).toBe(PROMPT_CHARS)
    expect(conversation?.prompt.endsWith('…')).toBe(true)
  })

  it('leaves out a transcript nobody ever prompted', async () => {
    await claudeTranscript(checkout, 'c-1', [{ type: 'summary', summary: 'nothing' }])
    expect(await listConversations(checkout, base)).toEqual([])
  })

  it('reads only this checkout: not another directory, nor one whose name makes the same slug', async () => {
    const other = path.join(base, 'wt-one')
    await mkdir(other)
    await claudeTranscript(checkout, 'mine', [userLine(checkout, 'mine', 2)])
    await claudeTranscript(path.join(base, 'elsewhere'), 'theirs', [userLine(path.join(base, 'elsewhere'), 'no', 2)])
    // `wt.one` and `wt-one` share a slug, so one folder holds both.
    await claudeTranscript(other, 'twin', [userLine(other, 'twin', 3)])

    const listed = await listConversations(checkout, base)
    expect(listed.map((conversation) => conversation.sessionId)).toEqual(['mine'])
  })

  it('ignores a file whose name is not a session id', async () => {
    await claudeTranscript(checkout, 'good', [userLine(checkout, 'kept', 2)])
    const directory = path.join(base, 'claude', 'projects', claudeProjectSlug(checkout))
    await writeFile(path.join(directory, 'bad name.jsonl'), `${line(userLine(checkout, 'dropped', 3))}\n`)
    expect((await listConversations(checkout, base)).map((conversation) => conversation.sessionId)).toEqual(['good'])
  })
})

describe('Codex conversations', () => {
  it('reads the rollouts recorded in this checkout', async () => {
    await codexRollout(checkout, 'x-1', '20', [
      {
        timestamp: at(1),
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>' }] }
      },
      codexEvent('user_message', 'rename the config flag', 2),
      codexEvent('agent_message', 'done', 3),
      codexEvent('user_message', 'and the docs', 4),
      codexEvent('agent_message', 'done', 5)
    ])
    await codexRollout(path.join(base, 'elsewhere'), 'x-2', '21', [codexEvent('user_message', 'not here', 2)])

    expect(await listConversations(checkout, base)).toEqual([
      { agent: 'codex', sessionId: 'x-1', prompt: 'rename the config flag', updatedAt: Date.parse(at(5)), messages: 4 }
    ])
  })
})

describe('the list', () => {
  it('puts both agents together, newest first', async () => {
    await claudeTranscript(checkout, 'old', [userLine(checkout, 'old', 1)])
    await codexRollout(checkout, 'middle', '20', [codexEvent('user_message', 'middle', 20)])
    await claudeTranscript(checkout, 'new', [userLine(checkout, 'new', 40)])

    const listed = await listConversations(checkout, base)
    expect(listed.map((conversation) => [conversation.agent, conversation.sessionId])).toEqual([
      ['claude', 'new'],
      ['codex', 'middle'],
      ['claude', 'old']
    ])
  })

  it(`keeps at most ${MAX_CONVERSATIONS}, the newest`, async () => {
    for (let index = 0; index < MAX_CONVERSATIONS + 5; index += 1) {
      const file = await claudeTranscript(checkout, `c-${index}`, [userLine(checkout, `prompt ${index}`, index)])
      const when = new Date(Date.parse(at(index)))
      await utimes(file, when, when)
    }
    const listed = await listConversations(checkout, base)
    expect(listed).toHaveLength(MAX_CONVERSATIONS)
    expect(listed[0]?.sessionId).toBe(`c-${MAX_CONVERSATIONS + 4}`)
  })

  it('is empty when neither store is there', async () => {
    expect(await listConversations(checkout, base)).toEqual([])
  })
})
