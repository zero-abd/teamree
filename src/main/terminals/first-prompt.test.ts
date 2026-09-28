// The task on its way to the agent, on a real pty: on the launched line, once,
// after the session id, and never on a resume, a relaunch unasked, or in the record.

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Layout } from '../../shared/entities'
import type { ConversationEvidence } from './agent-conversations'
import { canSpawnPty, waitUntil } from './pty-test-support'
import type { TerminalRecord } from './session-restore'
import { TerminalSessionManager, type LayoutRepository, type SessionRepository } from './session-manager'

const describePty = canSpawnPty() ? describe : describe.skip
const TEST_TIMEOUT_MS = 20_000
const TASK = 'Make the pager stream'

const managers: TerminalSessionManager[] = []
const scratch: string[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map((created) => created.shutdown()))
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A program named after a real agent that prints its argv, one word per line, and exits with `status`. */
async function fakeAgent(name: 'claude' | 'codex', status = 0): Promise<{ checkout: string; launch: string }> {
  const checkout = await mkdtemp(path.join(os.tmpdir(), `teamree-first-prompt-${name}-`))
  scratch.push(checkout)
  const onWindows = process.platform === 'win32'
  const binary = path.join(checkout, onWindows ? `${name}.cmd` : name)
  if (onWindows) {
    await writeFile(
      binary,
      '@echo off\r\n:loop\r\nif "%~1"=="" goto done\r\necho ARG[%~1]\r\nshift\r\ngoto loop\r\n:done\r\n',
      'utf8'
    )
  } else {
    await writeFile(binary, `#!/bin/sh\nfor arg in "$@"; do printf "ARG[%s]\\n" "$arg"; done\nexit ${status}\n`, 'utf8')
    await chmod(binary, 0o755)
  }
  return { checkout, launch: `"${binary}"` }
}

function repositories(): LayoutRepository & SessionRepository & { records: Map<string, TerminalRecord> } {
  const layouts = new Map<string, Layout>()
  const records = new Map<string, TerminalRecord>()
  return {
    records,
    getLayout: (worktreeId) => layouts.get(worktreeId),
    putLayout: (layout) => {
      layouts.set(layout.worktreeId, layout)
      return layout
    },
    listLayouts: () => [...layouts.values()],
    listTerminals: () => [...records.values()],
    putTerminal: (row) => {
      records.set(row.id, row)
      return row
    },
    removeTerminal: (terminalId) => records.delete(terminalId)
  }
}

function manager(
  stores: LayoutRepository & SessionRepository,
  checkout: string,
  evidence: ConversationEvidence,
  taskDone = false
): TerminalSessionManager {
  const created = new TerminalSessionManager({
    resolveWorktreeCwd: (worktreeId) => (worktreeId === 'wt_1' ? checkout : undefined),
    resolveWorktreeTask: (worktreeId) => (worktreeId === 'wt_1' ? TASK : undefined),
    taskDone: () => taskDone,
    conversationEvidence: () => evidence,
    layouts: stores,
    sessions: stores
  })
  managers.push(created)
  return created
}

const args = (printed: string): string[] => [...printed.matchAll(/ARG\[([^\]]*)\]/g)].map((match) => match[1] as string)

async function printedArgs(sessions: TerminalSessionManager, terminalId: string): Promise<string[]> {
  await waitUntil(() => {
    const listed = sessions.list().find((terminal) => terminal.id === terminalId)
    return listed !== undefined && !listed.running
  }, 'the agent to print its arguments and exit')
  return args(sessions.read(terminalId))
}

describePty('the task as the first prompt', () => {
  it(
    'is the last argument claude is launched with, after the session id, once',
    async () => {
      const { checkout, launch } = await fakeAgent('claude')
      const stores = repositories()
      const sessions = manager(stores, checkout, 'unknown')

      const opened = sessions.create({ worktreeId: 'wt_1', command: launch, agentArgs: '--model opus', prompt: TASK })
      const printed = await printedArgs(sessions, opened.id)

      const sessionId = stores.records.get(opened.id)?.agentSessionId
      expect(sessionId).toBeDefined()
      expect(printed).toEqual(['--model', 'opus', '--session-id', sessionId, TASK])

      // The record is what a resume is rewritten from, and a resume has already been told.
      expect(stores.records.get(opened.id)?.command).not.toContain(TASK)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'is the positional argument codex is launched with',
    async () => {
      const { checkout, launch } = await fakeAgent('codex')
      const sessions = manager(repositories(), checkout, 'unknown')

      const opened = sessions.create({ worktreeId: 'wt_1', command: launch, prompt: 'fix the login page' })
      expect(await printedArgs(sessions, opened.id)).toEqual(['fix the login page'])
    },
    TEST_TIMEOUT_MS
  )

  it(
    'is not repeated to a conversation being resumed',
    async () => {
      const { checkout, launch } = await fakeAgent('claude')
      const stores = repositories()
      const first = manager(stores, checkout, 'present')
      const opened = first.create({ worktreeId: 'wt_1', command: launch, prompt: TASK })
      await printedArgs(first, opened.id)
      await first.shutdown()
      managers.splice(managers.indexOf(first), 1)

      const next = manager(stores, checkout, 'present')
      next.restoreSessions()
      const printed = await printedArgs(next, opened.id)
      expect(printed).toContain('--resume')
      expect(printed).not.toContain(TASK)
    },
    TEST_TIMEOUT_MS
  )

  /** A first launch handed the task, quit; the stores are what a relaunch then asks. */
  async function ranOnce(
    name: 'claude' | 'codex' = 'claude',
    status = 0
  ): Promise<{ checkout: string; stores: ReturnType<typeof repositories>; terminalId: string }> {
    const { checkout, launch } = await fakeAgent(name, status)
    const stores = repositories()
    const first = manager(stores, checkout, 'absent')
    const opened = first.create({ worktreeId: 'wt_1', command: launch, prompt: TASK })
    await printedArgs(first, opened.id)
    await first.shutdown()
    managers.splice(managers.indexOf(first), 1)
    return { checkout, stores, terminalId: opened.id }
  }

  it('is written down as delivered, and not for a pane launched without it', async () => {
    const { checkout, launch } = await fakeAgent('claude')
    const stores = repositories()
    const sessions = manager(stores, checkout, 'absent')
    const told = sessions.create({ worktreeId: 'wt_1', command: launch, prompt: TASK })
    const bare = sessions.create({ worktreeId: 'wt_1', command: launch })
    expect(stores.records.get(told.id)?.prompted).toBe(true)
    expect(stores.records.get(bare.id)?.prompted).toBeUndefined()
  })

  it(
    'is not given again after a relaunch with no conversation behind it: the pane comes back stopped',
    async () => {
      const { checkout, stores, terminalId } = await ranOnce()

      const next = manager(stores, checkout, 'absent')
      expect(next.restoreSessions()).toEqual({ restored: 1, resumed: 0 })
      const printed = await printedArgs(next, terminalId)

      expect(printed).toEqual([])
      // The end block says why, once; the record says nothing about it.
      expect(next.read(terminalId)).not.toContain('not resumed')
      const pane = next.list('wt_1')[0]
      expect(pane?.restored).toBe('stopped')
      expect(pane?.stoppedFor).toBe('no-conversation')
      expect(pane?.resumable).toBeUndefined()
      expect(pane?.agent).toBe('claude')
      expect(pane?.title).toBe('claude')
      // Still the agent's pane: the next launch asks the same question.
      expect(stores.records.get(terminalId)?.command).toContain('--session-id')
      expect(stores.records.get(terminalId)?.prompted).toBe(true)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'is not given to a done task, whose agent comes back stopped though its conversation is there',
    async () => {
      const { checkout, stores, terminalId } = await ranOnce()

      const next = manager(stores, checkout, 'present', true)
      expect(next.restoreSessions()).toEqual({ restored: 1, resumed: 0 })

      expect(await printedArgs(next, terminalId)).toEqual([])
      expect(next.read(terminalId)).not.toContain('not resumed')
      const pane = next.list('wt_1')[0]
      expect(pane?.restored).toBe('stopped')
      expect(pane?.stoppedFor).toBe('task-done')
      // Its Resume would start the agent afresh, so it offers none.
      expect(pane?.resumable).toBeUndefined()
    },
    TEST_TIMEOUT_MS
  )

  it(
    'is not given to an agent that failed before the quit, which comes back failed and resumes its conversation',
    async () => {
      const { checkout, stores, terminalId } = await ranOnce('claude', 3)
      expect(stores.records.get(terminalId)?.exitCode).toBe(3)

      const next = manager(stores, checkout, 'present')
      expect(next.restoreSessions()).toEqual({ restored: 1, resumed: 0 })
      expect(await printedArgs(next, terminalId)).toEqual([])
      const pane = next.list('wt_1')[0]
      expect(pane).toMatchObject({ restored: 'stopped', stoppedFor: 'failed', exitCode: 3, resumable: true })

      // Its Resume picks the conversation up, and the task is not sent again.
      await next.relaunch({ terminalId })
      const printed = await printedArgs(next, terminalId)
      expect(printed).toContain('--resume')
      expect(printed).not.toContain(TASK)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'says an ended agent with no conversation behind it cannot be resumed, and one with it can',
    async () => {
      const { checkout, launch } = await fakeAgent('claude', 1)
      const without = manager(repositories(), checkout, 'absent')
      const lost = without.create({ worktreeId: 'wt_1', command: launch })
      await printedArgs(without, lost.id)
      expect(without.list('wt_1')[0]).toMatchObject({ exitCode: 1 })
      expect(without.list('wt_1')[0]?.resumable).toBeUndefined()
      // Resume All's relaunch starts nothing in its place.
      await expect(without.relaunch({ terminalId: lost.id, resumeOnly: true })).rejects.toThrow('nothing to resume')
      expect(without.list('wt_1')[0]?.running).toBe(false)

      const kept = manager(repositories(), checkout, 'present')
      const had = kept.create({ worktreeId: 'wt_1', command: launch, prompt: TASK })
      await printedArgs(kept, had.id)
      expect(kept.list('wt_1')[0]?.resumable).toBe(true)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'is not given by Start Fresh, only when the task is asked for',
    async () => {
      const { checkout, stores, terminalId } = await ranOnce()
      const next = manager(stores, checkout, 'absent')
      next.restoreSessions()
      await printedArgs(next, terminalId)

      await next.relaunch({ terminalId })
      const fresh = await printedArgs(next, terminalId)
      expect(fresh).toContain('--session-id')
      expect(fresh).not.toContain(TASK)
      expect(stores.records.get(terminalId)?.prompted).toBeUndefined()

      await next.relaunch({ terminalId, task: true })
      const asked = (await printedArgs(next, terminalId)).slice(fresh.length)
      expect(asked.filter((arg) => arg === TASK)).toHaveLength(1)
      expect(asked.indexOf('--session-id')).toBeLessThan(asked.indexOf(TASK))
      expect(stores.records.get(terminalId)?.prompted).toBe(true)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'is not given to a conversation resumed in the pane',
    async () => {
      const { checkout, stores, terminalId } = await ranOnce()
      const next = manager(stores, checkout, 'absent')
      next.restoreSessions()
      await printedArgs(next, terminalId)

      const chosen = '0b0e1d7c-5f63-4a55-9d59-8c1f3e2a7b10'
      await next.relaunch({ terminalId, resume: chosen })
      const printed = await printedArgs(next, terminalId)
      expect(printed).toEqual(['--resume', chosen])
      expect(stores.records.get(terminalId)?.agentSessionId).toBe(chosen)
    },
    TEST_TIMEOUT_MS
  )
})
