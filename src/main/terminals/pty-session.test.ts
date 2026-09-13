import { afterEach, describe, expect, it } from 'vitest'
import type { TerminalEvent } from '../../shared/methods'
import { isProcessAlive } from './process-tree'
import { PtySession } from './pty-session'
import type { PtySessionInit } from './pty-session'
import { canSpawnPty, waitUntil } from './pty-test-support'

// Real PTYs, no mocks: the interesting failures here are all in the native layer
// and in how a shell reacts to signals, and a fake would reproduce neither.
const describePty = canSpawnPty() ? describe : describe.skip
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
})
