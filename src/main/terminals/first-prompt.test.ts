// The task on its way to the agent, on a real pty: on the launched line, once,
// after the session id, and never on a resume or in the record.

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

/** A program named after a real agent that prints its argv, one word per line, and exits. */
async function fakeAgent(name: 'claude' | 'codex'): Promise<{ checkout: string; launch: string }> {
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
    await writeFile(binary, '#!/bin/sh\nfor arg in "$@"; do printf "ARG[%s]\\n" "$arg"; done\n', 'utf8')
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
  evidence: ConversationEvidence
): TerminalSessionManager {
  const created = new TerminalSessionManager({
    resolveWorktreeCwd: (worktreeId) => (worktreeId === 'wt_1' ? checkout : undefined),
    resolveWorktreeTask: (worktreeId) => (worktreeId === 'wt_1' ? TASK : undefined),
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

  it(
    'is given again to a pane starting over with no conversation behind it',
    async () => {
      const { checkout, launch } = await fakeAgent('claude')
      const stores = repositories()
      const first = manager(stores, checkout, 'absent')
      const opened = first.create({ worktreeId: 'wt_1', command: launch, prompt: TASK })
      await printedArgs(first, opened.id)
      await first.shutdown()
      managers.splice(managers.indexOf(first), 1)

      const next = manager(stores, checkout, 'absent')
      next.restoreSessions()
      const printed = await printedArgs(next, opened.id)
      expect(printed).toContain('--session-id')
      expect(printed.filter((arg) => arg === TASK)).toHaveLength(1)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'is given again by relaunch to a pane nobody ever spoke to, and not to one somebody did',
    async () => {
      const { checkout, launch } = await fakeAgent('claude')

      // Only the arguments printed after the first run's are the relaunch's.
      const untouched = manager(repositories(), checkout, 'absent')
      const quiet = untouched.create({ worktreeId: 'wt_1', command: launch, prompt: TASK })
      const before = await printedArgs(untouched, quiet.id)
      await untouched.relaunch({ terminalId: quiet.id })
      const again = (await printedArgs(untouched, quiet.id)).slice(before.length)
      expect(again.filter((arg) => arg === TASK)).toHaveLength(1)
      expect(again.indexOf('--session-id')).toBeLessThan(again.indexOf(TASK))

      const spoken = manager(repositories(), checkout, 'present')
      const talked = spoken.create({ worktreeId: 'wt_1', command: launch, prompt: TASK })
      const said = await printedArgs(spoken, talked.id)
      await spoken.relaunch({ terminalId: talked.id })
      expect((await printedArgs(spoken, talked.id)).slice(said.length)).not.toContain(TASK)
    },
    TEST_TIMEOUT_MS
  )
})
