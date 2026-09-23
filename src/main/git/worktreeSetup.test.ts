// What "runs visibly in a pane" has to mean, in two halves.
//
// The first half is the contract with the terminal service: one pane, labelled
// `setup`, in the new worktree, and the command with an Enter after it — which
// is asserted against a double, because those are the four facts and nothing
// else about them needs a process.
//
// The second half is that the bytes actually run, which no double can say. That
// one goes through a real TerminalSessionManager and a real pty, and proves it
// the only way a terminal can be proved: the command leaves a file behind.

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Terminal } from '../../shared/entities'
import { createTerminalService, type TerminalService } from '../terminals/method-handlers'
import { canSpawnPty, waitUntil } from '../terminals/pty-test-support'
import { normalizeSetupCommand, SETUP_PANE_LABEL, startSetupCommand } from './worktreeSetup'

const describePty = canSpawnPty() ? describe : describe.skip
const TEST_TIMEOUT_MS = 20_000

const services: TerminalService[] = []
const scratchDirs: string[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()))
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A pane opener that records rather than forking anything. */
function recorder(): {
  panes: Parameters<typeof startSetupCommand>[0]
  opened: Array<{ worktreeId: string; label: string }>
  written: Array<{ terminalId: string; data: string }>
} {
  const opened: Array<{ worktreeId: string; label: string }> = []
  const written: Array<{ terminalId: string; data: string }> = []
  return {
    opened,
    written,
    panes: {
      create: (params) => {
        opened.push(params)
        return { id: 't_setup', worktreeId: params.worktreeId, label: params.label } as unknown as Terminal
      },
      write: (terminalId, data) => {
        written.push({ terminalId, data })
        return true
      }
    }
  }
}

describe('starting a setup command', () => {
  it('opens one pane of the worktree, labelled setup, and types the command with an Enter', () => {
    const { panes, opened, written } = recorder()

    const terminal = startSetupCommand(panes, { worktreeId: 'wt_1', command: 'npm ci' })

    expect(opened).toEqual([{ worktreeId: 'wt_1', label: SETUP_PANE_LABEL }])
    expect(SETUP_PANE_LABEL).toBe('setup')
    // A carriage return, which is the byte Enter sends a pty — the same one
    // `teamree terminal send --enter` appends.
    expect(written).toEqual([{ terminalId: 't_setup', data: 'npm ci\r' }])
    expect(terminal.id).toBe('t_setup')
  })

  it('passes the command through untouched, because it is the developer’s own line', () => {
    const { panes, written } = recorder()
    startSetupCommand(panes, { worktreeId: 'wt_1', command: 'npm ci && npm run build # go' })
    expect(written[0]?.data).toBe('npm ci && npm run build # go\r')
  })

  it('reads a blank command as no command, and keeps everything between the ends', () => {
    expect(normalizeSetupCommand('   ')).toBeUndefined()
    expect(normalizeSetupCommand('')).toBeUndefined()
    expect(normalizeSetupCommand('  npm ci  ')).toBe('npm ci')
    expect(normalizeSetupCommand('npm ci && npm test')).toBe('npm ci && npm test')
  })
})

describePty('a setup pane on a real pty', () => {
  it(
    'runs the command in the worktree, in a pane listed under the setup label',
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'teamree-setup-pane-'))
      scratchDirs.push(dir)
      const service = createTerminalService({ resolveWorktreeCwd: (id) => (id === 'wt_1' ? dir : undefined) })
      services.push(service)

      // Written with no path, so what is being proved is the pane's cwd as
      // much as the command: the file can only land in `dir` if the shell
      // started there.
      startSetupCommand(service.manager, { worktreeId: 'wt_1', command: 'echo SETUP-RAN > setup.txt' })

      await waitUntil(() => existsSync(path.join(dir, 'setup.txt')), 'the setup command to write its file')
      const panes = service.manager.list('wt_1')
      expect(panes).toHaveLength(1)
      expect(panes[0]?.label).toBe(SETUP_PANE_LABEL)
    },
    TEST_TIMEOUT_MS
  )
})
