import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Layout } from '../../shared/entities'
import { canSpawnPty, waitUntil } from './pty-test-support'
import { restorableRecords, restoreLaunch, type TerminalRecord } from './session-restore'
import { TerminalSessionManager, type LayoutRepository, type SessionRepository } from './session-manager'

function record(overrides: Partial<TerminalRecord> = {}): TerminalRecord {
  return {
    id: 'term_1',
    worktreeId: 'wt_1',
    cwd: '/checkouts/wt_1',
    shell: '/bin/sh',
    cols: 80,
    rows: 24,
    createdAt: 0,
    ...overrides
  }
}

describe('restoreLaunch', () => {
  it('resumes an agent by the id that was pinned for it', () => {
    expect(restoreLaunch(record({ command: 'claude', agent: 'claude', agentSessionId: 'abc' }))).toEqual({
      command: 'claude --resume abc',
      resumed: true
    })
  })

  it('asks for the latest session here when no id was ever captured', () => {
    expect(restoreLaunch(record({ command: 'codex', agent: 'codex' }))).toEqual({
      command: 'codex resume --last',
      resumed: true
    })
  })

  // The refusal that matters. A pane left running a deploy, a migration, or a
  // test suite that writes fixtures is not something to re-run because the app
  // restarted: the user quit, they did not ask for it a second time.
  it('never re-runs an ordinary command, however it was left', () => {
    for (const command of ['npm run deploy', 'psql -f migrate.sql', 'npm test', 'rm -rf build']) {
      expect(restoreLaunch(record({ command })), command).toEqual({ resumed: false })
    }
  })

  it('opens a plain shell for a pane that never had a command', () => {
    expect(restoreLaunch(record())).toEqual({ resumed: false })
  })

  it('opens a plain shell when the agent offers no way back at all', () => {
    // Recorded as an agent, but this one can neither resume an id nor find the
    // last session, so there is nothing honest to re-issue.
    expect(restoreLaunch(record({ command: 'gemini', agent: 'gemini' }))).toEqual({ resumed: false })
  })
})

describe('restorableRecords', () => {
  it('leaves behind terminals whose worktree is gone', () => {
    const rows = restorableRecords(
      [record({ id: 'a', worktreeId: 'live' }), record({ id: 'b', worktreeId: 'deleted' })],
      (worktreeId) => worktreeId === 'live'
    )

    expect(rows.map((row) => row.id)).toEqual(['a'])
  })

  it('restores oldest first, so panes come back in the order they were opened', () => {
    const rows = restorableRecords(
      [record({ id: 'c', createdAt: 30 }), record({ id: 'a', createdAt: 10 }), record({ id: 'b', createdAt: 20 })],
      () => true
    )

    expect(rows.map((row) => row.id)).toEqual(['a', 'b', 'c'])
  })
})

/** Layouts and records in memory, standing in for the workspace store. */
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

const describePty = canSpawnPty() ? describe : describe.skip

describePty('restoring terminals across a restart', () => {
  const created: string[] = []
  const managers: TerminalSessionManager[] = []

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.shutdown()))
    await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  /**
   * A stand-in agent that prints the arguments it was given. The real thing is
   * not installed anywhere this suite runs, and what is under test is which
   * command line gets built — which this shows directly.
   */
  async function fakeAgent(name: string): Promise<{ checkout: string; binary: string }> {
    const base = await mkdtemp(path.join(os.tmpdir(), 'teamree-restore-'))
    created.push(base)
    const checkout = path.join(base, 'checkout')
    const bin = path.join(base, 'bin')
    await mkdir(checkout, { recursive: true })
    await mkdir(bin, { recursive: true })
    const binary = path.join(bin, name)
    await writeFile(binary, '#!/bin/sh\necho "AGENT ARGS: $@"\n', 'utf8')
    await chmod(binary, 0o755)
    return { checkout, binary }
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

  it('gives an agent a session id, then hands the same id back after a restart', async () => {
    const { checkout, binary } = await fakeAgent('claude')
    const repositories = createRepositories()

    const first = manager(repositories, checkout)
    const opened = first.create({ worktreeId: 'wt_1', command: binary })
    await waitUntil(() => first.read(opened.id).includes('AGENT ARGS:'), 'the agent to print its arguments')

    const launched = first.read(opened.id)
    expect(launched).toContain('--session-id')
    const sessionId = repositories.listTerminals()[0]?.agentSessionId
    expect(sessionId).toBeDefined()
    expect(launched).toContain(sessionId as string)

    // The app quits. Every PTY dies with it; the records do not.
    await first.shutdown()

    const second = manager(repositories, checkout)
    const outcome = second.restoreSessions()
    expect(outcome).toEqual({ restored: 1, resumed: 1 })

    // The same terminal id, so the stored pane tree still points at it.
    const restored = second.list('wt_1')
    expect(restored).toHaveLength(1)
    expect(restored[0]?.id).toBe(opened.id)

    await waitUntil(() => second.read(opened.id).includes('AGENT ARGS:'), 'the resumed agent to print its arguments')
    const resumedLine = second.read(opened.id)
    expect(resumedLine).toContain('--resume')
    expect(resumedLine).toContain(sessionId as string)
    // The pinning flag must not ride along a second time: two selectors and
    // the CLI picks, which is exactly the ambiguity this avoids.
    expect(resumedLine).not.toContain('--session-id')
  }, 20_000)

  it('brings an ordinary pane back as a shell rather than running its command again', async () => {
    const { checkout } = await fakeAgent('unused')
    const marker = path.join(checkout, 'ran.txt')
    const repositories = createRepositories()

    const first = manager(repositories, checkout)
    const opened = first.create({ worktreeId: 'wt_1', command: `echo once >> ${marker}` })
    await waitUntil(
      () => first.list('wt_1').some((terminal) => terminal.id === opened.id && !terminal.running),
      'the command to finish'
    )
    await first.shutdown()

    const second = manager(repositories, checkout)
    expect(second.restoreSessions()).toEqual({ restored: 1, resumed: 0 })

    // The pane is back, in the right directory, and the command did not run
    // a second time — the file it appends to still has one line.
    const restored = second.list('wt_1')
    expect(restored[0]?.id).toBe(opened.id)
    expect(restored[0]?.cwd).toBe(checkout)
    const { readFile } = await import('node:fs/promises')
    expect((await readFile(marker, 'utf8')).trim().split('\n')).toEqual(['once'])
  }, 20_000)

  it('says how each pane got here, and stops saying it once the user types', async () => {
    const { checkout, binary } = await fakeAgent('claude')
    const repositories = createRepositories()

    const first = manager(repositories, checkout)
    const agentPane = first.create({ worktreeId: 'wt_1', command: binary })
    const plainPane = first.create({ worktreeId: 'wt_1', command: 'echo hello' })
    // A pane opened now is not a restored one, whatever else is true of it.
    expect(first.list('wt_1').every((terminal) => terminal.restored === undefined)).toBe(true)
    await first.shutdown()

    const second = manager(repositories, checkout)
    second.restoreSessions()

    const byId = new Map(second.list('wt_1').map((terminal) => [terminal.id, terminal]))
    expect(byId.get(agentPane.id)?.restored).toBe('agent')
    // The command was not re-run, so this one is honest about being new.
    expect(byId.get(plainPane.id)?.restored).toBe('shell')

    // Typing is the user taking the pane over, and the write says so, which is
    // what lets the change stream retire the badge.
    expect(second.write(agentPane.id, 'x')).toBe(true)
    expect(second.list('wt_1').find((terminal) => terminal.id === agentPane.id)?.restored).toBeUndefined()
    // A second keystroke has nothing left to announce.
    expect(second.write(agentPane.id, 'y')).toBe(false)
  }, 20_000)

  it('forgets a pane the user closed, so a restart does not reopen it', async () => {
    const { checkout, binary } = await fakeAgent('claude')
    const repositories = createRepositories()

    const first = manager(repositories, checkout)
    const opened = first.create({ worktreeId: 'wt_1', command: binary })
    await first.close(opened.id)
    expect(repositories.listTerminals()).toEqual([])
    await first.shutdown()

    const second = manager(repositories, checkout)
    expect(second.restoreSessions()).toEqual({ restored: 0, resumed: 0 })
    expect(second.list('wt_1')).toEqual([])
  }, 20_000)

  it('leaves behind a terminal whose worktree is no longer there', async () => {
    const { checkout, binary } = await fakeAgent('claude')
    const repositories = createRepositories()

    const first = manager(repositories, checkout)
    first.create({ worktreeId: 'wt_1', command: binary })
    await first.shutdown()

    // A manager that knows nothing about wt_1: the worktree was removed while
    // the app was closed.
    const second = new TerminalSessionManager({
      resolveWorktreeCwd: () => undefined,
      layouts: repositories,
      sessions: repositories
    })
    managers.push(second)

    expect(second.restoreSessions()).toEqual({ restored: 0, resumed: 0 })
  }, 20_000)
})
