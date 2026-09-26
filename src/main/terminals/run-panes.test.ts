// Run Dev and Run Tests over real PTYs: one pane per kind, reused while it runs, stopped and
// restarted in place, and its exit code kept as the run's result.

import { afterEach, describe, expect, it } from 'vitest'
import type { Terminal } from '../../shared/entities'
import { runState } from '../../shared/runCommands'
import { createTerminalService, type TerminalService } from './method-handlers'
import { canSpawnPty, printThenExit, waitUntil } from './pty-test-support'
import { RunPanes } from './run-panes'

const describePty = canSpawnPty() ? describe : describe.skip
const TEST_TIMEOUT_MS = 20_000
const WORKTREE = 'wt_run'
// Runs until stopped; `exec` so the pane's process is the one Ctrl-C reaches.
const SERVER = 'echo serving; exec sleep 30'

const services: TerminalService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()))
})

function newRunPanes(): { runs: RunPanes; list: () => Terminal[] } {
  const service = createTerminalService({ resolveWorktreeCwd: () => process.cwd() })
  services.push(service)
  const manager = service.manager
  return {
    runs: new RunPanes({
      list: (worktreeId) => manager.list(worktreeId),
      create: (params) => manager.create(params),
      relaunch: (params, command) => manager.relaunch(params, command),
      interrupt: (terminalId) => manager.interrupt(terminalId)
    }),
    list: () => manager.list(WORKTREE)
  }
}

async function serving(terminalId: string): Promise<void> {
  const service = services[0] as TerminalService
  await waitUntil(
    async () => (await service.handlers['terminal.read']({ terminalId })).data.includes('serving'),
    'the server to start'
  )
}

const exited = (list: () => Terminal[], id: string) => (): boolean =>
  list().some((terminal) => terminal.id === id && !terminal.running)

describePty('run panes', () => {
  it(
    'opens one pane named for its kind, and answers with it again while it runs',
    async () => {
      const { runs, list } = newRunPanes()
      const first = await runs.start({ worktreeId: WORKTREE, kind: 'dev', command: SERVER, restart: false })
      expect(first).toMatchObject({ label: 'dev', run: 'dev', running: true })

      const [again, twice] = await Promise.all([
        runs.start({ worktreeId: WORKTREE, kind: 'dev', command: SERVER, restart: false }),
        runs.start({ worktreeId: WORKTREE, kind: 'dev', command: SERVER, restart: false })
      ])
      expect(again.id).toBe(first.id)
      expect(twice.id).toBe(first.id)
      expect(list()).toHaveLength(1)

      const test = await runs.start({ worktreeId: WORKTREE, kind: 'test', command: 'exit 0', restart: false })
      expect(test.id).not.toBe(first.id)
      expect(list().map((pane) => pane.run)).toEqual(['dev', 'test'])
    },
    TEST_TIMEOUT_MS
  )

  it(
    'keeps the exit code, which says passed or failed',
    async () => {
      const { runs, list } = newRunPanes()
      const pane = await runs.start({
        worktreeId: WORKTREE,
        kind: 'test',
        command: printThenExit('1 failing', 1),
        restart: false
      })
      await waitUntil(exited(list, pane.id), 'the test run to end')
      const failed = list().find((terminal) => terminal.id === pane.id) as Terminal
      expect(failed.exitCode).toBe(1)
      expect(runState(failed)).toBe('failed')

      // Pressed again once it has ended: the same pane runs it again, the command as it is now.
      const again = await runs.start({ worktreeId: WORKTREE, kind: 'test', command: 'exit 0', restart: false })
      expect(again).toMatchObject({ id: pane.id, run: 'test', running: true })
      await waitUntil(exited(list, pane.id), 'the second run to end')
      expect(runState(list().find((terminal) => terminal.id === pane.id) as Terminal)).toBe('passed')
    },
    TEST_TIMEOUT_MS
  )

  it(
    'stops a running pane and keeps it, and restarts it in place',
    async () => {
      const { runs, list } = newRunPanes()
      const pane = await runs.start({ worktreeId: WORKTREE, kind: 'dev', command: SERVER, restart: false })

      await serving(pane.id)
      const stopped = await runs.stop({ worktreeId: WORKTREE, kind: 'dev' })
      expect(stopped).toMatchObject({ id: pane.id, running: false })
      expect(runState(stopped as Terminal)).toBe('stopped')
      expect(list()).toHaveLength(1)

      const restarted = await runs.start({ worktreeId: WORKTREE, kind: 'dev', command: SERVER, restart: true })
      expect(restarted).toMatchObject({ id: pane.id, label: 'dev', run: 'dev', running: true })

      // Restart while running: stopped first, then the same pane again.
      await serving(pane.id)
      const again = await runs.start({ worktreeId: WORKTREE, kind: 'dev', command: SERVER, restart: true })
      expect(again).toMatchObject({ id: pane.id, running: true })
      expect(list()).toHaveLength(1)
      expect(await runs.stop({ worktreeId: WORKTREE, kind: 'test' })).toBeNull()
    },
    TEST_TIMEOUT_MS
  )

  it(
    'never takes a pane someone named after a kind by hand',
    async () => {
      const { runs, list } = newRunPanes()
      const service = services[0] as TerminalService
      await service.handlers['terminal.create']({ worktreeId: WORKTREE, label: 'test' })
      const pane = await runs.start({ worktreeId: WORKTREE, kind: 'test', command: 'exit 0', restart: false })
      expect(pane.run).toBe('test')
      expect(list()).toHaveLength(2)
    },
    TEST_TIMEOUT_MS
  )
})
