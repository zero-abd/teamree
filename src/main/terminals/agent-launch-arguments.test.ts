// The flags a person always passes their agent, on a real pty: they go on
// before `agent-command.ts` rewrites the line, and they are the likeliest thing
// to break its tokenizer, so fail-open is asserted rather than assumed.

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Layout } from '../../shared/entities'
import { canSpawnPty, waitUntil } from './pty-test-support'
import type { TerminalRecord } from './session-restore'
import { TerminalSessionManager, type LayoutRepository, type SessionRepository } from './session-manager'

const describePty = canSpawnPty() ? describe : describe.skip
const TEST_TIMEOUT_MS = 20_000

const managers: TerminalSessionManager[] = []
const scratch: string[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map((created) => created.shutdown()))
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A program called `claude` that prints its arguments; the rewriting only happens for a known name. */
async function fakeAgent(): Promise<{ checkout: string; launch: string }> {
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'teamree-agent-args-'))
  scratch.push(checkout)
  const onWindows = process.platform === 'win32'
  const binary = path.join(checkout, onWindows ? 'claude.cmd' : 'claude')
  if (onWindows) {
    await writeFile(binary, '@echo off\r\necho AGENT ARGS: %*\r\n', 'utf8')
  } else {
    await writeFile(binary, '#!/bin/sh\necho "AGENT ARGS: $@"\n', 'utf8')
    await chmod(binary, 0o755)
  }
  return { checkout, launch: `"${binary}"` }
}

function createRepositories(): LayoutRepository & SessionRepository {
  const layouts = new Map<string, Layout>()
  const records = new Map<string, TerminalRecord>()
  return {
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

function manager(repositories: LayoutRepository & SessionRepository, checkout: string): TerminalSessionManager {
  const created = new TerminalSessionManager({
    resolveWorktreeCwd: (worktreeId) => (worktreeId === 'wt_1' ? checkout : undefined),
    layouts: repositories,
    sessions: repositories
  })
  managers.push(created)
  return created
}

describePty('the arguments a person always passes', () => {
  it(
    'puts them on the line the agent is launched with, ahead of the session id',
    async () => {
      const { checkout, launch } = await fakeAgent()
      const repositories = createRepositories()
      const sessions = manager(repositories, checkout)

      const opened = sessions.create({ worktreeId: 'wt_1', command: launch, agentArgs: '--model opus' })
      await waitUntil(() => sessions.read(opened.id).includes('AGENT ARGS:'), 'the agent to print its arguments')

      const printed = sessions.read(opened.id)
      expect(printed).toContain('--model opus')
      // The session id goes last, where it cannot come between a flag and its value.
      expect(printed.indexOf('--model opus')).toBeLessThan(printed.indexOf('--session-id'))

      const sessionId = repositories.listTerminals()[0]?.agentSessionId
      expect(sessionId).toBeDefined()
      expect(printed).toContain(sessionId as string)
    },
    TEST_TIMEOUT_MS
  )

  // A selector appended after `--` would be two more words of prompt, and the
  // rewriter can only splice in front of a terminator it can see.
  it(
    'lets the rewriter see a terminator in them, and put the session id in front of it',
    async () => {
      const { checkout, launch } = await fakeAgent()
      const sessions = manager(createRepositories(), checkout)

      const opened = sessions.create({
        worktreeId: 'wt_1',
        command: launch,
        agentArgs: '-- write the release notes'
      })
      await waitUntil(() => sessions.read(opened.id).includes('AGENT ARGS:'), 'the agent to print its arguments')

      const printed = sessions.read(opened.id)
      expect(printed).toContain('-- write the release notes')
      expect(printed.indexOf('--session-id')).toBeLessThan(printed.indexOf('-- write the release notes'))
    },
    TEST_TIMEOUT_MS
  )

  // A pipeline is a command this app will not take apart; the pane still runs.
  it(
    'leaves a pipeline alone, and still launches it',
    async () => {
      const { checkout, launch } = await fakeAgent()
      const repositories = createRepositories()
      const sessions = manager(repositories, checkout)

      const opened = sessions.create({ worktreeId: 'wt_1', command: launch, agentArgs: '--model opus | cat' })
      await waitUntil(() => sessions.read(opened.id).includes('AGENT ARGS:'), 'the agent to print its arguments')

      const printed = sessions.read(opened.id)
      expect(printed).toContain('--model opus')
      expect(printed).not.toContain('--session-id')

      const stored = repositories.listTerminals()[0]
      expect(stored?.command).toBe(`${launch} --model opus | cat`)
      // No agent recorded: a line this app cannot model is one it cannot promise to resume.
      expect(stored?.agent).toBeUndefined()
      expect(stored?.agentSessionId).toBeUndefined()
    },
    TEST_TIMEOUT_MS
  )

  // The shell reports the unclosed quote; the line it reports must be the line
  // they wrote, so this asserts the command, not the output.
  it(
    'leaves an unterminated quote exactly as it was typed',
    async () => {
      const { checkout, launch } = await fakeAgent()
      const repositories = createRepositories()
      const sessions = manager(repositories, checkout)

      const opened = sessions.create({
        worktreeId: 'wt_1',
        command: launch,
        agentArgs: "--append-system-prompt 'be terse"
      })

      const stored = repositories.listTerminals().find((row) => row.id === opened.id)
      expect(stored?.command).toBe(`${launch} --append-system-prompt 'be terse`)
      expect(stored?.agentSessionId).toBeUndefined()
    },
    TEST_TIMEOUT_MS
  )

  it(
    'changes nothing about a pane opened without any',
    async () => {
      const { checkout, launch } = await fakeAgent()
      const repositories = createRepositories()
      const sessions = manager(repositories, checkout)

      const opened = sessions.create({ worktreeId: 'wt_1', command: launch })
      await waitUntil(() => sessions.read(opened.id).includes('AGENT ARGS:'), 'the agent to print its arguments')

      expect(sessions.read(opened.id)).toContain('--session-id')
      expect(repositories.listTerminals().find((row) => row.id === opened.id)?.command).toContain(launch)
    },
    TEST_TIMEOUT_MS
  )
})
