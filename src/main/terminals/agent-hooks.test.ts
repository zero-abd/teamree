// The agent's own word about what it is doing, and how it is asked for.
//
// Two halves. The pure one is the file handed to the agent and the line that
// hands it over: both are strings a person can read back, and both are what
// a wrong terminal id or a mis-quoted profile path would break silently. The
// pty half is the file's life: written for the pane, kept across the pane's
// program starting again, and gone with the pane.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { shippedCliCandidates } from '../cli/shippedCli'
import { AGENT_HOOK_EVENTS, hookCommand, hookSettings, hookSettingsPath, hookedLaunch } from './agent-hooks'
import { canSpawnPty, waitUntil, writeFakeAgent } from './pty-test-support'
import type { TerminalRecord } from './session-restore'
import { TerminalSessionManager, type SessionRepository } from './session-manager'

const USER_DATA = '/Users/ana/Library/Application Support/teamree'
const CLI = '/Applications/teamree.app/Contents/Resources/cli/teamree'

describe('hookSettings', () => {
  const settings = hookSettings({ userDataDir: USER_DATA, cli: CLI }, 'term_7')

  it('subscribes to the five events a pane state is read from, and nothing else', () => {
    expect(Object.keys(settings.hooks).sort()).toEqual([...AGENT_HOOK_EVENTS].sort())
    expect(AGENT_HOOK_EVENTS).toEqual(['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd'])
  })

  it('runs this app’s own CLI, naming the pane, the event and the profile', () => {
    const [group] = settings.hooks.Notification
    expect(group?.hooks).toHaveLength(1)
    const [hook] = group?.hooks ?? []
    expect(hook?.type).toBe('command')
    expect(hook?.command).toContain(`${CLI} agent event`)
    expect(hook?.command).toContain('--terminal term_7')
    expect(hook?.command).toContain('--event Notification')
    // The profile path has a space in it on every Mac, so it goes over quoted.
    expect(hook?.command).toContain(`--user-data-dir '${USER_DATA}'`)
  })

  // A hook that fails is a line in the agent's transcript, and a hook that
  // hangs is a turn that hangs. Neither is allowed to be this app's fault.
  it('never fails the agent and never holds it for long', () => {
    for (const event of AGENT_HOOK_EVENTS) {
      const [hook] = settings.hooks[event][0]?.hooks ?? []
      expect(hook?.command.endsWith('|| true')).toBe(true)
      expect(hook?.command).toContain('--timeout 3000')
      expect(hook?.timeout).toBeLessThanOrEqual(10)
    }
  })

  it('does not name a matcher, so every notification type is heard', () => {
    expect(settings.hooks.Notification[0]).not.toHaveProperty('matcher')
  })
})

// The line names the CLI by the path the app found it at, and the app finds it
// in one of two places (see `shippedCli.ts`). Both are spelled out here as the
// hook would carry them, because a hook pointing at the checkout from inside an
// installed app, or at a path with a bare space in it, fails without a word:
// `|| true` sees to that, by design.
describe('hookCommand', () => {
  const [packaged, checkout] = shippedCliCandidates({
    resourcesPath: '/Applications/teamree.app/Contents/Resources',
    cwd: '/Users/ana/My Projects/teamree'
  })

  it('runs the CLI where the installed app keeps it, with the profile path quoted', () => {
    expect(packaged).toEqual({ path: '/Applications/teamree.app/Contents/Resources/cli/teamree', packaged: true })
    expect(hookCommand({ userDataDir: USER_DATA, cli: packaged?.path ?? '' }, 'term_7', 'Stop')).toBe(
      '/Applications/teamree.app/Contents/Resources/cli/teamree agent event --terminal term_7 --event Stop ' +
        "--user-data-dir '/Users/ana/Library/Application Support/teamree' --timeout 3000 || true"
    )
  })

  it('runs the CLI out of the checkout on a development run, quoted when the checkout has a space in it', () => {
    expect(checkout).toEqual({ path: '/Users/ana/My Projects/teamree/resources/cli/teamree', packaged: false })
    expect(hookCommand({ userDataDir: '/tmp/profile', cli: checkout?.path ?? '' }, 'term_7', 'Stop')).toBe(
      "'/Users/ana/My Projects/teamree/resources/cli/teamree' agent event --terminal term_7 --event Stop " +
        '--user-data-dir /tmp/profile --timeout 3000 || true'
    )
  })

  // The hook runs under whatever environment the agent has, which is the
  // pane's login shell, and an installed app cannot assume that shell has a
  // Node on its PATH. The launcher the line names runs the bundle under the
  // app's own binary and reaches for a system `node` only in a checkout.
  it('names a launcher that needs no node on PATH inside the installed app', () => {
    const launcher = fileURLToPath(new URL('../../../resources/cli/teamree', import.meta.url))
    expect(statSync(launcher).mode & 0o111).not.toBe(0)
    const script = readFileSync(launcher, 'utf8')
    expect(script.startsWith('#!/bin/sh')).toBe(true)
    expect(script).toContain('ELECTRON_RUN_AS_NODE=1 exec "$host" "$bundle" "$@"')
    // The app's binary is tried before PATH is consulted at all.
    expect(script.indexOf('ELECTRON_RUN_AS_NODE=1')).toBeLessThan(script.indexOf('command -v node'))
  })
})

describe('hookSettingsPath', () => {
  it('keeps one file per pane under the profile, never under the user’s home', () => {
    expect(hookSettingsPath(USER_DATA, 'term_7')).toBe(path.join(USER_DATA, 'agent-hooks', 'term_7.json'))
  })
})

describe('hookedLaunch', () => {
  const file = '/tmp/profile/agent-hooks/term_7.json'

  it('hands Claude Code the settings file', () => {
    expect(hookedLaunch('claude', 'claude', file)).toBe(`claude --settings ${file}`)
  })

  it('puts the flag in front of the agent’s own terminator', () => {
    expect(hookedLaunch('claude -- fix the tests', 'claude', file)).toBe(`claude --settings ${file} -- fix the tests`)
  })

  it('quotes a path with a space in it', () => {
    const spaced = '/Users/ana/Library/Application Support/teamree/agent-hooks/term_7.json'
    expect(hookedLaunch('claude', 'claude', spaced)).toBe(`claude --settings '${spaced}'`)
  })

  // Claude Code takes one settings argument. Overriding the user's own would
  // silently drop whatever they put in it, so theirs stands and this pane is
  // read the old way.
  it('leaves a command that already carries a settings file alone', () => {
    expect(hookedLaunch('claude --settings mine.json', 'claude', file)).toBe('claude --settings mine.json')
    expect(hookedLaunch('claude --settings=mine.json', 'claude', file)).toBe('claude --settings=mine.json')
  })

  it('leaves an agent with no per-launch hooks alone', () => {
    expect(hookedLaunch('codex', 'codex', file)).toBe('codex')
    expect(hookedLaunch('gemini', 'gemini', file)).toBe('gemini')
  })

  it('leaves a line it cannot model alone rather than mangling it', () => {
    expect(hookedLaunch('claude | tee log', 'claude', file)).toBe('claude | tee log')
  })
})

const describePty = canSpawnPty() ? describe : describe.skip
const TEST_TIMEOUT_MS = 20_000
const WORKTREE = 'wt_hooks'

const managers: TerminalSessionManager[] = []
const scratch: string[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map((created) => created.shutdown()))
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

class Records implements SessionRepository {
  private readonly records = new Map<string, TerminalRecord>()
  listTerminals(): TerminalRecord[] {
    return [...this.records.values()]
  }
  putTerminal(record: TerminalRecord): TerminalRecord {
    this.records.set(record.id, record)
    return record
  }
  removeTerminal(terminalId: string): boolean {
    return this.records.delete(terminalId)
  }
}

async function scratchDir(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `teamree-${name}-`))
  scratch.push(dir)
  return dir
}

function manager(checkout: string, userDataDir: string, sessions: SessionRepository): TerminalSessionManager {
  const created = new TerminalSessionManager({
    resolveWorktreeCwd: (worktreeId) => (worktreeId === WORKTREE ? checkout : undefined),
    sessions,
    agentHooks: { userDataDir, cli: '/opt/teamree/bin/teamree' },
    conversationEvidence: () => 'present'
  })
  managers.push(created)
  return created
}

describePty('the settings file over a real pty', () => {
  it(
    'is written for an agent pane, handed to the agent, and removed with the pane',
    async () => {
      const checkout = await scratchDir('hooks-checkout')
      const userDataDir = await scratchDir('hooks-profile')
      const launch = await writeFakeAgent(checkout)
      const sessions = new Records()
      const first = manager(checkout, userDataDir, sessions)

      // With a first prompt, which goes on the running line and not the record:
      // the flag has to be on both, and in front of the prompt.
      const terminal = first.create({ worktreeId: WORKTREE, command: launch, prompt: 'first words' })
      const file = hookSettingsPath(userDataDir, terminal.id)
      expect(existsSync(file)).toBe(true)
      const written = JSON.parse(readFileSync(file, 'utf8')) as ReturnType<typeof hookSettings>
      expect(written.hooks.Stop[0]?.hooks[0]?.command).toContain(`--terminal ${terminal.id}`)

      // The fake agent prints its arguments, so the pane shows what it was handed.
      await waitUntil(() => first.read(terminal.id).includes('first words'), 'the agent to print its arguments')
      const printed = first.read(terminal.id)
      expect(printed).toContain(file)
      expect(printed.indexOf('--settings')).toBeLessThan(printed.indexOf('first words'))
      expect(sessions.listTerminals()[0]?.command).toContain('--settings')
      expect(sessions.listTerminals()[0]?.command).not.toContain('first words')

      // Ended, and started again: the same pane, the same file.
      await waitUntil(() => !first.list().find((row) => row.id === terminal.id)?.running, 'the agent to exit')
      await first.relaunch({ terminalId: terminal.id })
      expect(existsSync(file)).toBe(true)
      await waitUntil(() => !first.list().find((row) => row.id === terminal.id)?.running, 'the relaunch to exit')

      // Brought back on the next launch, under the same id: the same file again.
      await first.shutdown()
      const second = manager(checkout, userDataDir, sessions)
      expect(second.restoreSessions()).toMatchObject({ restored: 1 })
      expect(existsSync(file)).toBe(true)
      expect(sessions.listTerminals()[0]?.command).toContain('--settings')

      await second.close(terminal.id)
      expect(existsSync(file)).toBe(false)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'is not written for a plain shell',
    async () => {
      const checkout = await scratchDir('hooks-shell-checkout')
      const userDataDir = await scratchDir('hooks-shell-profile')
      const created = manager(checkout, userDataDir, new Records())
      const terminal = created.create({ worktreeId: WORKTREE })
      expect(existsSync(hookSettingsPath(userDataDir, terminal.id))).toBe(false)
      expect(existsSync(path.join(userDataDir, 'agent-hooks'))).toBe(false)
    },
    TEST_TIMEOUT_MS
  )
})
