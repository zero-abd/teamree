import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Layout } from '../../shared/entities'
import type { TerminalEvent } from '../../shared/methods'
import { MAX_RECORD_BYTES, ScrollbackArchive } from '../store/scrollbackArchive'
import { canSpawnPty, waitUntil } from './pty-test-support'
import { INERT_RECORD } from './scrollbackRecord'
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
    const launch = restoreLaunch(record({ command: 'claude', agent: 'claude', agentSessionId: 'abc', typed: true }))
    expect(launch.command).toBe('claude --resume abc')
    expect(launch.resumed).toBe(true)
  })

  // Worked out here rather than at the moment it is needed, because the moment
  // it is needed is an agent that has just exited and a pane with nothing in
  // it. Everything this command is built from lives on the record.
  it('carries a way to start the agent over if that resume is refused', () => {
    const launch = restoreLaunch(
      record({ command: 'claude --session-id old-zzz', agent: 'claude', agentSessionId: 'old-zzz', typed: true })
    )
    expect(launch.command).toBe('claude --resume old-zzz')
    // A fresh id, not the refused one: an id the agent has already declined to
    // find is not an id to hand it again.
    expect(launch.fallback?.agentSessionId).toBeDefined()
    expect(launch.fallback?.agentSessionId).not.toBe('old-zzz')
    expect(launch.fallback?.command).toContain(`--session-id ${launch.fallback?.agentSessionId as string}`)
    expect(launch.fallback?.command).not.toContain('old-zzz')
    expect(launch.fallback?.command).not.toContain('--resume')
  })

  // Nothing of ours is on this line, so there is nothing of ours to replace,
  // and starting the agent over means running exactly what the pane ran.
  it('starts a session-less agent over with the command it was launched with', () => {
    const launch = restoreLaunch(record({ command: 'codex', agent: 'codex', typed: true }))
    expect(launch.command).toBe('codex resume --last')
    expect(launch.resumed).toBe(true)
    expect(launch.fallback).toEqual({ command: 'codex' })
  })

  // The failure the user actually hits, and the reason this branch exists. An
  // id is reserved when the agent starts; the conversation under it is written
  // when the agent has one to write. A pane opened and then left alone gave it
  // nothing, so that id names nothing on any disk anywhere, and asking to
  // resume it gets a refusal from the CLI every time for the life of the
  // record. Starting the agent over is the only thing that can work.
  it('starts the agent over for a pane this app knows nobody typed into', () => {
    // A sentinel with letters outside the hex alphabet on purpose. A fresh id
    // is a v4 UUID, which is hex and dashes, so an old id spelled in hex can
    // turn up inside a new one by chance — about one run in a couple of hundred
    // for three characters, which is a test that fails for nobody's reason.
    const launch = restoreLaunch(
      record({ command: 'claude --session-id old-zzz', agent: 'claude', agentSessionId: 'old-zzz', typed: false })
    )

    expect(launch.resumed).toBe(false)
    // The old id is gone from the command rather than sitting beside the new
    // one, where the CLI would have to choose between them.
    expect(launch.command).not.toContain('old-zzz')
    expect(launch.command).not.toContain('--resume')
    expect(launch.command).toContain('--session-id')
    // And the record has to be rewritten to the id that actually ran, or the
    // next launch resumes a conversation that this one did not have.
    expect(launch.repinned?.command).toBe(launch.command)
    expect(launch.repinned?.agentSessionId).toBeDefined()
    expect(launch.command).toContain(launch.repinned?.agentSessionId as string)
  })

  // The same rule has to hold for an agent whose CLI never let us choose an id.
  // Its "resume the last session here" is worse than useless for a pane that
  // had no session: it would pick up whatever else was run in this directory.
  it('starts an agent that mints its own ids over too, with nothing pinned', () => {
    expect(restoreLaunch(record({ command: 'codex', agent: 'codex', typed: false }))).toEqual({
      command: 'codex',
      resumed: false,
      repinned: { command: 'codex' }
    })
  })

  // The upgrade case, and the one worth being loudest about. Every workspace
  // file already on disk was written before this field existed, and most of the
  // panes in them have real conversations behind them. Absent is unknown, not
  // no — reading it as no would take the resume away from every pane in the
  // world exactly once, on the launch after an upgrade, which is a worse
  // version of the bug this whole change is about.
  it('still tries the resume for a record written before any of this existed', () => {
    const pinned = restoreLaunch(record({ command: 'claude --session-id abc', agent: 'claude', agentSessionId: 'abc' }))
    expect(pinned.command).toBe('claude --resume abc')
    expect(pinned.resumed).toBe(true)
    const latest = restoreLaunch(record({ command: 'codex', agent: 'codex' }))
    expect(latest.command).toBe('codex resume --last')
    expect(latest.resumed).toBe(true)
  })

  // Failing open is right everywhere else in the rewriting module: the worst a
  // stray appended selector does is make a CLI complain. It is wrong here,
  // because this branch also writes down the id it believes is on the line — so
  // an append would leave the dead one in place, add a second, and record a
  // third state that matches neither.
  it('opens a plain shell rather than rewrite a command it could not read', () => {
    for (const command of [
      'codex | tee log',
      'ssh host claude --session-id old-zzz',
      "claude --session-id 'unclosed"
    ]) {
      const agent = command.includes('codex') ? 'codex' : 'claude'
      expect(restoreLaunch(record({ command, agent, typed: false })), command).toEqual({ resumed: false })
    }
  })

  // A session the caller named themselves is not ours to replace. Nothing here
  // pinned it, so nothing here knows better than they do about whether it is
  // there — and `pinSessionCommand` already steps back from this same case
  // rather than argue with it.
  it('leaves a session somebody chose by hand alone, typed into or not', () => {
    expect(restoreLaunch(record({ command: 'claude --resume chosen-by-hand', agent: 'claude' }))).toEqual({
      command: 'claude --resume chosen-by-hand',
      resumed: true
    })
    expect(restoreLaunch(record({ command: 'codex resume chosen-by-hand', agent: 'codex' }))).toEqual({
      command: 'codex resume chosen-by-hand',
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
    expect(restoreLaunch(record({ command: 'gemini', agent: 'gemini', typed: true }))).toEqual({ resumed: false })
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

/**
 * Whether a file a pane's command writes has got as far as saying `want`.
 *
 * Absent reads as "not yet" rather than as an error: a shell redirecting into a
 * path creates the file before it writes anything into it, so both "there is no
 * file" and "there is an empty one" are the same moment — the command has not
 * finished — and a caller waiting for it should see one answer for both.
 */
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
    await Promise.all(managers.splice(0).map((manager) => manager.shutdown()))
    await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  /** What the stand-in agent says when its conversation has been taken away. */
  const REFUSAL = 'that conversation is not here any more'

  /**
   * A stand-in agent that prints the arguments it was given. The real thing is
   * not installed anywhere this suite runs, and what is under test is which
   * command line gets built — which this shows directly.
   *
   * It also does the one other thing a real agent does that this file has to be
   * able to provoke: refuse. `loseTheConversation()` leaves a marker, and from
   * then on the script refuses any launch that asks it to *resume* — printing a
   * line and exiting non-zero, the way every one of these CLIs does when it is
   * asked for a session that is not on the disk. A launch that asks for nothing
   * in particular still starts normally, because that is the whole shape of the
   * thing: the conversation is gone, the agent is not. Modelled as something
   * that happens *between* two launches on purpose, because that is what it is
   * — the conversation was there, and then it was deleted, or it expired, or
   * the worktree was opened on another machine.
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
    // Windows decides what is executable by the extension, which the app
    // strips off again before matching an agent by name; unix decides by the
    // bit, and by the interpreter on the first line.
    const windows = process.platform === 'win32'
    const binary = path.join(bin, windows ? `${name}.cmd` : name)
    const gone = path.join(base, 'conversation-gone')
    // It stays running, the way a real agent does. A stub that exits at once
    // would have the tests typing into a closed pty, which node-pty logs about
    // and which is not what any of them are here to check.
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
    // Quoted, because a Windows path is mostly backslashes and both readers of
    // this string — the shell that runs it, and the tokenizer that has to find
    // the agent's name in command position — would take those for escapes.
    return { checkout, launch: `"${binary}"`, loseTheConversation: () => writeFile(gone, '', 'utf8') }
  }

  /** What a CLI says when it is asked for a conversation it does not have. */
  const NOT_FOUND = 'No conversation found with session ID'

  /**
   * A stand-in agent that keeps its conversation on disk, the way the real ones
   * do — and stops keeping it when it is told it is somebody else's subprocess.
   *
   * This is the shape of the failure the app was shipping. Every agent here
   * writes its conversation down under the id it was started with, and a resume
   * can only find what was written; so anything that stops the writing is
   * invisible for as long as the agent is running and fatal the moment it is
   * asked to come back. Claude Code stops writing when it inherits the marker
   * that says it is running underneath another session of its own, which is
   * exactly what teamree handed it when the app was started from an agent's
   * pane. The pane worked all day and came back holding "No conversation found
   * with session ID" the next morning.
   *
   * So this script does the same two things in the same order: record the
   * conversation unless the marker says not to, and refuse a resume when there
   * is no record. It does not read the id — one conversation per fake is all
   * any of these tests needs — which keeps it to the same handful of lines the
   * shells above and below this one are written in.
   */
  async function recordingAgent(name: string): Promise<{ checkout: string; launch: string; marker: string }> {
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
    return { checkout, launch: `"${binary}"`, marker }
  }

  function manager(
    repositories: LayoutRepository & SessionRepository,
    checkout: string,
    scrollback?: ScrollbackArchive,
    /** Shortened from fifteen seconds, so a test can watch a checkpoint happen. */
    checkpointIntervalMs?: number
  ): TerminalSessionManager {
    const created = new TerminalSessionManager({
      resolveWorktreeCwd: (worktreeId) => (worktreeId === 'wt_1' ? checkout : undefined),
      layouts: repositories,
      sessions: repositories,
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

    // Somebody says something to it. Without this there is no conversation
    // under that id on any agent's disk, and nothing to come back to.
    first.write(opened.id, 'hello\r')

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

  // The defect this app shipped with, and the one users felt: a pane that had
  // been talking to Claude Code all day came back the next morning saying "No
  // conversation found with session ID" and nothing else. Nothing about the
  // restore was wrong. The conversation had never been written down, because
  // the app had been started from inside somebody's own agent session and
  // handed every pane the marker that says "you are a subprocess of a
  // conversation already in progress" — and an agent that believes that stops
  // keeping a transcript.
  //
  // What makes this a bug in this app rather than in the CLI is whose fact the
  // marker is. It describes the process that launched teamree. A pane is not
  // that process's subprocess in any sense that matters: it is a session of the
  // user's own, in a checkout of their own, and it is the app's job to start it
  // as one.
  it('does not hand a pane the session markers of the agent that started the app', async () => {
    const { checkout, launch, marker } = await recordingAgent('claude')
    const repositories = createRepositories()
    const inherited = process.env[marker]
    // teamree started by `npm run dev` typed into an agent's own pane, which is
    // how most of its own development happens and how this was found.
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

      // The whole assertion is on the line the agent was actually handed and on
      // the id the record actually holds: the conversation was kept under the
      // id this app pinned, and the resume found it there.
      const shown = second.read(opened.id)
      expect(shown).toContain(`--resume ${pinned as string}`)
      expect(shown).not.toContain(NOT_FOUND)
      expect(second.list('wt_1')[0]?.running).toBe(true)
    } finally {
      if (inherited === undefined) delete process.env[marker]
      else process.env[marker] = inherited
    }
  }, 20_000)

  // A name nobody can see after a restart is a name nobody typed. Everything
  // else on the record describes a process that has died; this is the only
  // thing on it the user put there, and it is the one they would miss.
  it('brings a pane back under the name it was given, rename included', async () => {
    const { checkout, launch } = await fakeAgent('claude')
    const repositories = createRepositories()

    const first = manager(repositories, checkout)
    // One pane named as the composer names it — what was typed about the task,
    // on the pane running the agent that was given it — and never touched
    // again. The other renamed afterwards, which is the same person saying it
    // a second time having seen the pane. Both have to come back.
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

    // The pane is back, in the right directory, and the command did not run
    // a second time — the file it appends to still has one line.
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
    // A pane opened now is not a restored one, whatever else is true of it.
    expect(first.list('wt_1').every((terminal) => terminal.restored === undefined)).toBe(true)
    // Spoken to, so there is a conversation for the next launch to resume.
    first.write(agentPane.id, 'hello\r')
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

    // A pane of a worktree removed while the app was closed. No later start
    // will do any better: the checkout it names is gone for good, so a record
    // left here is one workspace.json carries for the life of the installation
    // — a set of them per worktree ever removed.
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

  it('comes back showing what the pane printed, with the new shell under a line that says so', async () => {
    const { checkout } = await fakeAgent('unused')
    const marker = path.join(checkout, 'ran.txt')
    const repositories = createRepositories()
    const archive = await scrollbackArchive()

    const first = manager(repositories, checkout, archive)
    const opened = first.create({ worktreeId: 'wt_1', command: `echo hello-from-before; echo ran >> ${marker}` })
    await waitUntil(() => first.read(opened.id).includes('hello-from-before'), 'the command to print')
    // The first of the command's two statements printing is not the command
    // finishing, and the assertion at the end of this test is about the file
    // the second one writes. Waiting only for the print left the shutdown
    // racing `echo ran >> …`: on an idle machine the write always won, and on a
    // machine with anything else on it the pane was torn down between the
    // redirection creating the file and the byte reaching it — so the test
    // ended up reading an empty marker and reporting it as the restore having
    // eaten the line. Waiting for the file to say what it is for waits for the
    // thing the rest of this test is about instead of for a moment near it.
    await waitUntil(() => markerSays(marker, 'ran'), 'the command to finish writing its marker')
    await first.shutdown()

    const reopened = await ScrollbackArchive.open(archive.directory, [opened.id])
    const second = manager(repositories, checkout, reopened)
    expect(second.restoreSessions()).toEqual({ restored: 1, resumed: 0 })

    const shown = second.read(opened.id)
    expect(shown).toContain('hello-from-before')
    // And it is unmistakably a record rather than a process: what it is, said
    // above it, and where this run begins, said below it.
    expect(shown).toContain('nothing in it is running')
    expect(shown.indexOf('hello-from-before')).toBeLessThan(shown.indexOf('a new shell starts below'))
    expect(second.list('wt_1')[0]?.restored).toBe('shell')

    // The output came back; the command did not run again. Restoring a
    // transcript must never be a second deploy.
    //
    // Proved by asking the restored shell rather than by reading the marker at
    // whatever moment the test happened to get here. A probe is typed into the
    // pane and waited for, and a shell that had been handed the old command
    // would have run it before it could ever answer this one — so a marker
    // still one line long once the answer is on the screen is a statement about
    // what that shell did and in what order, which no amount of load can move.
    // Reading the file straight after the restore would instead have been a
    // statement about how far a replay had got in the meantime.
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

    // The agent is about to print the conversation itself, out of its own
    // store. A record above it would be the same exchange twice.
    expect(second.read(opened.id)).not.toContain('nothing in it is running')
    // Kept all the same: whether a pane can resume is decided at each launch,
    // and an agent that stops being resumable still has a pane to come back to.
    expect(reopened.read(opened.id)?.text).toContain('AGENT ARGS:')

    // And it survives this launch too. The pane was handed the record and is
    // holding it rather than showing it, so what gets written down on the way
    // out still has last launch's output in it. This is the regression that
    // cost a real transcript: withholding used to mean not being given it at
    // all, and the next quit wrote a one-line refusal over the top.
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

    // Between the two launches the conversation goes: deleted, expired, or on
    // a machine this one is not.
    await loseTheConversation()

    const reopened = await ScrollbackArchive.open(archive.directory, [opened.id])
    const second = manager(repositories, checkout, reopened)
    // Nothing here can know in advance, so the pane is launched believing it
    // will resume — this count is a count of attempts.
    expect(second.restoreSessions()).toEqual({ restored: 1, resumed: 1 })

    // A window that was already open when the agent gave up. Attached before
    // the exit, which is the case that reads the pane through the stream rather
    // than through a read on mount.
    const streamed: TerminalEvent[] = []
    second.attachStream(opened.id, { emit: (event) => streamed.push(event), close: () => {} })

    await waitUntil(() => second.read(opened.id).includes('nothing was resumed'), 'the pane to say what happened')
    const shown = second.read(opened.id)

    // The agent's own reason, which is the only part of this the agent knows.
    expect(shown).toContain(REFUSAL)
    // And then the app's, because a refusal from a CLI nobody typed is not an
    // explanation to somebody who just reopened their work.
    expect(shown).toContain('this pane came back to pick a conversation up')
    expect(shown).toContain('exited with code 1')
    expect(shown).toContain('deleted, expired, or recorded on another machine')

    // The record is let go of in the same moment, so the output that was being
    // held back for a conversation that never arrived is on the screen instead
    // — above the attempt, under a line that says what it is.
    expect(shown).toContain('AGENT ARGS:')
    expect(shown).toContain('nothing in it is running')
    expect(shown).toContain('the attempt to resume this conversation begins below')
    expect(shown.indexOf('AGENT ARGS:')).toBeLessThan(shown.indexOf(REFUSAL))

    // And the badge stops claiming otherwise. A pane reading "resumed" beside
    // "exited 1" is the app asserting something it can see is not true.
    expect(second.list('wt_1')[0]?.restored).toBeUndefined()

    // Then the pane goes on being a pane. A conversation being gone is not a
    // reason for the pane to be gone too — what was wanted was an agent in this
    // checkout, and the one the person would have opened by hand is the one
    // that starts. The note above says so rather than telling them to do it.
    expect(shown).toContain('A fresh agent is starting below')
    const fresh = repositories.listTerminals()[0]
    await waitUntil(
      () => second.read(opened.id).includes(`--session-id ${fresh?.agentSessionId as string}`),
      'a fresh agent to start in the pane'
    )
    expect(second.list('wt_1')[0]?.running).toBe(true)
    expect(second.list('wt_1')[0]?.exitCode).toBeUndefined()

    // A subscriber attached at the moment it happened is told the same things,
    // and told the old output too. Releasing the record only changes what a
    // read answers, and a view that was already open reads once when it mounts
    // — so a note saying the output is above, with nothing ever sent, would be
    // the same false claim in a new place.
    expect(outputOf(streamed)).toContain('nothing was resumed')
    expect(outputOf(streamed)).toContain('AGENT ARGS:')
    // And no exit, because the pane did not exit: the agent in it was replaced.
    expect(streamed.some((event) => event.type === 'exit')).toBe(false)

    // The record now names the conversation that is actually being had. The old
    // id is gone from it — it has been shown not to be there — and nobody has
    // said anything to the new one yet, so the next launch starts rather than
    // resumes. Both halves, or the same refusal comes back on every launch for
    // the life of the record.
    expect(fresh?.agentSessionId).toBeDefined()
    expect(fresh?.command).toContain(`--session-id ${fresh?.agentSessionId as string}`)
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

    // The launch that is refused, and recovers from it in the pane.
    const second = manager(repositories, checkout, await ScrollbackArchive.open(archive.directory, [opened.id]))
    second.restoreSessions()
    await waitUntil(() => second.read(opened.id).includes('nothing was resumed'), 'the pane to say what happened')
    await second.shutdown()

    // The one after it. Nothing has changed on disk except what the app wrote
    // down about the failure, and that is enough: the pane stops asking for a
    // conversation that has been shown not to be there and starts the agent
    // instead. Without this the same refusal comes back on every launch for the
    // life of the record, with another copy of the explanation stacked into the
    // pane's own output each time.
    const third = manager(repositories, checkout, await ScrollbackArchive.open(archive.directory, [opened.id]))
    expect(third.restoreSessions()).toEqual({ restored: 1, resumed: 0 })
    await waitUntil(
      () => third.read(opened.id).split('a new shell starts below')[1]?.includes('AGENT ARGS:') === true,
      'the agent to start over'
    )
    expect(third.list('wt_1')[0]?.running).toBe(true)

    // Everything below the record line is this launch, and it is an agent
    // starting rather than an agent refusing. Above it, the failed launch is
    // still there in the record — the history is kept, it just stops repeating.
    const thisLaunch = third.read(opened.id).split('a new shell starts below')[1] as string
    expect(thisLaunch).toContain('--session-id')
    expect(thisLaunch).not.toContain(REFUSAL)
    // And the id that was refused is nowhere on this launch's command line. It
    // has been shown not to exist; asking a third time would be the app failing
    // the same way on purpose.
    expect(thisLaunch).not.toContain(lost as string)
    expect(third.read(opened.id)).toContain(REFUSAL)
  }, 30_000)

  // An agent asked to do one thing and print the answer resumes, works, and
  // leaves with nothing wrong — and it is the same executable in a different
  // mode, so nothing upstream can tell it apart from the interactive one. A
  // note whose every clause is false is exactly what this change exists to
  // stop, so the clean exit is the thing that decides it.
  it('says nothing about an agent that resumed, did its work and exited cleanly', async () => {
    const { checkout } = await fakeAgent('unused')
    const repositories = createRepositories()
    const archive = await scrollbackArchive()

    const first = manager(repositories, checkout, archive)
    const opened = first.create({ worktreeId: 'wt_1', command: 'echo one-shot answer' })
    await waitUntil(() => first.read(opened.id).includes('one-shot answer'), 'the command to print')
    await first.shutdown()

    // Rewritten as the agent pane it is standing in for: typed into, so it
    // resumes, and its command is one that prints and leaves with zero.
    const stored = repositories.listTerminals()[0] as TerminalRecord
    repositories.putTerminal({ ...stored, agent: 'claude', agentSessionId: 'a-real-conversation', typed: true })

    const second = manager(repositories, checkout, await ScrollbackArchive.open(archive.directory, [opened.id]))
    second.restoreSessions()
    await waitUntil(() => second.list('wt_1')[0]?.running === false, 'the one-shot to finish')

    expect(second.read(opened.id)).not.toContain('nothing was resumed')
    // The badge stands, because it is true: that pane did resume.
    expect(second.list('wt_1')[0]?.restored).toBe('agent')
    // And nothing was written down against it, so the next launch resumes again
    // rather than starting a conversation over that was never in trouble.
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

    // The pane resumed fine and is running. Quitting kills it, and that exit
    // must not be read as the agent having refused anything — the app is what
    // ended it, and what is written down on the way out is read back on the
    // next launch and shown to somebody.
    await second.shutdown()
    expect(reopened.read(opened.id)?.text).not.toContain('nothing was resumed')
  }, 20_000)

  it('starts the agent over, showing what it printed before, when nobody ever typed into it', async () => {
    const { checkout, launch } = await fakeAgent('claude')
    const repositories = createRepositories()
    const archive = await scrollbackArchive()

    const first = manager(repositories, checkout, archive)
    // Opened and then left alone, which is the pane this whole branch is for:
    // an id was reserved for it, and no agent anywhere wrote a conversation
    // under that id, because there was never anything to write.
    const opened = first.create({ worktreeId: 'wt_1', command: launch })
    await waitUntil(() => first.read(opened.id).includes('AGENT ARGS:'), 'the agent to print its arguments')
    const pinned = repositories.listTerminals()[0]?.agentSessionId
    expect(pinned).toBeDefined()
    await first.shutdown()

    const reopened = await ScrollbackArchive.open(archive.directory, [opened.id])
    const second = manager(repositories, checkout, reopened)
    // Not resumed, and honestly counted as not resumed.
    expect(second.restoreSessions()).toEqual({ restored: 1, resumed: 0 })

    await waitUntil(
      () => second.read(opened.id).split('a new shell starts below')[1]?.includes('--session-id') === true,
      'the agent to start over'
    )
    const shown = second.read(opened.id)
    // A pane that is starting fresh is an ordinary restored pane in every other
    // respect, so it opens on what it printed last time, framed as a record.
    expect(shown).toContain('nothing in it is running')
    expect(shown).toContain('a new shell starts below')

    // Everything below that line is this launch: the agent running, not
    // refusing, with no resume asked for and the id that names nothing gone
    // from the command line.
    const thisLaunch = shown.split('a new shell starts below')[1] as string
    expect(thisLaunch).toContain('--session-id')
    expect(thisLaunch).not.toContain('--resume')
    expect(thisLaunch).not.toContain(pinned as string)
    expect(second.list('wt_1')[0]?.running).toBe(true)

    // And the record now names the conversation that is actually being had, or
    // the next launch resumes one this launch did not have.
    const rewritten = repositories.listTerminals()[0]
    expect(rewritten?.agentSessionId).toBeDefined()
    expect(rewritten?.agentSessionId).not.toBe(pinned)
    expect(rewritten?.command).toContain(rewritten?.agentSessionId as string)
    expect(rewritten?.typed).not.toBe(true)

    // Typing into it is what makes the next restart a resume.
    second.write(opened.id, 'now there is something to come back to\r')
    expect(repositories.listTerminals()[0]?.typed).toBe(true)
  }, 20_000)

  // The exit and the quit are both endings, and a machine that loses power has
  // neither. These four are about the pane that is still running.
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

    // Nothing ended. No exit event, no shutdown, no flush — the pane is still
    // running its command, and the record of it is on disk all the same, which
    // is the whole of the difference between losing a forty-minute build to a
    // power cut and not.
    expect(first.list('wt_1')[0]?.running).toBe(true)

    const reopened = await ScrollbackArchive.open(archive.directory, [opened.id])
    const second = manager(repositories, checkout, reopened)
    expect(second.restoreSessions()).toEqual({ restored: 1, resumed: 0 })
    expect(second.read(opened.id)).toContain('building-still')
    expect(second.read(opened.id)).toContain('nothing in it is running')
  }, 20_000)

  it('stops writing a pane down the moment it stops printing', async () => {
    const { checkout } = await fakeAgent('unused')
    const repositories = createRepositories()
    const archive = await scrollbackArchive()

    const first = manager(repositories, checkout, archive, 50)
    const opened = first.create({ worktreeId: 'wt_1', command: 'echo one-line; sleep 30' })
    await waitUntil(() => archive.read(opened.id) !== undefined, 'the first checkpoint')

    // Stood on from outside, so any write at all is unmistakable. A pane
    // waiting at a prompt is most panes most of the time, and it has to cost
    // nothing: no write, and no timer waiting to make one.
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

  // Two writers, one path: the checkpoint that the last chunk of output armed,
  // and the quit writing every pane on its way out.
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

    // One whole record, readable, and nothing half-written left beside it.
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

  // The directory is the panes a person has open multiplied by one cap, and a
  // checkpoint must not be a way for a pane they closed to get back into it.
  it('does not put back the record of a pane closed while it was printing', async () => {
    const { checkout } = await fakeAgent('unused')
    const repositories = createRepositories()
    const archive = await scrollbackArchive()

    const first = manager(repositories, checkout, archive, 100)
    const opened = first.create({ worktreeId: 'wt_1', command: 'while true; do echo tick; sleep 0.05; done' })
    await waitUntil(() => archive.read(opened.id) !== undefined, 'a checkpoint to have written the record once')

    // Closed while it is still printing, so there is a record on disk and a
    // checkpoint armed by the chunk that arrived after it.
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
    // The pane opens. That is the whole point: an unreadable transcript costs a
    // transcript, never a pane.
    expect(second.restoreSessions()).toEqual({ restored: 1, resumed: 0 })
    expect(second.read(opened.id)).not.toContain('nothing in it is running')
  }, 20_000)

  it('cannot be made to act by anything the last session printed', async () => {
    const { checkout } = await fakeAgent('unused')
    const repositories = createRepositories()
    const archive = await scrollbackArchive()

    // A cursor-position report, a clipboard write and a window rename, printed
    // by whatever the pane was running. Live, the first was answered by the
    // emulator to the program that asked. Replayed, there is no such program —
    // only a new shell that would be typed into.
    const hostile = String.raw`printf '\033]0;renamed\007\033]52;c;ZXZpbA==\007\033[6ndone\n'`
    const first = manager(repositories, checkout, archive)
    const opened = first.create({ worktreeId: 'wt_1', command: hostile })
    await waitUntil(() => first.read(opened.id).includes('done'), 'the command to print')
    await first.shutdown()

    const reopened = await ScrollbackArchive.open(archive.directory, [opened.id])
    const second = manager(repositories, checkout, reopened)
    second.restoreSessions()

    const shown = second.read(opened.id)
    const boundary = shown.indexOf('a new shell starts below')
    expect(boundary).toBeGreaterThan(-1)
    expect(shown).toContain('done')
    expect(shown).not.toContain('renamed')
    expect(shown).not.toContain('ZXZpbA==')
    // Everything down to the boundary is text and colour and nothing else; what
    // is below it is this session's own shell, live and unchanged.
    expect(shown.slice(0, boundary)).toMatch(INERT_RECORD)
  }, 20_000)
})
