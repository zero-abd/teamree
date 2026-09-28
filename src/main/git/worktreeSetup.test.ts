// What "runs in a pane and ends" means: the contract with the terminal service (one `setup` run pane
// running the command itself) against a double, and a real pty proving a pass closes the pane and a failure keeps it.

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Terminal } from '../../shared/entities'
import { createTerminalService, type TerminalService } from '../terminals/method-handlers'
import { canSpawnPty, waitUntil } from '../terminals/pty-test-support'
import { closePassedSetups, normalizeSetupCommand, SETUP_PANE_LABEL, startSetupCommand } from './worktreeSetup'

const describePty = canSpawnPty() ? describe : describe.skip
const TEST_TIMEOUT_MS = 20_000

const services: TerminalService[] = []
const scratchDirs: string[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()))
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

type SetupPanes = Parameters<typeof startSetupCommand>[0]

/** A pane opener that records rather than forking anything. */
function recorder(): { panes: SetupPanes; opened: Array<Parameters<SetupPanes['create']>[0]> } {
  const opened: Array<Parameters<SetupPanes['create']>[0]> = []
  return {
    opened,
    panes: {
      create: (params) => {
        opened.push(params)
        return { id: 't_setup', worktreeId: params.worktreeId, label: params.label } as unknown as Terminal
      }
    }
  }
}

/** Panes that exit when told to, and a record of what was closed. */
function exiting(terminals: Array<Pick<Terminal, 'id' | 'run'>>) {
  const listeners = new Set<(terminalId: string, exitCode: number) => void>()
  const closed: string[] = []
  return {
    closed,
    panes: {
      list: () => terminals as Terminal[],
      close: async (terminalId: string) => {
        closed.push(terminalId)
      },
      onTerminalExit: (listener: (terminalId: string, exitCode: number) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    },
    exit: (terminalId: string, exitCode: number) => {
      for (const listener of listeners) listener(terminalId, exitCode)
    }
  }
}

describe('starting a setup command', () => {
  it('opens one run pane of the worktree, labelled setup, running the command rather than typing it into a shell', () => {
    const { panes, opened } = recorder()

    const terminal = startSetupCommand(panes, { worktreeId: 'wt_1', command: 'npm ci && npm run build # go' })

    expect(opened).toEqual([
      { worktreeId: 'wt_1', label: SETUP_PANE_LABEL, command: 'npm ci && npm run build # go', run: 'setup' }
    ])
    expect(SETUP_PANE_LABEL).toBe('setup')
    expect(terminal.id).toBe('t_setup')
  })

  it('reads a blank command as no command, and keeps everything between the ends', () => {
    expect(normalizeSetupCommand('   ')).toBeUndefined()
    expect(normalizeSetupCommand('')).toBeUndefined()
    expect(normalizeSetupCommand('  npm ci  ')).toBe('npm ci')
    expect(normalizeSetupCommand('npm ci && npm test')).toBe('npm ci && npm test')
  })
})

describe('closing a setup that passed', () => {
  it('closes a setup pane that exits 0 and keeps one that fails', async () => {
    const { panes, closed, exit } = exiting([
      { id: 't_ok', run: 'setup' },
      { id: 't_bad', run: 'setup' }
    ])
    const announced: string[] = []
    closePassedSetups(panes, (pane) => announced.push(pane.id))

    exit('t_bad', 127)
    exit('t_ok', 0)
    await Promise.resolve()

    expect(closed).toEqual(['t_ok'])
    expect(announced).toEqual(['t_ok'])
  })

  it('leaves every other pane that exits 0 where it is', () => {
    const { panes, closed, exit } = exiting([{ id: 't_tests', run: 'test' }, { id: 't_shell' }])
    closePassedSetups(panes)

    exit('t_tests', 0)
    exit('t_shell', 0)

    expect(closed).toEqual([])
  })
})

describePty('a setup pane on a real pty', () => {
  it(
    'runs the command in the worktree and closes the pane once it passes, kept among the closed panes',
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'teamree-setup-pane-'))
      scratchDirs.push(dir)
      const service = createTerminalService({ resolveWorktreeCwd: (id) => (id === 'wt_1' ? dir : undefined) })
      services.push(service)
      closePassedSetups(service.manager)

      // Written with no path, so the file can only land in `dir` if the command ran there.
      const pane = startSetupCommand(service.manager, { worktreeId: 'wt_1', command: 'echo SETUP-RAN > setup.txt' })
      expect(pane).toMatchObject({ label: SETUP_PANE_LABEL, run: 'setup' })

      await waitUntil(() => existsSync(path.join(dir, 'setup.txt')), 'the setup command to write its file')
      await waitUntil(() => service.manager.list('wt_1').length === 0, 'the passed setup pane to close')
      // With its exit on the record: a window that missed the exit event still reads a pass, not a close.
      expect(service.manager.closedPanes('wt_1')).toEqual([
        expect.objectContaining({ terminalId: pane.id, exitCode: 0 })
      ])
    },
    TEST_TIMEOUT_MS
  )

  it(
    'keeps a failed setup pane, ended with its exit code',
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'teamree-setup-pane-'))
      scratchDirs.push(dir)
      const service = createTerminalService({ resolveWorktreeCwd: (id) => (id === 'wt_1' ? dir : undefined) })
      services.push(service)
      closePassedSetups(service.manager)

      startSetupCommand(service.manager, { worktreeId: 'wt_1', command: 'exit 3' })

      await waitUntil(() => service.manager.list('wt_1')[0]?.running === false, 'the setup command to end')
      expect(service.manager.list('wt_1')).toEqual([
        expect.objectContaining({ label: SETUP_PANE_LABEL, run: 'setup', exitCode: 3 })
      ])
    },
    TEST_TIMEOUT_MS
  )
})
