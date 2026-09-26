// A pane started on a past conversation, on a real pty: stand-ins named after
// the agents print the arguments they were given, and the record keeps the id.

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Layout } from '../../shared/entities'
import { canSpawnPty, waitUntil } from './pty-test-support'
import type { TerminalRecord } from './session-restore'
import { TerminalSessionManager, type LayoutRepository, type SessionRepository } from './session-manager'

const describePty = canSpawnPty() && process.platform !== 'win32' ? describe : describe.skip
const TEST_TIMEOUT_MS = 20_000

const managers: TerminalSessionManager[] = []
const scratch: string[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map((created) => created.shutdown()))
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A stand-in for `name` that prints its arguments and exits. */
async function standIn(name: 'claude' | 'codex'): Promise<{ checkout: string; launch: string }> {
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'teamree-resume-'))
  scratch.push(checkout)
  const binary = path.join(checkout, name)
  await writeFile(binary, '#!/bin/sh\necho "AGENT ARGS: $@"\n', 'utf8')
  await chmod(binary, 0o755)
  return { checkout, launch: `"${binary}"` }
}

function setUp(checkout: string): { sessions: TerminalSessionManager; records: () => TerminalRecord[] } {
  const layouts = new Map<string, Layout>()
  const records = new Map<string, TerminalRecord>()
  const repositories: LayoutRepository & SessionRepository = {
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
  const sessions = new TerminalSessionManager({
    resolveWorktreeCwd: (worktreeId) => (worktreeId === 'wt_1' ? checkout : undefined),
    layouts: repositories,
    sessions: repositories
  })
  managers.push(sessions)
  return { sessions, records: () => [...records.values()] }
}

async function printedArgs(sessions: TerminalSessionManager, terminalId: string): Promise<string> {
  await waitUntil(() => sessions.read(terminalId).includes('AGENT ARGS:'), 'the stand-in to print its arguments')
  const printed = sessions.read(terminalId)
  return printed.slice(printed.indexOf('AGENT ARGS:')).split(/\r?\n/)[0] ?? ''
}

describePty('resuming a chosen conversation', () => {
  it(
    'starts Claude Code with --resume and that id, after the arguments the owner always passes',
    async () => {
      const { checkout, launch } = await standIn('claude')
      const { sessions, records } = setUp(checkout)

      const opened = sessions.create({ worktreeId: 'wt_1', command: launch, agentArgs: '--model opus', resume: 'c-42' })
      const args = await printedArgs(sessions, opened.id)

      expect(args).toBe('AGENT ARGS: --model opus --resume c-42')
      expect(args).not.toContain('--session-id')
      // Kept as the pane's session, so a restart resumes this one conversation again.
      expect(records()[0]).toMatchObject({ agent: 'claude', agentSessionId: 'c-42' })
    },
    TEST_TIMEOUT_MS
  )

  it(
    'starts Codex with resume and that id',
    async () => {
      const { checkout, launch } = await standIn('codex')
      const { sessions, records } = setUp(checkout)

      const opened = sessions.create({ worktreeId: 'wt_1', command: launch, resume: 'x-7' })

      expect(await printedArgs(sessions, opened.id)).toBe('AGENT ARGS: resume x-7')
      expect(records()[0]).toMatchObject({ agent: 'codex', agentSessionId: 'x-7' })
    },
    TEST_TIMEOUT_MS
  )

  it('refuses a resume for a command that runs no agent it can resume', async () => {
    const { checkout } = await standIn('claude')
    const { sessions } = setUp(checkout)
    expect(() => sessions.create({ worktreeId: 'wt_1', command: 'npm test', resume: 'c-42' })).toThrow(/resume/)
  })
})
