import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Layout } from '../../shared/entities'
import type { TerminalEvent } from '../../shared/methods'
import { MAX_RECORD_BYTES, ScrollbackArchive } from '../store/scrollbackArchive'
import { canSpawnPty, waitUntil } from './pty-test-support'
import {
  claudeTranscriptPath,
  conversationOnDisk,
  type ConversationEvidence,
  type ConversationQuestion
} from './agent-conversations'
import { INERT_RECORD, noConversationMark } from './scrollbackRecord'
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

/** What the agents' stores answer; the real probe would read the suite runner's home directory. */
const stored = (): ConversationEvidence => 'present'
const missing = (): ConversationEvidence => 'absent'
const unknowable = (): ConversationEvidence => 'unknown'

describe('restoreLaunch', () => {
  it('resumes an agent by the id that was pinned for it', () => {
    const launch = restoreLaunch(record({ command: 'claude', agent: 'claude', agentSessionId: 'abc' }), stored)
    expect(launch.command).toBe('claude --resume abc')
    expect(launch.resumed).toBe(true)
  })

  // Worked out now: when it is needed the agent has exited and the pane is empty.
  it('carries a way to start the agent over if that resume is refused', () => {
    const launch = restoreLaunch(
      record({ command: 'claude --session-id old-zzz', agent: 'claude', agentSessionId: 'old-zzz' }),
      stored
    )
    expect(launch.command).toBe('claude --resume old-zzz')
    // A fresh id, not the refused one.
    expect(launch.fallback?.agentSessionId).toBeDefined()
    expect(launch.fallback?.agentSessionId).not.toBe('old-zzz')
    expect(launch.fallback?.command).toContain(`--session-id ${launch.fallback?.agentSessionId as string}`)
    expect(launch.fallback?.command).not.toContain('old-zzz')
    expect(launch.fallback?.command).not.toContain('--resume')
  })

  it('starts a session-less agent over with the command it was launched with', () => {
    const launch = restoreLaunch(record({ command: 'codex', agent: 'codex' }), stored)
    expect(launch.command).toBe('codex resume --last')
    expect(launch.resumed).toBe(true)
    expect(launch.fallback).toEqual({ command: 'codex' })
  })

  // An id is reserved at start; a pane left alone wrote nothing under it, so
  // resuming it is refused by the CLI every launch for the life of the record.
  it('starts the agent over for a pane this app knows nobody typed into', () => {
    // Letters outside hex on purpose: a hex sentinel can turn up inside a fresh
    // v4 UUID by chance, about one run in a couple of hundred.
    const launch = restoreLaunch(
      record({ command: 'claude --session-id old-zzz', agent: 'claude', agentSessionId: 'old-zzz', typed: false }),
      unknowable
    )

    expect(launch.resumed).toBe(false)
    // Gone from the command, not sitting beside the new one for the CLI to choose.
    expect(launch.command).not.toContain('old-zzz')
    expect(launch.command).not.toContain('--resume')
    expect(launch.command).toContain('--session-id')
    // The record has to name the id that actually ran.
    expect(launch.repinned?.command).toBe(launch.command)
    expect(launch.repinned?.agentSessionId).toBeDefined()
    expect(launch.command).toContain(launch.repinned?.agentSessionId as string)
  })

  // "Resume the last session here" for a pane that had none would pick up
  // whatever else was run in this directory.
  it('starts an agent that mints its own ids over too, with nothing pinned', () => {
    expect(restoreLaunch(record({ command: 'codex', agent: 'codex', typed: false }), unknowable)).toEqual({
      command: 'codex',
      resumed: false,
      repinned: { command: 'codex' }
    })
  })

  // The upgrade case: every workspace file written before this field existed
  // has real conversations behind it. Absent is unknown, not no.
  it('still tries the resume for a record written before any of this existed', () => {
    const pinned = restoreLaunch(
      record({ command: 'claude --session-id abc', agent: 'claude', agentSessionId: 'abc' }),
      unknowable
    )
    expect(pinned.command).toBe('claude --resume abc')
    expect(pinned.resumed).toBe(true)
    const latest = restoreLaunch(record({ command: 'codex', agent: 'codex' }), unknowable)
    expect(latest.command).toBe('codex resume --last')
    expect(latest.resumed).toBe(true)
  })

  // Failing open is wrong here because this branch also records the id it
  // believes is on the line; an append would leave three states matching nothing.
  it('opens a plain shell rather than rewrite a command it could not read', () => {
    for (const command of [
      'codex | tee log',
      'ssh host claude --session-id old-zzz',
      "claude --session-id 'unclosed"
    ]) {
      const agent = command.includes('codex') ? 'codex' : 'claude'
      expect(restoreLaunch(record({ command, agent, typed: false }), unknowable), command).toEqual({ resumed: false })
    }
  })

  // A session the caller named themselves is not ours to replace.
  it('leaves a session somebody chose by hand alone, typed into or not', () => {
    expect(restoreLaunch(record({ command: 'claude --resume chosen-by-hand', agent: 'claude' }), missing)).toEqual({
      command: 'claude --resume chosen-by-hand',
      resumed: true
    })
    expect(restoreLaunch(record({ command: 'codex resume chosen-by-hand', agent: 'codex' }), missing)).toEqual({
      command: 'codex resume chosen-by-hand',
      resumed: true
    })
  })

  // A deploy or a migration is not something to re-run because the app restarted.
  it('never re-runs an ordinary command, however it was left', () => {
    for (const command of ['npm run deploy', 'psql -f migrate.sql', 'npm test', 'rm -rf build']) {
      expect(restoreLaunch(record({ command })), command).toEqual({ resumed: false })
    }
  })

  it('opens a plain shell for a pane that never had a command', () => {
    expect(restoreLaunch(record())).toEqual({ resumed: false })
  })

  // The first `claude` in a fresh worktree puts up "Is this a project you
  // trust?"; answering it is a keystroke that reaches a gate, not an agent, so
  // `typed` alone is not proof of a conversation.
  it('starts over a pane whose conversation is not in the store, whatever was typed into it', () => {
    const launch = restoreLaunch(
      record({ command: 'claude --session-id old-zzz', agent: 'claude', agentSessionId: 'old-zzz', typed: true }),
      missing
    )

    expect(launch.resumed).toBe(false)
    expect(launch.command).not.toContain('--resume')
    expect(launch.command).not.toContain('old-zzz')
    expect(launch.repinned?.agentSessionId).toBeDefined()
    expect(launch.note).toBe(noConversationMark('claude'))
  })

  // A conversation on the disk is resumed whatever this app watched: a pane can
  // be driven by something other than a keyboard.
  it('resumes a pane whose conversation is in the store though nothing was seen typed into it', () => {
    const launch = restoreLaunch(
      record({ command: 'claude --session-id abc', agent: 'claude', agentSessionId: 'abc', typed: false }),
      stored
    )

    expect(launch).toEqual({ command: 'claude --resume abc', resumed: true, fallback: expect.anything() })
    expect(launch.note).toBeUndefined()
  })

  // The line is for when the app looked somewhere the reader cannot see.
  it('says nothing extra when it is only the old heuristic starting a pane over', () => {
    const launch = restoreLaunch(record({ command: 'claude', agent: 'claude', typed: false }), unknowable)
    expect(launch.resumed).toBe(false)
    expect(launch.note).toBeUndefined()
  })

  it('opens a plain shell when the agent offers no way back at all', () => {
    expect(restoreLaunch(record({ command: 'gemini', agent: 'gemini', typed: true }), unknowable)).toEqual({
      resumed: false
    })
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

  it('breaks a same-millisecond tie by where the panes sat in the layout, whatever their ids', () => {
    for (let trial = 0; trial < 50; trial += 1) {
      const stored = [0, 1, 2].map(() => record({ id: `term_${randomUUID()}`, createdAt: 5 }))
      const shown = [2, 0, 1].map((index) => (stored[index] as TerminalRecord).id)

      const rows = restorableRecords(stored, () => true, shown)

      expect(rows.map((row) => row.id)).toEqual(shown)
    }
  })

  it('keeps stored order for a same-millisecond tie no layout mentions', () => {
    for (let trial = 0; trial < 50; trial += 1) {
      const stored = [0, 1, 2].map(() => record({ id: `term_${randomUUID()}`, createdAt: 5 }))

      const rows = restorableRecords(stored, () => true)

      expect(rows.map((row) => row.id)).toEqual(stored.map((row) => row.id))
    }
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

/** Whether a file a pane's command writes has got as far as saying `want`; absent reads as "not yet". */
async function markerSays(filePath: string, want: string): Promise<boolean> {
  return (await readFile(filePath, 'utf8').catch(() => '')).includes(want)
}

/** Everything a subscriber was actually sent, as the bytes it would have drawn. */
const outputOf = (events: readonly TerminalEvent[]): string =>
  events
    .filter((event): event is Extract<TerminalEvent, { type: 'data' }> => event.type === 'data')
    .map((event) => event.data)
    .join('')

const describePty = canSpawnPty() ? describe : describe.skip

describePty('restoring terminals across a restart', () => {
  const created: string[] = []
  const managers: TerminalSessionManager[] = []

  afterEach(async () => {
    vi.unstubAllEnvs()
    await Promise.all(managers.splice(0).map((manager) => manager.shutdown()))
    await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  /** What the stand-in agent says when its conversation has been taken away. */
  const REFUSAL = 'that conversation is not here any more'

  /**
   * A stand-in agent that prints its arguments. After `loseTheConversation()`
   * it refuses any *resume* — a line and a non-zero exit, as the real CLIs do —
   * while a plain launch still starts: the conversation is gone, the agent is not.
   */
  async function fakeAgent(
    name: string
  ): Promise<{ checkout: string; launch: string; loseTheConversation: () => Promise<void> }> {
    const base = await mkdtemp(path.join(os.tmpdir(), 'teamree-restore-'))
    created.push(base)
    const checkout = path.join(base, 'checkout')
    const bin = path.join(base, 'bin')
    await mkdir(checkout, { recursive: true })
    await mkdir(bin, { recursive: true })
    // Windows decides what is executable by the extension; unix by the bit.
    const windows = process.platform === 'win32'
    const binary = path.join(bin, windows ? `${name}.cmd` : name)
    const gone = path.join(base, 'conversation-gone')
    // Stays running: a stub that exits at once has tests typing into a closed
    // pty, which node-pty logs about.
    if (windows) {
      await writeFile(
        binary,
        '@echo off\r\necho %*| find "--resume" >nul\r\n' +
          `if not errorlevel 1 if exist "${gone}" (\r\n echo ${REFUSAL}\r\n exit /b 1\r\n)\r\n` +
          'echo AGENT ARGS: %*\r\nping -n 31 127.0.0.1 >nul\r\n',
        'utf8'
      )
    } else {
      await writeFile(
        binary,
        `#!/bin/sh\ncase " $* " in\n  *" --resume "*|*" resume "*)\n    if [ -f "${gone}" ]; then\n` +
          `      echo "${REFUSAL}"\n      exit 1\n    fi\n    ;;\nesac\n` +
          'echo "AGENT ARGS: $@"\nsleep 30\n',
        'utf8'
      )
      await chmod(binary, 0o755)
    }
    // Quoted: a Windows path's backslashes read as escapes to the shell and the tokenizer.
    return { checkout, launch: `"${binary}"`, loseTheConversation: () => writeFile(gone, '', 'utf8') }
  }

  /** What a CLI says when it is asked for a conversation it does not have. */
  const NOT_FOUND = 'No conversation found with session ID'

  /**
   * A stand-in agent that records its conversation on disk unless it inherits
   * the marker saying it is another session's subprocess — Claude Code stops
   * writing then, which is what a pane got when the app was started from an
   * agent's pane — and refuses a resume when there is no record.
   */
  async function recordingAgent(
    name: string
  ): Promise<{ checkout: string; launch: string; marker: string; loseTheConversation: () => Promise<void> }> {
    const base = await mkdtemp(path.join(os.tmpdir(), 'teamree-recording-'))
    created.push(base)
    const checkout = path.join(base, 'checkout')
    const bin = path.join(base, 'bin')
    await mkdir(checkout, { recursive: true })
    await mkdir(bin, { recursive: true })
    const windows = process.platform === 'win32'
    const binary = path.join(bin, windows ? `${name}.cmd` : name)
    const kept = path.join(base, 'conversation')
    const marker = 'CLAUDE_CODE_CHILD_SESSION'
    if (windows) {
      await writeFile(
        binary,
        '@echo off\r\necho %*| find "--resume" >nul\r\n' +
          `if not errorlevel 1 (\r\n if not exist "${kept}" (\r\n  echo ${NOT_FOUND}\r\n  exit /b 1\r\n )\r\n)` +
          `else (\r\n if "%${marker}%"=="" copy nul "${kept}" >nul\r\n)\r\n` +
          'echo AGENT ARGS: %*\r\nping -n 31 127.0.0.1 >nul\r\n',
        'utf8'
      )
    } else {
      await writeFile(
        binary,
        `#!/bin/sh\ncase " $* " in\n  *" --resume "*)\n    if [ ! -f "${kept}" ]; then\n` +
          `      echo "${NOT_FOUND}"\n      exit 1\n    fi\n    ;;\n  *)\n` +
          `    if [ -z "\${${marker}}" ]; then : > "${kept}"; fi\n    ;;\nesac\n` +
          'echo "AGENT ARGS: $@"\nsleep 30\n',
        'utf8'
      )
      await chmod(binary, 0o755)
    }
    return { checkout, launch: `"${binary}"`, marker, loseTheConversation: () => rm(kept, { force: true }) }
  }

  function manager(
    repositories: LayoutRepository & SessionRepository,
    checkout: string,
    scrollback?: ScrollbackArchive,
    /** Shortened from fifteen seconds, so a test can watch a checkpoint happen. */
    checkpointIntervalMs?: number,
    /** Default "unknown": the real probe would answer "absent" for a checkout made in /tmp. */
    conversationEvidence: (question: ConversationQuestion) => ConversationEvidence = () => 'unknown'
  ): TerminalSessionManager {
    const created = new TerminalSessionManager({
      resolveWorktreeCwd: (worktreeId) => (worktreeId === 'wt_1' ? checkout : undefined),
      layouts: repositories,
      sessions: repositories,
      conversationEvidence,
      ...(scrollback === undefined ? {} : { scrollback }),
      ...(checkpointIntervalMs === undefined ? {} : { checkpointIntervalMs })
    })
    managers.push(created)
    return created
  }

  /** The directory a restart's worth of pane output is kept in. */
  async function scrollbackArchive(keep: string[] = []): Promise<ScrollbackArchive> {
    const base = await mkdtemp(path.join(os.tmpdir(), 'teamree-scrollback-'))
    created.push(base)
    return ScrollbackArchive.open(path.join(base, 'scrollback'), keep)
  }

  it('gives an agent a session id, then hands the same id back after a restart', async () => {
    const { checkout, launch } = await fakeAgent('claude')
    const repositories = createRepositories()

    const first = manager(repositories, checkout)
    const opened = first.create({ worktreeId: 'wt_1', command: launch })
    await waitUntil(() => first.read(opened.id).includes('AGENT ARGS:'), 'the agent to print its arguments')

    const launched = first.read(opened.id)
    expect(launched).toContain('--session-id')
    const sessionId = repositories.listTerminals()[0]?.agentSessionId
    expect(sessionId).toBeDefined()
    expect(launched).toContain(sessionId as string)

    // Without this there is no conversation under that id to come back to.
    first.write(opened.id, 'hello\r')

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
    // Two selectors and the CLI picks.
    expect(resumedLine).not.toContain('--session-id')
  }, 20_000)

  it.skipIf(process.platform === 'win32')(
    'tells a restored pane the terminal id it had before',
    async () => {
      const base = await mkdtemp(path.join(os.tmpdir(), 'teamree-identity-'))
      created.push(base)
      const checkout = path.join(base, 'checkout')
      await mkdir(checkout)
      const agent = path.join(base, 'claude')
      await writeFile(agent, '#!/bin/sh\necho "pane=$TEAMREE_TERMINAL_ID"\nsleep 30\n', 'utf8')
      await chmod(agent, 0o755)
      const repositories = createRepositories()
      const said = (manager: TerminalSessionManager, id: string): string =>
        /pane=(\S+)/.exec(manager.read(id))?.[1] ?? ''

      const first = manager(repositories, checkout)
      const opened = first.create({ worktreeId: 'wt_1', command: `"${agent}"` })
      await waitUntil(() => said(first, opened.id) !== '', 'the pane to print its id')
      first.write(opened.id, 'hello\r')
      await first.shutdown()

      const second = manager(repositories, checkout)
      expect(second.restoreSessions().restored).toBe(1)
      await waitUntil(() => said(second, opened.id) !== '', 'the restored pane to print its id')
      expect(said(second, opened.id)).toBe(opened.id)
    },
    20_000
  )

  // A pane talking to Claude Code all day came back saying "No conversation
  // found with session ID": the app, started from inside an agent session,
  // handed every pane the marker that makes the agent stop keeping a transcript.
  it('does not hand a pane the session markers of the agent that started the app', async () => {
    const { checkout, launch, marker } = await recordingAgent('claude')
    const repositories = createRepositories()
    const inherited = process.env[marker]
    // teamree started by `npm run dev` typed into an agent's own pane.
    process.env[marker] = '1'

    try {
      const first = manager(repositories, checkout)
      const opened = first.create({ worktreeId: 'wt_1', command: launch })
      await waitUntil(() => first.read(opened.id).includes('AGENT ARGS:'), 'the agent to print its arguments')
      const pinned = repositories.listTerminals()[0]?.agentSessionId
      expect(pinned).toBeDefined()
      first.write(opened.id, 'hello\r')
      await first.shutdown()

      const second = manager(repositories, checkout)
      expect(second.restoreSessions()).toEqual({ restored: 1, resumed: 1 })
      await waitUntil(() => second.read(opened.id).includes('AGENT ARGS:'), 'the resumed agent to print its arguments')

      const shown = second.read(opened.id)
      expect(shown).toContain(`--resume ${pinned as string}`)
      expect(shown).not.toContain(NOT_FOUND)
      expect(second.list('wt_1')[0]?.running).toBe(true)
    } finally {
      if (inherited === undefined) delete process.env[marker]
      else process.env[marker] = inherited
    }
  }, 20_000)

  it('brings a pane back under the name it was given, rename included', async () => {
    const { checkout, launch } = await fakeAgent('claude')
    const repositories = createRepositories()

    const first = manager(repositories, checkout)
    // One named by the composer, one renamed afterwards. Both have to come back.
    const fromComposer = first.create({ worktreeId: 'wt_1', command: launch, label: 'auth refactor' })
    const renamed = first.create({ worktreeId: 'wt_1', command: launch })
    expect(fromComposer.label).toBe('auth refactor')
    expect(first.rename(renamed.id, 'pager streaming').label).toBe('pager streaming')
    first.write(fromComposer.id, 'hello\r')
    first.write(renamed.id, 'hello\r')

    await first.shutdown()

    const second = manager(repositories, checkout)
    expect(second.restoreSessions().restored).toBe(2)

    const restored = second.list('wt_1')
    expect(restored.map((pane) => pane.label)).toEqual(['auth refactor', 'pager streaming'])
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

    // The file the command appends to still has one line.
    const restored = second.list('wt_1')
    expect(restored[0]?.id).toBe(opened.id)
    expect(restored[0]?.cwd).toBe(checkout)
    const { readFile } = await import('node:fs/promises')
    expect((await readFile(marker, 'utf8')).trim().split('\n')).toEqual(['once'])
  }, 20_000)

  it('says how each pane got here, and stops saying it once the user types', async () => {
    const { checkout, launch } = await fakeAgent('claude')
    const repositories = createRepositories()

    const first = manager(repositories, checkout)
    const agentPane = first.create({ worktreeId: 'wt_1', command: launch })
    const plainPane = first.create({ worktreeId: 'wt_1', command: 'echo hello' })
    expect(first.list('wt_1').every((terminal) => terminal.restored === undefined)).toBe(true)
    first.write(agentPane.id, 'hello\r')
    await first.shutdown()

    const second = manager(repositories, checkout)
    second.restoreSessions()

    const byId = new Map(second.list('wt_1').map((terminal) => [terminal.id, terminal]))
    expect(byId.get(agentPane.id)?.restored).toBe('agent')
    expect(byId.get(plainPane.id)?.restored).toBe('shell')

    // The write reports the keystroke, which is what lets the change stream retire the badge.
    const answered: string[] = []
    second.onPaneAnswered((terminalId) => answered.push(terminalId))
    second.write(agentPane.id, 'x')
    expect(answered).toEqual([agentPane.id])
    expect(second.list('wt_1').find((terminal) => terminal.id === agentPane.id)?.restored).toBeUndefined()
    second.write(agentPane.id, 'y')
    expect(answered).toEqual([agentPane.id])
  }, 20_000)

  // The banner said "fresh claude below" while the badge said "new shell".
  it('says a pane running its agent over again was restarted, not that it is a shell', async () => {
    const { checkout, launch } = await fakeAgent('claude')
    const repositories = createRepositories()

    const first = manager(repositories, checkout)
    const agentPane = first.create({ worktreeId: 'wt_1', command: launch })
    const plainPane = first.create({ worktreeId: 'wt_1', command: 'echo hello' })
    first.write(agentPane.id, 'hello\r')
    await first.shutdown()

    const second = manager(repositories, checkout, undefined, undefined, () => 'absent')
    second.restoreSessions()

    const byId = new Map(second.list('wt_1').map((terminal) => [terminal.id, terminal]))
    expect(byId.get(agentPane.id)?.restored).toBe('restarted')
    expect(byId.get(agentPane.id)?.agent).toBe('claude')
    expect(byId.get(plainPane.id)?.restored).toBe('shell')
  }, 20_000)

  // The emulator answers an agent's device queries up the pty within a second
  // of it starting, through the same door a keystroke uses; only the window
  // holding the emulator can tell them apart, and it says.
  it('does not read the emulator answering the agent as a person typing', async () => {
    const { checkout, launch } = await fakeAgent('claude')
    const repositories = createRepositories()

    const first = manager(repositories, checkout)
    const pane = first.create({ worktreeId: 'wt_1', command: launch })
    await waitUntil(() => first.read(pane.id).includes('AGENT ARGS:'), 'the agent to print its arguments')

    // A device-attributes reply and a cursor-position report.
    const answered: string[] = []
    first.onPaneAnswered((terminalId) => answered.push(terminalId))
    first.write(pane.id, '\u001b[?62;c', false)
    first.write(pane.id, '\u001b[1;1R', false)
    expect(repositories.listTerminals()[0]?.typed).toBe(false)
    expect(answered).toEqual([])

    first.write(pane.id, 'hello\r')
    expect(repositories.listTerminals()[0]?.typed).toBe(true)
  }, 20_000)

  it('forgets a pane the user closed, so a restart does not reopen it', async () => {
    const { checkout, launch } = await fakeAgent('claude')
    const repositories = createRepositories()

    const first = manager(repositories, checkout)
    const opened = first.create({ worktreeId: 'wt_1', command: launch })
    await first.close(opened.id)
    expect(repositories.listTerminals()).toEqual([])
    await first.shutdown()

    const second = manager(repositories, checkout)
    expect(second.restoreSessions()).toEqual({ restored: 0, resumed: 0 })
    expect(second.list('wt_1')).toEqual([])
  }, 20_000)

  it('deletes the record of a pane whose worktree is gone, and keeps the ones that came back', async () => {
    const { checkout } = await fakeAgent('unused')
    const repositories = createRepositories()

    const first = manager(repositories, checkout)
    const kept = first.create({ worktreeId: 'wt_1' })
    await first.shutdown()

    // A worktree removed while the app was closed: left here, the record sits
    // in workspace.json for the life of the installation.
    repositories.putTerminal(record({ id: 'term_orphan', worktreeId: 'wt_deleted', cwd: checkout }))

    const second = manager(repositories, checkout)
    expect(second.restoreSessions()).toEqual({ restored: 1, resumed: 0 })
    expect(repositories.listTerminals().map((row) => row.id)).toEqual([kept.id])
  }, 20_000)

  it('leaves behind a terminal whose worktree is no longer there', async () => {
    const { checkout, launch } = await fakeAgent('claude')
    const repositories = createRepositories()

    const first = manager(repositories, checkout)
    first.create({ worktreeId: 'wt_1', command: launch })
    await first.shutdown()

    // A manager that knows nothing about wt_1.
    const second = new TerminalSessionManager({
      resolveWorktreeCwd: () => undefined,
      layouts: repositories,
      sessions: repositories
    })
    managers.push(second)

    expect(second.restoreSessions()).toEqual({ restored: 0, resumed: 0 })
  }, 20_000)

  it('comes back showing what the pane printed, with the new shell under a line that says so', async () => {
    const { checkout } = await fakeAgent('unused')
    const marker = path.join(checkout, 'ran.txt')
    const repositories = createRepositories()
    const archive = await scrollbackArchive()

    const first = manager(repositories, checkout, archive)
    const opened = first.create({ worktreeId: 'wt_1', command: `echo hello-from-before; echo ran >> ${marker}` })
    await waitUntil(() => first.read(opened.id).includes('hello-from-before'), 'the command to print')
    // Waiting only for the print left the shutdown racing `echo ran >> …`: on a
    // loaded machine the pane was torn down between the redirection creating
    // the file and the byte reaching it, and the test read an empty marker.
    await waitUntil(() => markerSays(marker, 'ran'), 'the command to finish writing its marker')
    await first.shutdown()

    const reopened = await ScrollbackArchive.open(archive.directory, [opened.id])
    const second = manager(repositories, checkout, reopened)
    expect(second.restoreSessions()).toEqual({ restored: 1, resumed: 0 })

    const shown = second.read(opened.id)
    expect(shown).toContain('hello-from-before')
    expect(shown).toContain('nothing running')
    expect(shown.indexOf('hello-from-before')).toBeLessThan(shown.indexOf('new shell below'))
    expect(second.list('wt_1')[0]?.restored).toBe('shell')

    // The command did not run again. Proved by asking the restored shell: a
    // shell handed the old command would have run it before answering this
    // probe, so a one-line marker once the answer is on screen cannot be load.
    second.write(opened.id, "printf 'the restored shell %s\\n' answered\r")
    await waitUntil(
      () => second.read(opened.id).includes('the restored shell answered'),
      'the restored pane’s own shell to answer'
    )
    expect((await readFile(marker, 'utf8')).trim().split('\n')).toEqual(['ran'])
  }, 20_000)

  it('does not replay a transcript into an agent pane that is resuming the conversation', async () => {
    const { checkout, launch } = await fakeAgent('claude')
    const repositories = createRepositories()
    const archive = await scrollbackArchive()

    const first = manager(repositories, checkout, archive)
    const opened = first.create({ worktreeId: 'wt_1', command: launch })
    await waitUntil(() => first.read(opened.id).includes('AGENT ARGS:'), 'the agent to print its arguments')
    first.write(opened.id, 'hello\r')
    await first.shutdown()

    const reopened = await ScrollbackArchive.open(archive.directory, [opened.id])
    const second = manager(repositories, checkout, reopened)
    expect(second.restoreSessions()).toEqual({ restored: 1, resumed: 1 })

    // The agent prints the conversation itself; a record above it would be the same exchange twice.
    expect(second.read(opened.id)).not.toContain('nothing running')
    expect(reopened.read(opened.id)?.text).toContain('AGENT ARGS:')

    // Held rather than shown, so the quit still writes last launch's output;
    // withholding used to mean the next quit wrote a one-line refusal over it.
    await second.shutdown()
    expect(reopened.read(opened.id)?.text).toContain('AGENT ARGS:')
  }, 20_000)

  it('says so in the pane, and starts a fresh agent, when the conversation is gone', async () => {
    const { checkout, launch, loseTheConversation } = await fakeAgent('claude')
    const repositories = createRepositories()
    const archive = await scrollbackArchive()

    const first = manager(repositories, checkout, archive)
    const opened = first.create({ worktreeId: 'wt_1', command: launch })
    await waitUntil(() => first.read(opened.id).includes('AGENT ARGS:'), 'the agent to print its arguments')
    first.write(opened.id, 'a question nobody will see the answer to\r')
    await first.shutdown()

    await loseTheConversation()

    const reopened = await ScrollbackArchive.open(archive.directory, [opened.id])
    const second = manager(repositories, checkout, reopened)
    // A count of attempts: nothing here can know in advance.
    expect(second.restoreSessions()).toEqual({ restored: 1, resumed: 1 })

    // A window already open when the agent gave up reads through the stream, not on mount.
    const streamed: TerminalEvent[] = []
    second.attachStream(opened.id, { emit: (event) => streamed.push(event), close: () => {} })

    await waitUntil(() => second.read(opened.id).includes('resume refused'), 'the pane to say what happened')
    const shown = second.read(opened.id)

    // The agent's own reason, then the app's.
    expect(shown).toContain(REFUSAL)
    expect(shown).toContain('[resume refused — agent exited 1')
    expect(shown).not.toContain('deleted, expired, or recorded on another machine')

    // The held-back record is on the screen instead, above the attempt.
    expect(shown).toContain('AGENT ARGS:')
    expect(shown).toContain('nothing running')
    expect(shown).toContain('resume attempt below')
    expect(shown.indexOf('AGENT ARGS:')).toBeLessThan(shown.indexOf(REFUSAL))

    // "resumed" beside "exited 1" would be a claim the app can see is false.
    expect(second.list('wt_1')[0]?.restored).toBeUndefined()

    // A conversation being gone is no reason for the pane to be gone too.
    expect(shown).toContain('fresh agent below')
    const fresh = repositories.listTerminals()[0]
    await waitUntil(
      () => second.read(opened.id).includes(`--session-id ${fresh?.agentSessionId as string}`),
      'a fresh agent to start in the pane'
    )
    expect(second.list('wt_1')[0]?.running).toBe(true)
    expect(second.list('wt_1')[0]?.exitCode).toBeUndefined()

    // An open view reads once on mount, so the old output has to be sent too.
    expect(outputOf(streamed)).toContain('resume refused')
    expect(outputOf(streamed)).toContain('AGENT ARGS:')
    // No exit: the agent in the pane was replaced.
    expect(streamed.some((event) => event.type === 'exit')).toBe(false)

    // The record names the conversation now being had, and nobody has spoken
    // to it yet. Both halves, or the same refusal comes back every launch.
    expect(fresh?.agentSessionId).toBeDefined()
    expect(fresh?.command).toContain(`--session-id ${fresh?.agentSessionId as string}`)
    expect(fresh?.command).not.toContain('--resume')
    expect(fresh?.typed).toBe(false)
  }, 20_000)

  // xterm answers the agent's opening device queries a beat before a refused
  // resume has finished exiting; that demoted the pane, and the fresh agent
  // the note promised never started.
  it('starts the fresh agent even after the emulator has answered in the pane', async () => {
    const { checkout, launch, loseTheConversation } = await recordingAgent('claude')
    const repositories = createRepositories()

    const first = manager(repositories, checkout)
    const opened = first.create({ worktreeId: 'wt_1', command: launch })
    await waitUntil(() => first.read(opened.id).includes('AGENT ARGS:'), 'the agent to print its arguments')
    first.write(opened.id, 'something worth coming back to\r')
    await first.shutdown()

    await loseTheConversation()

    const second = manager(repositories, checkout)
    expect(second.restoreSessions()).toEqual({ restored: 1, resumed: 1 })

    // Immediately, as a window does with a pane it has just drawn.
    second.write(opened.id, '\u001b[?62;c', false)
    second.write(opened.id, '\u001b[1;1R', false)
    expect(second.list('wt_1')[0]?.restored).toBe('agent')

    await waitUntil(() => second.read(opened.id).includes('resume refused'), 'the pane to say what happened')
    const shown = second.read(opened.id)
    expect(shown).toContain(NOT_FOUND)
    expect(shown).toContain('fresh agent below')

    const fresh = repositories.listTerminals()[0]
    await waitUntil(
      () => second.read(opened.id).includes(`--session-id ${fresh?.agentSessionId as string}`),
      'a fresh agent to start in the pane'
    )
    expect(second.list('wt_1')[0]?.running).toBe(true)
    expect(second.list('wt_1')[0]?.exitCode).toBeUndefined()
    expect(fresh?.command).not.toContain('--resume')
    expect(fresh?.typed).toBe(false)
  }, 20_000)

  it('asks for the refused conversation once, and never again', async () => {
    const { checkout, launch, loseTheConversation } = await fakeAgent('claude')
    const repositories = createRepositories()
    const archive = await scrollbackArchive()

    const first = manager(repositories, checkout, archive)
    const opened = first.create({ worktreeId: 'wt_1', command: launch })
    await waitUntil(() => first.read(opened.id).includes('AGENT ARGS:'), 'the agent to print its arguments')
    const lost = repositories.listTerminals()[0]?.agentSessionId
    first.write(opened.id, 'hello\r')
    await first.shutdown()
    await loseTheConversation()

    // The launch that is refused.
    const second = manager(repositories, checkout, await ScrollbackArchive.open(archive.directory, [opened.id]))
    second.restoreSessions()
    await waitUntil(() => second.read(opened.id).includes('resume refused'), 'the pane to say what happened')
    await second.shutdown()

    // The one after it: without the failure written down, the same refusal
    // comes back every launch with another copy of the explanation stacked in.
    const third = manager(repositories, checkout, await ScrollbackArchive.open(archive.directory, [opened.id]))
    expect(third.restoreSessions()).toEqual({ restored: 1, resumed: 0 })
    await waitUntil(
      () => third.read(opened.id).split('new shell below')[1]?.includes('AGENT ARGS:') === true,
      'the agent to start over'
    )
    expect(third.list('wt_1')[0]?.running).toBe(true)

    // Below the record line is this launch; above it the failed one is kept.
    const thisLaunch = third.read(opened.id).split('new shell below')[1] as string
    expect(thisLaunch).toContain('--session-id')
    expect(thisLaunch).not.toContain(REFUSAL)
    expect(thisLaunch).not.toContain(lost as string)
    expect(third.read(opened.id)).toContain(REFUSAL)
  }, 30_000)

  // A one-shot agent is the same executable in a different mode; the clean exit decides it.
  it('says nothing about an agent that resumed, did its work and exited cleanly', async () => {
    const { checkout } = await fakeAgent('unused')
    const repositories = createRepositories()
    const archive = await scrollbackArchive()

    const first = manager(repositories, checkout, archive)
    const opened = first.create({ worktreeId: 'wt_1', command: 'echo one-shot answer' })
    await waitUntil(() => first.read(opened.id).includes('one-shot answer'), 'the command to print')
    await first.shutdown()

    // Rewritten as the agent pane it is standing in for.
    const stored = repositories.listTerminals()[0] as TerminalRecord
    repositories.putTerminal({ ...stored, agent: 'claude', agentSessionId: 'a-real-conversation', typed: true })

    const second = manager(repositories, checkout, await ScrollbackArchive.open(archive.directory, [opened.id]))
    second.restoreSessions()
    await waitUntil(() => second.list('wt_1')[0]?.running === false, 'the one-shot to finish')

    expect(second.read(opened.id)).not.toContain('resume refused')
    expect(second.list('wt_1')[0]?.restored).toBe('agent')
    expect(repositories.listTerminals()[0]?.typed).toBe(true)
  }, 20_000)

  it('says nothing of the kind about a pane the app itself shut down', async () => {
    const { checkout, launch } = await fakeAgent('claude')
    const repositories = createRepositories()
    const archive = await scrollbackArchive()

    const first = manager(repositories, checkout, archive)
    const opened = first.create({ worktreeId: 'wt_1', command: launch })
    await waitUntil(() => first.read(opened.id).includes('AGENT ARGS:'), 'the agent to print its arguments')
    first.write(opened.id, 'hello\r')
    await first.shutdown()

    const reopened = await ScrollbackArchive.open(archive.directory, [opened.id])
    const second = manager(repositories, checkout, reopened)
    second.restoreSessions()
    await waitUntil(() => second.read(opened.id).includes('AGENT ARGS:'), 'the resumed agent to start')

    // Quitting kills the pane; that exit must not be read as a refusal.
    await second.shutdown()
    expect(reopened.read(opened.id)?.text).not.toContain('resume refused')
  }, 20_000)

  it('starts the agent over, showing what it printed before, when nobody ever typed into it', async () => {
    const { checkout, launch } = await fakeAgent('claude')
    const repositories = createRepositories()
    const archive = await scrollbackArchive()

    const first = manager(repositories, checkout, archive)
    // Opened and then left alone: an id reserved, nothing written under it.
    const opened = first.create({ worktreeId: 'wt_1', command: launch })
    await waitUntil(() => first.read(opened.id).includes('AGENT ARGS:'), 'the agent to print its arguments')
    const pinned = repositories.listTerminals()[0]?.agentSessionId
    expect(pinned).toBeDefined()
    await first.shutdown()

    const reopened = await ScrollbackArchive.open(archive.directory, [opened.id])
    const second = manager(repositories, checkout, reopened)
    expect(second.restoreSessions()).toEqual({ restored: 1, resumed: 0 })

    await waitUntil(
      () => second.read(opened.id).split('new shell below')[1]?.includes('--session-id') === true,
      'the agent to start over'
    )
    const shown = second.read(opened.id)
    expect(shown).toContain('nothing running')
    expect(shown).toContain('new shell below')

    // Below that line is this launch.
    const thisLaunch = shown.split('new shell below')[1] as string
    expect(thisLaunch).toContain('--session-id')
    expect(thisLaunch).not.toContain('--resume')
    expect(thisLaunch).not.toContain(pinned as string)
    expect(second.list('wt_1')[0]?.running).toBe(true)

    // The record names the conversation actually being had.
    const rewritten = repositories.listTerminals()[0]
    expect(rewritten?.agentSessionId).toBeDefined()
    expect(rewritten?.agentSessionId).not.toBe(pinned)
    expect(rewritten?.command).toContain(rewritten?.agentSessionId as string)
    expect(rewritten?.typed).not.toBe(true)

    second.write(opened.id, 'now there is something to come back to\r')
    expect(repositories.listTerminals()[0]?.typed).toBe(true)
  }, 20_000)

  /**
   * A stand-in home directory with Claude Code's store in it; the slug rule is
   * pinned in `agent-conversations.test.ts`.
   */
  async function claudeStore(): Promise<{
    evidence: (question: ConversationQuestion) => ConversationEvidence
    recordConversation: (cwd: string, sessionId: string) => Promise<void>
  }> {
    const base = await mkdtemp(path.join(os.tmpdir(), 'teamree-home-'))
    created.push(base)
    // An existing, empty store is what makes a missing file mean "absent" rather than "unknown".
    await mkdir(path.join(base, '.claude', 'projects'), { recursive: true })
    // vitest.config.ts points the store elsewhere, and whatever earlier runs left there would answer instead.
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(base, '.claude'))
    return {
      evidence: (question) => conversationOnDisk(question, base),
      recordConversation: async (cwd, sessionId) => {
        const transcript = claudeTranscriptPath(cwd, sessionId, base)
        await mkdir(path.dirname(transcript), { recursive: true })
        await writeFile(transcript, '{"type":"user","message":"hello"}\n', 'utf8')
      }
    }
  }

  // The trust gate again: a keystroke no agent heard, `typed` set, store empty.
  it('starts a fresh agent, saying why, when the store has nothing under the pinned id', async () => {
    const { checkout, launch } = await fakeAgent('claude')
    const store = await claudeStore()
    const repositories = createRepositories()
    const archive = await scrollbackArchive()

    const first = manager(repositories, checkout, archive, undefined, store.evidence)
    const opened = first.create({ worktreeId: 'wt_1', command: launch })
    await waitUntil(() => first.read(opened.id).includes('AGENT ARGS:'), 'the agent to print its arguments')
    const pinned = repositories.listTerminals()[0]?.agentSessionId
    expect(pinned).toBeDefined()

    // The keystroke at the gate.
    first.write(opened.id, '\r')
    await waitUntil(() => repositories.listTerminals()[0]?.typed === true, 'the pane to write down the keystroke')
    await first.shutdown()

    const reopened = await ScrollbackArchive.open(archive.directory, [opened.id])
    const second = manager(repositories, checkout, reopened, undefined, store.evidence)
    expect(second.restoreSessions()).toEqual({ restored: 1, resumed: 0 })

    // Below the line is this launch; the record above it does contain the old id.
    const below = (): string => second.read(opened.id).split(noConversationMark('claude'))[1] ?? ''
    await waitUntil(() => below().includes('AGENT ARGS:'), 'the fresh agent to print its arguments under that line')

    const thisLaunch = below()
    expect(thisLaunch).toContain('--session-id')
    expect(thisLaunch).not.toContain('--resume')
    expect(thisLaunch).not.toContain(pinned as string)
    expect(second.list('wt_1')[0]?.running).toBe(true)

    const rewritten = repositories.listTerminals()[0]
    expect(rewritten?.agentSessionId).toBeDefined()
    expect(rewritten?.agentSessionId).not.toBe(pinned)
    expect(rewritten?.typed).toBe(false)
  }, 20_000)

  // The conversation is on the disk, so it is resumed whatever the app watched.
  it('resumes a pane whose conversation the store has, with nothing ever typed into it', async () => {
    const { checkout, launch } = await recordingAgent('claude')
    const store = await claudeStore()
    const repositories = createRepositories()

    const first = manager(repositories, checkout, undefined, undefined, store.evidence)
    const opened = first.create({ worktreeId: 'wt_1', command: launch })
    await waitUntil(() => first.read(opened.id).includes('AGENT ARGS:'), 'the agent to print its arguments')
    const pinned = repositories.listTerminals()[0]?.agentSessionId as string
    expect(pinned).toBeDefined()
    expect(repositories.listTerminals()[0]?.typed).toBe(false)

    // A pane can be spoken to by something other than a keyboard.
    await store.recordConversation(checkout, pinned)
    await first.shutdown()

    const second = manager(repositories, checkout, undefined, undefined, store.evidence)
    expect(second.restoreSessions()).toEqual({ restored: 1, resumed: 1 })

    await waitUntil(() => second.read(opened.id).includes('AGENT ARGS:'), 'the resumed agent to print its arguments')
    const shown = second.read(opened.id)
    expect(shown).toContain(`--resume ${pinned}`)
    expect(shown).not.toContain(NOT_FOUND)
    expect(shown).not.toContain(noConversationMark('claude'))
  }, 20_000)

  // A machine that loses power has neither an exit nor a quit. These four are
  // about the pane that is still running.
  it('comes back from a crash showing what a running pane had printed', async () => {
    const { checkout } = await fakeAgent('unused')
    const repositories = createRepositories()
    const archive = await scrollbackArchive()

    const first = manager(repositories, checkout, archive, 100)
    const opened = first.create({ worktreeId: 'wt_1', command: 'echo building-still; sleep 30' })
    await waitUntil(() => first.read(opened.id).includes('building-still'), 'the command to print')
    await waitUntil(
      () => archive.read(opened.id)?.text.includes('building-still') === true,
      'a checkpoint of a running pane to reach the disk'
    )

    // No exit, no shutdown, no flush — and the record is on disk all the same.
    expect(first.list('wt_1')[0]?.running).toBe(true)

    const reopened = await ScrollbackArchive.open(archive.directory, [opened.id])
    const second = manager(repositories, checkout, reopened)
    expect(second.restoreSessions()).toEqual({ restored: 1, resumed: 0 })
    expect(second.read(opened.id)).toContain('building-still')
    expect(second.read(opened.id)).toContain('nothing running')
  }, 20_000)

  it('stops writing a pane down the moment it stops printing', async () => {
    const { checkout } = await fakeAgent('unused')
    const repositories = createRepositories()
    const archive = await scrollbackArchive()

    const first = manager(repositories, checkout, archive, 50)
    const opened = first.create({ worktreeId: 'wt_1', command: 'echo one-line; sleep 30' })
    await waitUntil(() => archive.read(opened.id) !== undefined, 'the first checkpoint')

    // Stood on from outside, so any write at all is unmistakable.
    const record = path.join(archive.directory, `${opened.id}.json`)
    await writeFile(record, 'untouched', 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 500))
    await archive.flush()

    expect(await readFile(record, 'utf8')).toBe('untouched')
  }, 20_000)

  it('keeps a running pane inside the same cap a finished one gets', async () => {
    const { checkout } = await fakeAgent('unused')
    const repositories = createRepositories()
    const archive = await scrollbackArchive()

    const first = manager(repositories, checkout, archive, 100)
    const loud = 'i=0; while [ $i -lt 20000 ]; do echo "line $i"; i=$((i+1)); done; echo done-printing; sleep 30'
    const opened = first.create({ worktreeId: 'wt_1', command: loud })
    await waitUntil(
      () => archive.read(opened.id)?.text.includes('done-printing') === true,
      'a checkpoint taken after the pane had printed past the cap'
    )

    const kept = archive.read(opened.id)
    expect(Buffer.byteLength(kept?.text ?? '', 'utf8')).toBeLessThanOrEqual(MAX_RECORD_BYTES)
    expect(kept?.text).not.toContain('line 0\r\n')
    expect(first.list('wt_1')[0]?.running).toBe(true)
  }, 30_000)

  // Two writers, one path: the armed checkpoint and the quit.
  it('quits on a pane that is checkpointing without tearing its record', async () => {
    const { checkout } = await fakeAgent('unused')
    const repositories = createRepositories()
    const archive = await scrollbackArchive()

    const first = manager(repositories, checkout, archive, 10)
    const noisy = 'while true; do echo tick; sleep 0.05; done'
    const opened = first.create({ worktreeId: 'wt_1', command: noisy })
    await waitUntil(() => archive.read(opened.id)?.text.includes('tick') === true, 'checkpoints to be happening')

    await first.shutdown()
    await archive.flush()

    expect(archive.read(opened.id)?.text).toContain('tick')
    expect(await readdir(archive.directory)).toEqual([`${opened.id}.json`])
  }, 20_000)

  it('takes a pane record with the pane when the user closes it', async () => {
    const { checkout } = await fakeAgent('unused')
    const repositories = createRepositories()
    const archive = await scrollbackArchive()

    const first = manager(repositories, checkout, archive)
    const opened = first.create({ worktreeId: 'wt_1', command: 'echo hello-from-before' })
    await waitUntil(() => first.read(opened.id).includes('hello-from-before'), 'the command to print')
    await waitUntil(() => archive.read(opened.id) !== undefined, 'the record to be written at the exit')

    await first.close(opened.id)
    await archive.flush()
    expect(archive.read(opened.id)).toBeUndefined()
  }, 20_000)

  // A checkpoint must not be a way for a closed pane to get back into the directory.
  it('does not put back the record of a pane closed while it was printing', async () => {
    const { checkout } = await fakeAgent('unused')
    const repositories = createRepositories()
    const archive = await scrollbackArchive()

    const first = manager(repositories, checkout, archive, 100)
    const opened = first.create({ worktreeId: 'wt_1', command: 'while true; do echo tick; sleep 0.05; done' })
    await waitUntil(() => archive.read(opened.id) !== undefined, 'a checkpoint to have written the record once')

    // Closed while still printing: a record on disk and a checkpoint armed after it.
    await first.close(opened.id)
    await new Promise((resolve) => setTimeout(resolve, 600))
    await archive.flush()

    expect(archive.read(opened.id)).toBeUndefined()
    expect(await readdir(archive.directory)).toEqual([])
  }, 20_000)

  it('opens a pane with nothing above the prompt when its record cannot be read', async () => {
    const { checkout } = await fakeAgent('unused')
    const repositories = createRepositories()
    const archive = await scrollbackArchive()

    const first = manager(repositories, checkout, archive)
    const opened = first.create({ worktreeId: 'wt_1', command: 'echo hello-from-before' })
    await waitUntil(() => first.read(opened.id).includes('hello-from-before'), 'the command to print')
    await first.shutdown()

    await writeFile(path.join(archive.directory, `${opened.id}.json`), '{ half a fi', 'utf8')

    const reopened = await ScrollbackArchive.open(archive.directory, [opened.id], { onProblem: () => {} })
    const second = manager(repositories, checkout, reopened)
    // An unreadable transcript costs a transcript, never a pane.
    expect(second.restoreSessions()).toEqual({ restored: 1, resumed: 0 })
    expect(second.read(opened.id)).not.toContain('nothing running')
  }, 20_000)

  it('cannot be made to act by anything the last session printed', async () => {
    const { checkout } = await fakeAgent('unused')
    const repositories = createRepositories()
    const archive = await scrollbackArchive()

    // A cursor-position report, a clipboard write and a window rename. Replayed,
    // the report's answer would be typed into the new shell.
    const hostile = String.raw`printf '\033]0;renamed\007\033]52;c;ZXZpbA==\007\033[6ndone\n'`
    const first = manager(repositories, checkout, archive)
    const opened = first.create({ worktreeId: 'wt_1', command: hostile })
    await waitUntil(() => first.read(opened.id).includes('done'), 'the command to print')
    await first.shutdown()

    const reopened = await ScrollbackArchive.open(archive.directory, [opened.id])
    const second = manager(repositories, checkout, reopened)
    second.restoreSessions()

    const shown = second.read(opened.id)
    const boundary = shown.indexOf('new shell below')
    expect(boundary).toBeGreaterThan(-1)
    expect(shown).toContain('done')
    expect(shown).not.toContain('renamed')
    expect(shown).not.toContain('ZXZpbA==')
    expect(shown.slice(0, boundary)).toMatch(INERT_RECORD)
  }, 20_000)
})
