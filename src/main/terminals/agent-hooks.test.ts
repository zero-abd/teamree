// The agent's own word about what it is doing, and how it is asked for.
//
// Two halves. The pure one is the file handed to the agent and the line that
// hands it over: both are strings a person can read back, and both are what
// a wrong terminal id or a mis-quoted profile path would break silently. The
// pty half is the file's life: written for the pane, kept across the pane's
// program starting again, and gone with the pane.

import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_HOOK_EVENTS, hookSettings, hookSettingsPath, hookedLaunch } from './agent-hooks'
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

      const terminal = first.create({ worktreeId: WORKTREE, command: launch })
      const file = hookSettingsPath(userDataDir, terminal.id)
      expect(existsSync(file)).toBe(true)
      const written = JSON.parse(readFileSync(file, 'utf8')) as ReturnType<typeof hookSettings>
      expect(written.hooks.Stop[0]?.hooks[0]?.command).toContain(`--terminal ${terminal.id}`)

      // The fake agent prints its arguments, so the pane shows what it was handed.
      await waitUntil(() => first.read(terminal.id).includes('--settings'), 'the agent to print its arguments')
      expect(first.read(terminal.id)).toContain(file)

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
