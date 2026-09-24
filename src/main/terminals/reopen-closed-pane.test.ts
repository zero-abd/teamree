// Reopening a closed pane on a real pty: the agent comes back resuming the session it was pinned
// to, under its old id and number, where it sat. The agent is a stand-in that writes down its argv.

import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Layout } from '../../shared/entities'
import { canSpawnPty, waitUntil } from './pty-test-support'
import type { ClosedTerminalRecord, TerminalRecord } from './session-restore'
import {
  CLOSED_PANES_KEPT,
  TerminalSessionManager,
  type LayoutRepository,
  type SessionRepository
} from './session-manager'

const describePty = canSpawnPty() && process.platform !== 'win32' ? describe : describe.skip
const TEST_TIMEOUT_MS = 20_000

const managers: TerminalSessionManager[] = []
const scratch: string[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map((created) => created.shutdown()))
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A checkout holding a program called `claude` that appends each argv it is started with to `argv.log`. */
async function checkoutWithAgent(): Promise<{ checkout: string; launch: string; argv: () => Promise<string[]> }> {
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'teamree-reopen-'))
  scratch.push(checkout)
  const log = path.join(checkout, 'argv.log')
  const binary = path.join(checkout, 'claude')
  await writeFile(binary, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\necho started\nsleep 30\n`, 'utf8')
  await chmod(binary, 0o755)
  const argv = async (): Promise<string[]> =>
    (await readFile(log, 'utf8').catch(() => '')).split('\n').filter((line) => line.length > 0)
  return { checkout, launch: `"${binary}"`, argv }
}

function repositories(): LayoutRepository & SessionRepository {
  const layouts = new Map<string, Layout>()
  const records = new Map<string, TerminalRecord>()
  let closed: ClosedTerminalRecord[] = []
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
    removeTerminal: (terminalId) => records.delete(terminalId),
    listClosedTerminals: () => closed,
    setClosedTerminals: (next) => {
      closed = next
    }
  }
}

function manager(stores: LayoutRepository & SessionRepository, checkout: string): TerminalSessionManager {
  const created = new TerminalSessionManager({
    resolveWorktreeCwd: (worktreeId) => (worktreeId === 'wt_1' ? checkout : undefined),
    layouts: stores,
    sessions: stores,
    // The stand-in keeps no conversations; the store would be asked on a real machine.
    conversationEvidence: () => 'present'
  })
  managers.push(created)
  return created
}

describePty('reopening a closed pane', () => {
  it(
    'resumes the agent by its pinned session id, under its old id and number, where it was',
    async () => {
      const { checkout, launch, argv } = await checkoutWithAgent()
      const stores = repositories()
      const sessions = manager(stores, checkout)
      const shell = sessions.create({ worktreeId: 'wt_1', cwd: checkout })
      const agent = sessions.create({ worktreeId: 'wt_1', command: launch, label: 'Add a sub function' })
      await waitUntil(async () => (await argv()).length === 1, 'the agent to start')
      const pinned = stores.listTerminals().find((record) => record.id === agent.id)?.agentSessionId
      expect(pinned).toBeDefined()
      const before = stores.getLayout('wt_1')?.root

      await sessions.close(agent.id)
      expect(sessions.closedPanes('wt_1')).toMatchObject([
        { terminalId: agent.id, agent: 'claude', label: 'Add a sub function', ordinal: agent.ordinal, resumable: true }
      ])

      // A relaunch in between: the closed pane is read back from the store.
      await sessions.shutdown()
      const relaunched = manager(stores, checkout)
      relaunched.restoreSessions()
      const reopened = relaunched.reopen({ worktreeId: 'wt_1' })

      expect(reopened).toMatchObject({ id: agent.id, label: 'Add a sub function', ordinal: agent.ordinal })
      await waitUntil(async () => (await argv()).length === 2, 'the agent to start again')
      expect((await argv())[1]).toContain(`--resume ${pinned as string}`)
      expect(relaunched.layoutGet('wt_1').root).toEqual(before)
      expect(relaunched.list().map((terminal) => terminal.id)).toEqual([shell.id, agent.id])
      expect(relaunched.closedPanes('wt_1')).toEqual([])
    },
    TEST_TIMEOUT_MS
  )

  it(
    'puts a shell back in its directory on the side it was on',
    async () => {
      const { checkout } = await checkoutWithAgent()
      const sessions = manager(repositories(), checkout)
      const left = sessions.create({ worktreeId: 'wt_1', cwd: checkout })
      const right = sessions.create({ worktreeId: 'wt_1', cwd: checkout })
      const before = sessions.layoutGet('wt_1').root

      await sessions.close(left.id)
      const reopened = sessions.reopen({ worktreeId: 'wt_1', terminalId: left.id })

      expect(reopened).toMatchObject({ id: left.id, cwd: checkout, ordinal: left.ordinal })
      expect(sessions.layoutGet('wt_1').root).toEqual(before)
      expect(right.ordinal).not.toBe(left.ordinal)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'keeps the last few closed panes of a worktree, newest first',
    async () => {
      const { checkout } = await checkoutWithAgent()
      const sessions = manager(repositories(), checkout)
      const opened = []
      for (let index = 0; index < CLOSED_PANES_KEPT + 2; index++) {
        opened.push(sessions.create({ worktreeId: 'wt_1', cwd: checkout }))
      }
      for (const terminal of opened) await sessions.close(terminal.id)

      const closed = sessions.closedPanes('wt_1')
      expect(closed).toHaveLength(CLOSED_PANES_KEPT)
      expect(closed[0]?.terminalId).toBe(opened.at(-1)?.id)
      expect(() => sessions.reopen({ worktreeId: 'wt_2' })).toThrow(/no closed pane/)
    },
    TEST_TIMEOUT_MS
  )
})
