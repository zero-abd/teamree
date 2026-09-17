import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Layout } from '../../shared/entities'
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
    expect(restoreLaunch(record({ command: 'claude', agent: 'claude', agentSessionId: 'abc', typed: true }))).toEqual({
      command: 'claude --resume abc',
      resumed: true
    })
  })

  it('asks for the latest session here when no id was ever captured', () => {
    expect(restoreLaunch(record({ command: 'codex', agent: 'codex', typed: true }))).toEqual({
      command: 'codex resume --last',
      resumed: true
    })
  })

  // The failure the user actually hits, and the reason this branch exists. An
  // id is reserved when the agent starts; the conversation under it is written
  // when the agent has one to write. A pane opened and then left alone gave it
  // nothing, so that id names nothing on any disk anywhere, and asking to
  // resume it gets a refusal from the CLI every time for the life of the
  // record. Starting the agent over is the only thing that can work.
  it('starts the agent over for a pane nobody ever typed into', () => {
    const launch = restoreLaunch(record({ command: 'claude --session-id abc', agent: 'claude', agentSessionId: 'abc' }))

    expect(launch.resumed).toBe(false)
    // The old id is gone from the command rather than sitting beside the new
    // one, where the CLI would have to choose between them.
    expect(launch.command).not.toContain('abc')
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
    expect(restoreLaunch(record({ command: 'codex', agent: 'codex' }))).toEqual({
      command: 'codex',
      resumed: false,
      repinned: { command: 'codex' }
    })
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
   * able to provoke: refuse. `loseTheConversation()` leaves a marker the script
   * checks on startup, and from then on it prints a refusal and exits the way
   * every one of these CLIs does when it is asked for a session that is not on
   * the disk. Modelled as something that happens *between* two launches on
   * purpose, because that is what it is — the conversation was there, and then
   * it was deleted, or expired, or the worktree was opened on another machine.
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
        `@echo off\r\nif exist "${gone}" (\r\n echo ${REFUSAL}\r\n exit /b 1\r\n)\r\n` +
          'echo AGENT ARGS: %*\r\nping -n 31 127.0.0.1 >nul\r\n',
        'utf8'
      )
    } else {
      await writeFile(
        binary,
        `#!/bin/sh\nif [ -f "${gone}" ]; then\n  echo "${REFUSAL}"\n  exit 1\nfi\n` +
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
    const { readFile } = await import('node:fs/promises')
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

  it('says so in the pane when the conversation it came back for is gone', async () => {
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
    expect(second.list('wt_1')[0]?.running).toBe(false)
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
