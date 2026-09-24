import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TerminalEvent } from '../../shared/methods'
import { ErrorCode } from '../../shared/protocol'
import { isProcessAlive } from './process-tree'
import { EXITED_RETENTION_BYTES, PtySession, REDRAW_AFTER_RESIZE_MS, RESUME_WINDOW_MS } from './pty-session'
import type { PtySessionInit } from './pty-session'
import { canSpawnPty, waitUntil } from './pty-test-support'
import { isTerminalServiceError } from './service-error'
import { SHELL_UNRUNNABLE } from './shell-environment'

// Real PTYs, no mocks: the interesting failures are in the native layer. POSIX
// only: every command below is POSIX shell, so this skips on Windows.
const describePty = process.platform !== 'win32' && canSpawnPty() ? describe : describe.skip
const TEST_TIMEOUT_MS = 20_000

const started: PtySession[] = []

function start(overrides: Partial<PtySessionInit> = {}): PtySession {
  const session = PtySession.start({
    id: `term_${started.length}`,
    worktreeId: 'wt_test',
    cwd: process.cwd(),
    shell: '/bin/sh',
    cols: 80,
    rows: 24,
    ...overrides
  })
  started.push(session)
  return session
}

function collect(session: PtySession): TerminalEvent[] {
  const events: TerminalEvent[] = []
  session.on((event) => events.push(event))
  return events
}

const outputOf = (events: TerminalEvent[]): string =>
  events
    .filter((event): event is Extract<TerminalEvent, { type: 'data' }> => event.type === 'data')
    .map((event) => event.data)
    .join('')

afterEach(async () => {
  await Promise.all(started.splice(0).map((session) => session.close()))
})

describePty('PtySession', () => {
  it('says the shell could not be started, rather than opening a pane that vanishes', () => {
    const missing = path.join(os.tmpdir(), 'teamree-no-such-shell')

    let thrown: unknown
    try {
      // Windows refuses in spawn; POSIX forks fine and the exec fails in the child.
      start({ shell: missing, command: 'echo never' })
    } catch (error) {
      thrown = error
    }

    expect(isTerminalServiceError(thrown)).toBe(true)
    expect(isTerminalServiceError(thrown) ? thrown.code : undefined).toBe(ErrorCode.TerminalFailed)
    expect((thrown as Error).message).toBe(`failed to start ${missing}: ${SHELL_UNRUNNABLE}`)
  })

  it(
    'spawns a command and captures its output',
    async () => {
      const session = start({ command: 'echo hello-from-pty' })
      const events = collect(session)

      await waitUntil(() => outputOf(events).includes('hello-from-pty'), 'command output')
      expect(session.read()).toContain('hello-from-pty')
      expect(session.snapshot().cwd).toBe(process.cwd())
    },
    TEST_TIMEOUT_MS
  )

  // A view reads the snapshot after subscribing; the mark is how it drops chunks the snapshot already holds.
  it(
    'marks each chunk with where the output stands after it, and says where it stands now',
    async () => {
      const session = start({ command: 'echo one; sleep 0.2; echo two' })
      const events = collect(session)

      await waitUntil(() => outputOf(events).includes('two'), 'both lines')
      const chunks = events.filter((event): event is Extract<TerminalEvent, { type: 'data' }> => event.type === 'data')
      let end = 0
      expect(chunks.map((chunk) => chunk.end)).toEqual(chunks.map((chunk) => (end += chunk.data.length)))
      expect(session.outputEnd).toBe(end)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'writes to the child and reads the response back out of scrollback',
    async () => {
      const session = start({ command: 'cat' })
      session.write('ping-pong\n')

      await waitUntil(() => session.read().includes('ping-pong'), 'echoed input')
      expect(session.snapshot().running).toBe(true)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'resizes the pty and reports the new size',
    async () => {
      const session = start({ command: 'cat', cols: 80, rows: 24 })
      session.resize(120, 40)

      const snapshot = session.snapshot()
      expect(snapshot.cols).toBe(120)
      expect(snapshot.rows).toBe(40)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'remembers the widest the pane has been, which its output was written for no wider than',
    async () => {
      const session = start({ command: 'cat', cols: 80, rows: 24 })
      session.resize(134, 40)
      session.resize(48, 40)

      expect(session.widestCols).toBe(134)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'reports the command the shell ran to determine the pane size',
    async () => {
      const session = start({ command: 'stty size', cols: 100, rows: 30 })
      const events = collect(session)

      await waitUntil(() => /30\s+100/.test(outputOf(events)), 'stty to report 30x100')
    },
    TEST_TIMEOUT_MS
  )

  it(
    'propagates the exit code and stops running',
    async () => {
      const session = start({ command: 'exit 7' })
      const events = collect(session)

      await waitUntil(() => events.some((event) => event.type === 'exit'), 'exit event')
      expect(events.at(-1)).toEqual({ type: 'exit', exitCode: 7 })
      expect(session.snapshot()).toMatchObject({ running: false, exitCode: 7 })
    },
    TEST_TIMEOUT_MS
  )

  it(
    'raises a title event from an OSC sequence in the live stream',
    async () => {
      // Two printf calls, so the chunking is the shell's choice, not the test's.
      const session = start({ command: `printf '\\033]0;agent-run' && printf '\\007' && sleep 1` })
      const events = collect(session)

      await waitUntil(() => events.some((event) => event.type === 'title'), 'title event')
      expect(events.find((event) => event.type === 'title')).toEqual({ type: 'title', title: 'agent-run' })
      expect(session.snapshot().title).toBe('agent-run')
    },
    TEST_TIMEOUT_MS
  )

  // Everything downstream of the session throws the bell away, so it is reported here or lost.
  it(
    'raises a bell event and remembers when it rang',
    async () => {
      const session = start({ command: `printf '\\007' && sleep 2` })
      const events = collect(session)

      await waitUntil(() => events.some((event) => event.type === 'bell'), 'bell event')
      const bell = events.find((event) => event.type === 'bell')
      expect(bell).toMatchObject({ type: 'bell' })
      expect(session.snapshot().lastBellAt).toBe(bell?.type === 'bell' ? bell.at : undefined)
    },
    TEST_TIMEOUT_MS
  )

  // An agent repainting a spinner into its title emits one of these several times a second.
  it(
    'does not count the BEL that terminates a title as a bell',
    async () => {
      const session = start({ command: `printf '\\033]0;agent-run\\007' && sleep 2` })
      const events = collect(session)

      await waitUntil(() => events.some((event) => event.type === 'title'), 'title event')
      expect(events.some((event) => event.type === 'bell')).toBe(false)
      expect(session.snapshot().lastBellAt).toBeUndefined()
    },
    TEST_TIMEOUT_MS
  )

  it(
    'forgets the bell once somebody types into the pane',
    async () => {
      const session = start({ command: `printf '\\007' && sleep 5` })
      const events = collect(session)

      await waitUntil(() => events.some((event) => event.type === 'bell'), 'bell event')
      session.write('\n')
      expect(session.snapshot().lastBellAt).toBeUndefined()
    },
    TEST_TIMEOUT_MS
  )

  it(
    'forgets the bell when a new burst of output starts',
    async () => {
      // A quiet window of milliseconds, so the second printf is a burst of its own.
      const session = start({
        command: `printf '\\007' && sleep 1 && echo carried-on && sleep 2`,
        schedule: (run, _delayMs) => {
          const timer = setTimeout(run, 10)
          return () => clearTimeout(timer)
        }
      })
      const events = collect(session)

      await waitUntil(() => events.some((event) => event.type === 'bell'), 'bell event')
      await waitUntil(() => outputOf(events).includes('carried-on'), 'output after the bell')
      expect(session.snapshot().lastBellAt).toBeUndefined()
    },
    TEST_TIMEOUT_MS
  )

  // The hint Claude Code draws under its folder-trust question; no hook, bell or title says it is asking.
  const TRUST_HINT = `printf '\\n Enter to confirm \\302\\267 Esc to cancel'`
  const soon = (run: () => void): (() => void) => {
    const timer = setTimeout(run, 10)
    return () => clearTimeout(timer)
  }

  it(
    "reads an agent's question off its screen until somebody answers",
    async () => {
      const session = start({ agent: 'claude', command: `${TRUST_HINT} && sleep 5`, schedule: soon })

      await waitUntil(() => session.snapshot().screenSays === 'waiting', 'the question read')
      session.write('\r')
      expect(session.snapshot().screenSays).toBeUndefined()
    },
    TEST_TIMEOUT_MS
  )

  it(
    'reads what the question is, for the notification, until somebody answers',
    async () => {
      const edit = `printf '\\n Do you want to make this edit to math.ts?\\n 1. Yes\\n\\n Esc to cancel \\302\\267 Tab to amend'`
      const session = start({ agent: 'claude', command: `${edit} && sleep 5`, schedule: soon })

      await waitUntil(() => session.question === 'Do you want to make this edit to math.ts?', 'the question read')
      session.write('\r')
      expect(session.question).toBeUndefined()
    },
    TEST_TIMEOUT_MS
  )

  it(
    'stops reading a question once the screen no longer shows it',
    async () => {
      const session = start({
        agent: 'claude',
        command: `${TRUST_HINT} && sleep 1 && printf '\\n\\nworking on it\\n❯ \\n' && sleep 5`,
        schedule: soon
      })

      await waitUntil(() => session.snapshot().screenSays === 'waiting', 'the question read')
      await waitUntil(() => session.snapshot().screenSays === undefined, 'the question gone')
    },
    TEST_TIMEOUT_MS
  )

  it(
    'says whether its agent has taken a turn: by its own word, or by a title saying one runs',
    async () => {
      const hooked = start({ agent: 'claude', command: 'sleep 5' })
      expect(hooked.snapshot().tookTurn).toBe(false)
      hooked.noteAgentEvent({ event: 'SessionStart', at: 1 })
      expect(hooked.snapshot().tookTurn).toBe(false)
      hooked.noteAgentEvent({ event: 'UserPromptSubmit', at: 2 })
      hooked.noteAgentEvent({ event: 'Stop', at: 3 })
      expect(hooked.snapshot().tookTurn).toBe(true)

      const titled = start({ agent: 'codex', command: `printf '\\033]0;⠏ teamree\\007' && sleep 5` })
      await waitUntil(() => titled.snapshot().tookTurn === true, 'the working title read')

      expect(start({ command: 'sleep 5' }).snapshot().tookTurn).toBeUndefined()
    },
    TEST_TIMEOUT_MS
  )

  it(
    'never reads a shell printing the same words as asking',
    async () => {
      const session = start({ command: `${TRUST_HINT} && sleep 5`, schedule: soon })
      const events = collect(session)

      await waitUntil(
        () => outputOf(events).includes('Esc to cancel') && !session.snapshot().busy,
        'the words, then quiet'
      )
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(session.snapshot().screenSays).toBeUndefined()
    },
    TEST_TIMEOUT_MS
  )

  it(
    'caps scrollback no matter how much the child prints',
    async () => {
      // 200 lines is about 6.8KB against a 2KB cap; eviction itself is covered in scrollback.test.ts.
      const cap = 2 * 1024
      const session = start({
        command: 'for i in $(seq 1 200); do echo "chatty line $i padding padding padding"; done',
        scrollbackCapBytes: cap
      })
      const events = collect(session)

      await waitUntil(() => events.some((event) => event.type === 'exit'), 'the chatty command to finish')
      expect(session.retainedBytes).toBeLessThanOrEqual(cap)
      expect(Buffer.byteLength(session.read(), 'utf8')).toBeLessThanOrEqual(cap)
      // The head is gone; whether the last line arrived is node-pty's question.
      expect(session.read()).not.toContain('chatty line 1 ')
    },
    TEST_TIMEOUT_MS
  )

  it(
    "lets go of most of an exited pane's scrollback and keeps the tail",
    async () => {
      const session = start({ command: 'seq 1 200000; sleep 1' })
      const events = collect(session)

      await waitUntil(
        () => session.retainedBytes > EXITED_RETENTION_BYTES,
        'the running pane to outgrow what an exited one keeps'
      )
      await waitUntil(() => events.some((event) => event.type === 'exit'), 'the chatty command to finish')

      expect(session.retainedBytes).toBeLessThanOrEqual(EXITED_RETENTION_BYTES)
      // Trimmed, not dropped: the renderer repaints an exited pane from `terminal.read`.
      expect(session.retainedBytes).toBeGreaterThan(0)
      expect(session.read().length).toBeGreaterThan(0)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'keeps the last line of a chatty command that exits the moment it has printed it',
    async () => {
      // 3000 lines: the pty is still holding some when the child is reaped. Several
      // runs, because the failure is a race.
      for (let run = 0; run < 5; run++) {
        const session = start({ command: 'seq 1 3000' })
        const events = collect(session)

        await waitUntil(() => events.some((event) => event.type === 'exit'), 'the chatty command to finish')
        expect(session.read()).toContain('\r\n3000\r\n')
      }
    },
    TEST_TIMEOUT_MS
  )

  it(
    'holds the exit event until everything the child printed has arrived',
    async () => {
      // waitpid returns while the last writes are still in the pty buffer; when
      // exit lands the scrollback must already be complete.
      const session = start({
        command: 'for i in $(seq 1 40); do echo "tail line $i padding padding padding"; done'
      })
      const events = collect(session)

      let scrollbackAtExit: string | undefined
      session.on((event) => {
        if (event.type === 'exit' && scrollbackAtExit === undefined) scrollbackAtExit = session.read()
      })

      await waitUntil(() => events.some((event) => event.type === 'exit'), 'the chatty command to finish')

      expect(scrollbackAtExit).toBeDefined()
      expect(scrollbackAtExit).toContain('tail line 40 ')
      // And nothing arrives afterwards to change the answer.
      const settled = session.read()
      expect(settled).toBe(scrollbackAtExit)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'kills the whole process tree, not just the shell',
    async () => {
      // The shell prints its grandchild's pid, then waits forever.
      const session = start({ command: 'sleep 120 & echo child:$!; wait' })
      const events = collect(session)

      await waitUntil(() => /child:\d+/.test(outputOf(events)), 'the grandchild pid')
      const match = /child:(\d+)/.exec(outputOf(events))
      const grandchild = Number(match?.[1])
      expect(grandchild).toBeGreaterThan(0)
      expect(isProcessAlive(grandchild)).toBe(true)

      await session.close()

      await waitUntil(() => !isProcessAlive(grandchild), 'the grandchild to be reaped')
      expect(session.snapshot().running).toBe(false)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'closes an already-exited terminal without complaint',
    async () => {
      const session = start({ command: 'exit 0' })
      const events = collect(session)

      await waitUntil(() => events.some((event) => event.type === 'exit'), 'exit event')
      await expect(session.close()).resolves.toBeUndefined()
      await expect(session.close()).resolves.toBeUndefined()
    },
    TEST_TIMEOUT_MS
  )

  it(
    'refuses writes to a terminal whose process is gone',
    async () => {
      const session = start({ command: 'exit 0' })
      const events = collect(session)

      await waitUntil(() => events.some((event) => event.type === 'exit'), 'exit event')
      expect(() => session.write('too late\n')).toThrow(/exited/)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'reports going quiet for a pane that dies while it is still working',
    async () => {
      const edges: { busy: boolean; running: boolean }[] = []
      const session = start({
        // Output, then death, inside the quiet window: busy at the moment it exits.
        command: 'echo working; exit 5',
        onActivityChange: (each) => {
          const { busy, running } = each.snapshot()
          edges.push({ busy, running })
        }
      })
      const events = collect(session)

      await waitUntil(() => events.some((event) => event.type === 'exit'), 'exit event')

      // Both edges: settling the exit cancels the countdown that would have reported the second.
      expect(edges).toEqual([
        { busy: true, running: true },
        { busy: false, running: false }
      ])
      expect(session.snapshot()).toMatchObject({ busy: false, running: false, exitCode: 5 })
    },
    TEST_TIMEOUT_MS
  )

  it(
    'does not count a repaint for a new size as output, and counts what follows it',
    async () => {
      const edges: boolean[] = []
      const session = start({
        command: `trap 'printf redrawn' WINCH; echo ready; while :; do sleep 0.05; done`,
        schedule: (run, _delayMs) => {
          const timer = setTimeout(run, 10)
          return () => clearTimeout(timer)
        },
        onActivityChange: (each) => edges.push(each.isBusy)
      })
      const events = collect(session)
      await waitUntil(() => outputOf(events).includes('ready') && !session.isBusy, 'the first burst to go quiet')
      const quietAt = session.snapshot().lastOutputAt
      const edgesBefore = edges.length

      session.resize(100, 30)
      await waitUntil(() => outputOf(events).includes('redrawn'), 'the repaint')
      expect(session.snapshot()).toMatchObject({ busy: false, lastOutputAt: quietAt })
      expect(edges).toHaveLength(edgesBefore)

      await new Promise((resolve) => setTimeout(resolve, REDRAW_AFTER_RESIZE_MS + 50))
      session.write('typed\n')
      await waitUntil(() => session.snapshot().lastOutputAt > quietAt, 'the echo to count as output')
    },
    TEST_TIMEOUT_MS
  )

  it(
    'stops notifying a listener that unsubscribed',
    async () => {
      const session = start({ command: 'cat' })
      const events: TerminalEvent[] = []
      const off = session.on((event) => events.push(event))

      session.write('before\n')
      await waitUntil(() => outputOf(events).includes('before'), 'first echo')
      off()
      const seen = events.length
      session.write('after\n')
      await waitUntil(() => session.read().includes('after'), 'second echo in scrollback')
      expect(events).toHaveLength(seen)
    },
    TEST_TIMEOUT_MS
  )

  /** The previous run's output, for a pane being brought back. */
  const earlier = { text: 'what this pane printed last time\r\n', recordedAt: Date.parse('2026-03-04T09:05:00Z') }

  it(
    'does not put the record under a tail that only starts later to skip a cut sequence',
    async () => {
      const session = start({ command: "printf 'ab\\033[38;2;138;138;138;49m%0120d\\n' 7", restoredRecord: earlier })
      await waitUntil(() => !session.isRunning && session.retainedBytes > 0, 'the line and the exit')

      // Cut inside the colour: the live tail skips ahead, and is still the newer half.
      const tailBytes = session.retainedBytes - 'ab\x1b[38'.length
      expect(session.read(tailBytes)).not.toContain('end of record')
      expect(session.read(tailBytes)).not.toContain('138;')
      expect(session.recordedOutput(tailBytes)).not.toContain('what this pane printed last time')
    },
    TEST_TIMEOUT_MS
  )

  it(
    'holds back the record of a pane that is resuming, without letting go of it',
    async () => {
      const session = start({ command: 'cat', restored: 'agent', restoredRecord: earlier })

      // The conversation is about to print itself; a transcript too would be the exchange twice.
      expect(session.read()).not.toContain('what this pane printed last time')
      // Held, not thrown away: this is the only copy.
      expect(session.recordedOutput()).toContain('what this pane printed last time')
    },
    TEST_TIMEOUT_MS
  )

  it(
    'says in the pane when the conversation it came back for never arrived',
    async () => {
      const session = start({
        command: 'echo no such conversation; exit 1',
        restored: 'agent',
        restoredRecord: earlier
      })
      const events = collect(session)

      await waitUntil(() => !session.isRunning, 'the agent to give up')

      const shown = session.read()
      // In the pane's own output: a restored pane can die before there is a window.
      // One line with the two facts only the pane knows; why is on `failedResumeMark`.
      expect(shown).toContain('[resume refused — agent exited 1')
      expect(shown).not.toContain('deleted, expired, or recorded on another machine')
      expect(outputOf(events)).toContain('resume refused')
      // An attached subscriber is sent the held record too: it only reads once, at mount.
      expect(outputOf(events)).toContain('what this pane printed last time')
      expect(outputOf(events).indexOf('what this pane printed last time')).toBeLessThan(
        outputOf(events).indexOf('resume refused')
      )

      // The held record is let go of, above the failed attempt, under a line
      // that does not promise a shell.
      expect(shown).toContain('what this pane printed last time')
      expect(shown).toContain('resume attempt below')
      expect(shown).not.toContain('new shell below')

      // And the pane stops claiming it resumed anything.
      expect(session.snapshot().restored).toBeUndefined()
    },
    TEST_TIMEOUT_MS
  )

  it(
    'blames nothing for an agent that resumed, did its work and exited cleanly',
    async () => {
      // A one-shot: same executable, different mode, nothing upstream can tell it apart.
      const session = start({ command: 'echo the answer', restored: 'agent', restoredRecord: earlier })

      await waitUntil(() => !session.isRunning, 'the one-shot to finish')

      expect(session.read()).not.toContain('resume refused')
      // The badge stands, because it is true: that pane did resume.
      expect(session.snapshot().restored).toBe('agent')
      expect(session.resumeDidNotTake).toBe(false)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'blames nothing for an agent that ran for a while before it died',
    async () => {
      // Started inside the window and reaped outside it.
      let clock = 1_000
      const session = start({
        command: 'sleep 0.05; exit 1',
        restored: 'agent',
        restoredRecord: earlier,
        now: () => clock
      })
      clock += RESUME_WINDOW_MS + 1

      await waitUntil(() => !session.isRunning, 'the agent to exit')

      expect(session.read()).not.toContain('resume refused')
      // And the record stays held.
      expect(session.read()).not.toContain('what this pane printed last time')
      expect(session.snapshot().restored).toBe('agent')
    },
    TEST_TIMEOUT_MS
  )

  it(
    'says nothing of the kind about a pane that was never resuming anything',
    async () => {
      // A restored *shell* has no conversation behind it to be missing.
      const session = start({ command: 'exit 1', restored: 'shell', restoredRecord: earlier })

      await waitUntil(() => !session.isRunning, 'the command to finish')

      expect(session.read()).not.toContain('resume refused')
      // A restored shell was always shown its record; that is unchanged.
      expect(session.read()).toContain('what this pane printed last time')
      expect(session.read()).toContain('new shell below')
    },
    TEST_TIMEOUT_MS
  )
})
