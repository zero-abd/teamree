// Subagents read off a store laid out as Claude Code 2.1.282 writes it, and told by hooks.

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canSpawnPty, waitUntil, writeFakeAgent } from './pty-test-support'
import type { TerminalRecord } from './session-restore'
import { TerminalSessionManager, type SessionRepository } from './session-manager'
import { SubagentTracker, transcriptLines } from './subagents'

const SESSION = '60b42195-d46f-4114-8a14-1854ee57a6fa'
const ELSEWHERE = '11111111-2222-3333-4444-555555555555'

let project: string
let changes: string[]
let live: boolean

beforeEach(() => {
  project = mkdtempSync(path.join(os.tmpdir(), 'teamree-subagents-'))
  changes = []
  live = true
})

afterEach(() => {
  rmSync(project, { recursive: true, force: true })
})

/** A tracker whose pane started `startedAfter` ms from now (a minute ago by default), reading `project` whatever the cwd. */
function tracker(startedAfter = -60_000): SubagentTracker {
  return new SubagentTracker({
    onChange: (terminalId) => changes.push(terminalId),
    projectDirectory: () => project,
    pollMs: 0,
    clock: () => Date.now() + startedAfter
  })
}

function follow(subagents: SubagentTracker, sessionId: string | null = SESSION): Promise<void> {
  return subagents.track('term_1', {
    cwd: '/repo',
    ...(sessionId === null ? {} : { sessionId }),
    isRunning: () => live
  })
}

function subagent(
  id: string,
  meta: Record<string, unknown>,
  lines: readonly object[] = [{ type: 'user', message: { role: 'user', content: 'go' } }],
  sessionId = SESSION
): void {
  const folder = path.join(project, sessionId, 'subagents')
  mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(folder, `agent-${id}.meta.json`), JSON.stringify(meta))
  writeFileSync(path.join(folder, `agent-${id}.jsonl`), lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
}

/** A `<task-notification>` as the parent's transcript carries it. */
function notification(id: string, status: string, at = new Date()): object {
  return {
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: at.toISOString(),
    content: `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>${status}</status>\n<summary>Agent finished</summary>\n</task-notification>`
  }
}

function transcript(file: string, lines: readonly object[]): void {
  appendFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
}

const main = (sessionId = SESSION): string => path.join(project, `${sessionId}.jsonl`)

describe('SubagentTracker', () => {
  it('lists only the subagents still running; finished, failed and killed ones are hidden', async () => {
    subagent('aaa1', { description: 'Finished', requestShape: 'background' })
    subagent('aaa2', { description: 'Failed', requestShape: 'background' })
    subagent('aaa3', { description: 'Killed', requestShape: 'background' })
    subagent('aaa4', { description: 'Inline, failed', toolUseId: 'toolu_fg', requestShape: 'foreground' })
    subagent('aaa5', {
      agentType: 'general-purpose',
      description: 'Still going',
      requestShape: 'background',
      worktreePath: '/repo/.claude/worktrees/agent-aaa5',
      worktreeBranch: 'worktree-agent-aaa5'
    })
    transcript(main(), [
      notification('aaa1', 'completed'),
      notification('aaa2', 'failed'),
      notification('aaa3', 'killed'),
      {
        type: 'user',
        timestamp: new Date().toISOString(),
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_fg', is_error: true, content: 'boom' }] }
      }
    ])

    const subagents = tracker()
    await follow(subagents)

    expect(subagents.list('term_1')).toEqual([
      expect.objectContaining({
        id: 'aaa5',
        description: 'Still going',
        agentType: 'general-purpose',
        branch: 'worktree-agent-aaa5'
      })
    ])
    expect(changes).toEqual(['term_1'])
  })

  it('hides a nested subagent whose parent agent has ended, and keeps one whose parent it never saw', async () => {
    subagent('nnn1', { description: 'Parent', requestShape: 'background' })
    subagent('nnn2', { description: 'Child', parentAgentId: 'nnn1', requestShape: 'background' })
    subagent('nnn3', { description: 'Grandchild', parentAgentId: 'nnn2', requestShape: 'background' })
    subagent('nnn4', { description: 'Orphan', parentAgentId: 'elsewhere', requestShape: 'background' })
    transcript(main(), [notification('nnn1', 'completed')])

    const subagents = tracker()
    await follow(subagents)

    expect(subagents.list('term_1')?.map((agent) => agent.id)).toEqual(['nnn4'])
  })

  it('hides, on a resumed pane, what ended or went silent before it', async () => {
    subagent('rrr1', { description: 'Ended while away', requestShape: 'background' })
    subagent('rrr2', { description: 'Silent since', requestShape: 'background' })
    const before = tracker()
    await follow(before)
    before.hook('term_1', { event: 'SubagentStart', at: Date.now(), sessionId: SESSION, agentId: 'rrr1' })
    expect(before.list('term_1')?.map((agent) => agent.id).sort()).toEqual(['rrr1', 'rrr2'])

    transcript(main(), [notification('rrr1', 'completed')])
    // The pane's agent resumed a minute on: its files are older than it.
    const resumed = tracker(60_000)
    await follow(resumed)
    expect(resumed.list('term_1')).toBeUndefined()
  })

  it('never reads a session the pane did not run, even in the same directory', async () => {
    subagent('bbb1', { description: 'Not ours' }, undefined, ELSEWHERE)
    subagent('bbb2', { description: 'Ours' })

    const subagents = tracker()
    await follow(subagents)

    expect(subagents.list('term_1')?.map((agent) => agent.id)).toEqual(['bbb2'])
  })

  it('reads nothing for a pane with no session it knows of', async () => {
    subagent('bbb3', { description: 'Somebody else' })
    const subagents = tracker()
    await follow(subagents, null)
    expect(subagents.list('term_1')).toBeUndefined()
  })

  it('reads a session the pane’s hook reports, where the hook says its transcript is', async () => {
    const store = mkdtempSync(path.join(os.tmpdir(), 'teamree-subagents-store-'))
    try {
      const folder = path.join(store, ELSEWHERE, 'subagents')
      mkdirSync(folder, { recursive: true })
      writeFileSync(path.join(folder, 'agent-ccc1.meta.json'), JSON.stringify({ description: 'After clear' }))
      writeFileSync(path.join(folder, 'agent-ccc1.jsonl'), '')
      const subagents = tracker()
      await follow(subagents)
      subagents.noteSession('term_1', ELSEWHERE, path.join(store, `${ELSEWHERE}.jsonl`))
      await subagents.refresh('term_1')
      expect(subagents.list('term_1')).toEqual([expect.objectContaining({ id: 'ccc1' })])
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })

  it('shows a subagent the moment its start hook fires, and drops it when it stops', async () => {
    const subagents = tracker()
    await follow(subagents)
    const at = Date.now()
    subagents.hook('term_1', { event: 'SubagentStart', at, sessionId: SESSION, agentId: 'ddd1', agentType: 'Explore' })
    expect(subagents.list('term_1')).toEqual([
      { id: 'ddd1', description: 'Explore', agentType: 'Explore', startedAt: at }
    ])

    // The meta file brings the description.
    subagent('ddd1', { agentType: 'Explore', description: 'Find the sidebar', requestShape: 'background' })
    await subagents.refresh('term_1')
    expect(subagents.list('term_1')?.[0]).toMatchObject({ description: 'Find the sidebar' })

    subagents.hook('term_1', { event: 'SubagentStop', at: at + 1000, sessionId: SESSION, agentId: 'ddd1' })
    expect(subagents.list('term_1')).toBeUndefined()
  })

  it('reads only what was appended, and says when a subagent changes', async () => {
    subagent('ggg1', { description: 'Long job', requestShape: 'background' })
    transcript(main(), [{ type: 'user', message: { content: 'x'.repeat(10_000) } }])
    const subagents = tracker()
    await follow(subagents)
    expect(subagents.list('term_1')?.map((agent) => agent.id)).toEqual(['ggg1'])
    changes.length = 0

    transcript(main(), [notification('ggg1', 'killed')])
    await subagents.refresh('term_1')
    expect(subagents.list('term_1')).toBeUndefined()
    expect(changes).toEqual(['term_1'])

    changes.length = 0
    await subagents.refresh('term_1')
    expect(changes).toEqual([])
  })

  it('drops what was running once the pane’s agent is gone', async () => {
    subagent('hhh1', { description: 'Cut short', requestShape: 'background' })
    const subagents = tracker()
    await follow(subagents)
    expect(subagents.list('term_1')?.map((agent) => agent.id)).toEqual(['hhh1'])
    live = false
    await subagents.refresh('term_1')
    expect(subagents.list('term_1')).toBeUndefined()
  })

  it('forgets a pane it no longer follows', async () => {
    subagent('jjj1', { description: 'Gone with the pane' })
    const subagents = tracker()
    await follow(subagents)
    subagents.untrack('term_1')
    expect(subagents.list('term_1')).toBeUndefined()
  })

  it('reads a subagent’s transcript, and nothing for an id outside the pane', async () => {
    subagent('kkk1', { description: 'Readable' }, [
      { type: 'user', timestamp: '2026-09-26T11:00:00.000Z', message: { content: 'Find the bug' } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Looking' },
            { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }
          ]
        }
      }
    ])
    const subagents = tracker()
    await follow(subagents)
    const read = await subagents.transcript('term_1', 'kkk1')
    expect(read?.lines.map(({ kind, text }) => `${kind}: ${text}`)).toEqual([
      'prompt: Find the bug',
      'text: Looking',
      'tool: Bash npm test'
    ])
    expect(await subagents.transcript('term_1', '../kkk1')).toBeUndefined()
    expect(await subagents.transcript('term_1', 'zzz9')).toBeUndefined()
  })
})

describe('transcriptLines', () => {
  it('keeps prompts, text, tool calls and results, and skips what is not a message', () => {
    const text = [
      JSON.stringify({ type: 'attachment', attachment: {} }),
      'not json',
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'ok' }] }] }
      })
    ].join('\n')
    expect(transcriptLines(text).lines).toEqual([{ kind: 'result', text: 'ok' }])
  })
})

const describePty = canSpawnPty() ? describe : describe.skip

describePty('a restored Claude pane', () => {
  it('carries the running subagents its session started before the app did, not the finished ones', async () => {
    subagent('lll1', { agentType: 'general-purpose', description: 'Finished before the restart' })
    subagent('lll2', { agentType: 'general-purpose', description: 'Still going', requestShape: 'background' })
    transcript(main(), [notification('lll1', 'completed')])
    // Written after the restored pane's agent started.
    const later = new Date(Date.now() + 60_000)
    utimesSync(path.join(project, SESSION, 'subagents', 'agent-lll2.jsonl'), later, later)
    const checkout = mkdtempSync(path.join(os.tmpdir(), 'teamree-subagents-checkout-'))
    try {
      const launch = await writeFakeAgent(checkout)
      const record: TerminalRecord = {
        id: 'term_restored',
        worktreeId: 'wt_1',
        cwd: checkout,
        shell: '/bin/sh',
        command: `${launch} --session-id ${SESSION}`,
        agent: 'claude',
        agentSessionId: SESSION,
        typed: true,
        cols: 80,
        rows: 24,
        createdAt: Date.now()
      }
      const records = new Map([[record.id, record]])
      const sessions: SessionRepository = {
        listTerminals: () => [...records.values()],
        putTerminal: (next) => (records.set(next.id, next), next),
        removeTerminal: (id) => records.delete(id)
      }
      const manager = new TerminalSessionManager({
        resolveWorktreeCwd: () => checkout,
        sessions,
        conversationEvidence: () => 'present',
        subagents: { projectDirectory: () => project, pollMs: 0 }
      })
      try {
        manager.restoreSessions()
        await waitUntil(async () => {
          await manager.refreshSubagents()
          return manager.list()[0]?.subagents !== undefined
        }, 'the subagents to be read')
        expect(manager.list()[0]?.subagents).toEqual([
          expect.objectContaining({ id: 'lll2', description: 'Still going' })
        ])
      } finally {
        await manager.shutdown()
      }
    } finally {
      rmSync(checkout, { recursive: true, force: true })
    }
  }, 20_000)
})
