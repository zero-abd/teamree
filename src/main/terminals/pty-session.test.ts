import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TerminalEvent } from '../../shared/methods'
import { ErrorCode } from '../../shared/protocol'
import { isProcessAlive } from './process-tree'
import { EXITED_RETENTION_BYTES, PtySession, RESUME_WINDOW_MS } from './pty-session'
import type { PtySessionInit } from './pty-session'
import { canSpawnPty, waitUntil } from './pty-test-support'
import { isTerminalServiceError } from './service-error'
import { SHELL_UNRUNNABLE } from './shell-environment'

// Real PTYs, no mocks: the interesting failures here are all in the native layer
// and in how a shell reacts to signals, and a fake would reproduce neither.
// POSIX only, deliberately. Every command below is POSIX shell — `$(seq 1 200)`,
// `exit 5`, `;` as a separator — and the behaviour under test is what a pty does
// with them. A Windows equivalent would be a different test rather than a
// translation of this one, so this skips there instead of failing there, and the
// Windows-relevant parts of the session live in tests that do run on it.
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
      // Windows refuses this inside node-pty's spawn. POSIX does not refuse it
      // at all: the fork succeeds, the exec fails in the child, and the pane
      // opens and disappears a moment later with the reason going nowhere. The
      // caller has to hear the same thing on both.
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
      // printf writes the sequence in two calls, so the chunking is the shell's
      // choice rather than the test's -- the scanner has to cope either way.
      const session = start({ command: `printf '\\033]0;agent-run' && printf '\\007' && sleep 1` })
      const events = collect(session)

      await waitUntil(() => events.some((event) => event.type === 'title'), 'title event')
      expect(events.find((event) => event.type === 'title')).toEqual({ type: 'title', title: 'agent-run' })
      expect(session.snapshot().title).toBe('agent-run')
    },
    TEST_TIMEOUT_MS
  )

  // The bell is the one byte a program sends for no reason except to be
  // noticed, and everything downstream of the session throws it away. So it is
  // reported from here, and remembered here, or it is lost.
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

  // An agent that repaints a spinner into its window title emits one of these
  // several times a second. Counted, every one of those panes would look like a
  // pane asking for attention.
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

  // A bell is a request. A keystroke is somebody answering it, and a pane that
  // has been answered is not asking for anything.
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

  // And a fresh burst of output is the pane overtaking its own request: whatever
  // it rang about, it has gone back to doing something since.
  it(
    'forgets the bell when a new burst of output starts',
    async () => {
      // A quiet window of a few milliseconds, so the second printf a second
      // later is a burst of its own rather than more of the first.
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

  it(
    'caps scrollback no matter how much the child prints',
    async () => {
      // The ratio is the point, not the volume: 200 lines is about 6.8KB
      // against a 2KB cap, so most of it must be evicted. The buffer's own
      // eviction is covered exhaustively, without a PTY, in scrollback.test.ts.
      const cap = 2 * 1024
      const session = start({
        command: 'for i in $(seq 1 200); do echo "chatty line $i padding padding padding"; done',
        scrollbackCapBytes: cap
      })
      const events = collect(session)

      await waitUntil(() => events.some((event) => event.type === 'exit'), 'the chatty command to finish')
      expect(session.retainedBytes).toBeLessThanOrEqual(cap)
      expect(Buffer.byteLength(session.read(), 'utf8')).toBeLessThanOrEqual(cap)
      // The head is gone, which is what eviction means. Whether the very last
      // line arrived is node-pty's question, not this buffer's, and the test
      // above answers it at a volume that always drains in time.
      expect(session.read()).not.toContain('chatty line 1 ')
    },
    TEST_TIMEOUT_MS
  )

  it(
    "lets go of most of an exited pane's scrollback and keeps the tail",
    async () => {
      // A finished pane appends nothing more, so whatever it is holding is
      // held purely against the next read. The readers are real and all of
      // them read the tail, so the tail is what survives.
      const session = start({ command: 'seq 1 200000; sleep 1' })
      const events = collect(session)

      await waitUntil(
        () => session.retainedBytes > EXITED_RETENTION_BYTES,
        'the running pane to outgrow what an exited one keeps'
      )
      await waitUntil(() => events.some((event) => event.type === 'exit'), 'the chatty command to finish')

      expect(session.retainedBytes).toBeLessThanOrEqual(EXITED_RETENTION_BYTES)
      // Trimmed, not dropped: `terminal.read` on an exited pane is what the
      // renderer repaints from and what `teamree terminal read` answers with.
      expect(session.retainedBytes).toBeGreaterThan(0)
      expect(session.read().length).toBeGreaterThan(0)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'keeps the last line of a chatty command that exits the moment it has printed it',
    async () => {
      // 3000 lines is the volume the tail used to go missing at: enough that
      // the pty is still holding some of it when the child is reaped. A handful
      // of runs rather than one, because what used to fail here failed by race
      // and a single green run would have said nothing.
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
      // The bug this pins down: waitpid returns as soon as the child is reaped,
      // while its last writes are still in the pty buffer. Emitting exit then
      // loses the tail — which is exactly what `terminal run` hands back to an
      // agent. So the invariant is that when exit lands, the scrollback is
      // already complete.
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
      // The shell prints its grandchild's pid, then waits forever. Closing the
      // session has to take the sleep with it.
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
        // Output, then death, well inside the quiet window: the pane is
        // genuinely busy at the moment it exits.
        command: 'echo working; exit 5',
        onActivityChange: (each) => {
          const { busy, running } = each.snapshot()
          edges.push({ busy, running })
        }
      })
      const events = collect(session)

      await waitUntil(() => events.some((event) => event.type === 'exit'), 'exit event')

      // Both edges, not just the first. Settling the exit cancels the quiet
      // countdown that would have reported the second one, so without it a
      // subscriber watching activity is left holding "busy" for a pane that is
      // never going to say anything again.
      expect(edges).toEqual([
        { busy: true, running: true },
        { busy: false, running: false }
      ])
      expect(session.snapshot()).toMatchObject({ busy: false, running: false, exitCode: 5 })
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
    'holds back the record of a pane that is resuming, without letting go of it',
    async () => {
      const session = start({ command: 'cat', restored: 'agent', restoredRecord: earlier })

      // The conversation is about to print itself out of the agent's own store,
      // so showing a transcript of it as well would be the same exchange twice.
      expect(session.read()).not.toContain('what this pane printed last time')
      // Held, though, and not thrown away: this is the only copy of it, and what
      // gets written down for the next launch has to still have it.
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
      // Said in words, and in the pane's own output rather than to whoever
      // happens to be subscribed: a restored pane can die before there is a
      // window, and the window paints from what it reads.
      expect(shown).toContain('nothing was resumed')
      expect(shown).toContain('exited with code 1')
      expect(shown).toContain('deleted, expired, or recorded on another machine')
      expect(outputOf(events)).toContain('nothing was resumed')
      // A subscriber that was already attached is sent the held record too. It
      // only ever reads once, when its view mounts, so un-holding the record
      // without also sending it would tell this one that the old output is
      // above while never having sent it a byte of it — the same false claim
      // this whole mechanism exists to stop, moved somewhere harder to see.
      expect(outputOf(events)).toContain('what this pane printed last time')
      expect(outputOf(events).indexOf('what this pane printed last time')).toBeLessThan(
        outputOf(events).indexOf('nothing was resumed')
      )

      // The held record is let go of in the same moment, above the attempt that
      // failed, and under a line that does not promise a shell that is not
      // coming.
      expect(shown).toContain('what this pane printed last time')
      expect(shown).toContain('the attempt to resume this conversation begins below')
      expect(shown).not.toContain('a new shell starts below')

      // And the pane stops claiming it resumed anything.
      expect(session.snapshot().restored).toBeUndefined()
    },
    TEST_TIMEOUT_MS
  )

  it(
    'blames nothing for an agent that resumed, did its work and exited cleanly',
    async () => {
      // A one-shot: resume, answer, leave with zero. It is the same executable
      // in a different mode, so nothing upstream can tell it apart from the
      // interactive one, and every clause of the note would be false about it.
      const session = start({ command: 'echo the answer', restored: 'agent', restoredRecord: earlier })

      await waitUntil(() => !session.isRunning, 'the one-shot to finish')

      expect(session.read()).not.toContain('nothing was resumed')
      // The badge stands, because it is true: that pane did resume.
      expect(session.snapshot().restored).toBe('agent')
      expect(session.resumeDidNotTake).toBe(false)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'blames nothing for an agent that ran for a while before it died',
    async () => {
      // Started inside the window and reaped outside it. Past the window an
      // agent that ends is an agent that ended — it may well have resumed
      // perfectly an hour ago — and inventing a cause for it would be this app
      // saying something it does not know.
      let clock = 1_000
      const session = start({
        command: 'sleep 0.05; exit 1',
        restored: 'agent',
        restoredRecord: earlier,
        now: () => clock
      })
      clock += RESUME_WINDOW_MS + 1

      await waitUntil(() => !session.isRunning, 'the agent to exit')

      expect(session.read()).not.toContain('nothing was resumed')
      // And the record stays held, because nothing has happened to say the
      // conversation did not come back.
      expect(session.read()).not.toContain('what this pane printed last time')
      expect(session.snapshot().restored).toBe('agent')
    },
    TEST_TIMEOUT_MS
  )

  it(
    'says nothing of the kind about a pane that was never resuming anything',
    async () => {
      // A restored *shell* exits because somebody ended it, which is not a
      // failure and has no conversation behind it to be missing.
      const session = start({ command: 'exit 1', restored: 'shell', restoredRecord: earlier })

      await waitUntil(() => !session.isRunning, 'the command to finish')

      expect(session.read()).not.toContain('nothing was resumed')
      // A restored shell was always shown its record; that is unchanged.
      expect(session.read()).toContain('what this pane printed last time')
      expect(session.read()).toContain('a new shell starts below')
    },
    TEST_TIMEOUT_MS
  )
})
