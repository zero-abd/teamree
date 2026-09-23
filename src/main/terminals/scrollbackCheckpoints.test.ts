import { describe, expect, it } from 'vitest'
import { MAX_RECORD_BYTES } from '../store/scrollbackArchive'
import {
  CHECKPOINT_INTERVAL_MS,
  CHECKPOINT_SOURCE_BYTES,
  ScrollbackCheckpoints,
  type ScrollbackCheckpointOptions
} from './scrollbackCheckpoints'
import { QUIET_AFTER_MS } from './pty-session'

/** A clock that only moves when a test moves it; `armed` says nothing is waiting on an idle pane. */
function fakeTimers(): {
  schedule: (run: () => void, delayMs: number) => () => void
  armed: number
  advance: (byMs: number) => void
} {
  let now = 0
  let pending: Array<{ at: number; run: () => void }> = []
  return {
    schedule(run, delayMs) {
      const entry = { at: now + delayMs, run }
      pending.push(entry)
      return () => {
        pending = pending.filter((waiting) => waiting !== entry)
      }
    },
    get armed(): number {
      return pending.length
    },
    advance(byMs) {
      now += byMs
      const due = pending.filter((waiting) => waiting.at <= now)
      pending = pending.filter((waiting) => waiting.at > now)
      for (const waiting of due) waiting.run()
    }
  }
}

function harness(overrides: Partial<ScrollbackCheckpointOptions> = {}): {
  checkpoints: ScrollbackCheckpoints
  written: Array<{ terminalId: string; text: string }>
  output: Map<string, string>
  timers: ReturnType<typeof fakeTimers>
} {
  const timers = fakeTimers()
  const written: Array<{ terminalId: string; text: string }> = []
  const output = new Map<string, string>([['term_1', '']])
  const checkpoints = new ScrollbackCheckpoints({
    read: (terminalId) => output.get(terminalId),
    put: (terminalId, text) => written.push({ terminalId, text }),
    schedule: timers.schedule,
    ...overrides
  })
  return { checkpoints, written, output, timers }
}

/** One chunk of output arriving in a pane. */
function prints(
  { output, checkpoints }: { output: Map<string, string>; checkpoints: ScrollbackCheckpoints },
  text: string,
  terminalId = 'term_1'
): void {
  output.set(terminalId, `${output.get(terminalId) ?? ''}${text}`)
  checkpoints.note(terminalId)
}

describe('ScrollbackCheckpoints', () => {
  it('writes down what a pane has printed without waiting for it to exit', () => {
    const harnessed = harness()
    prints(harnessed, 'step 1 of 40\r\n')
    expect(harnessed.written).toEqual([])

    harnessed.timers.advance(CHECKPOINT_INTERVAL_MS)
    expect(harnessed.written).toEqual([{ terminalId: 'term_1', text: 'step 1 of 40\r\n' }])
  })

  // Panes sitting at a prompt pay nothing: not a write, not a timer.
  it('costs a quiet pane nothing', () => {
    const harnessed = harness()
    expect(harnessed.timers.armed).toBe(0)
    expect(harnessed.checkpoints.armedCount).toBe(0)

    prints(harnessed, 'done\r\n')
    harnessed.timers.advance(CHECKPOINT_INTERVAL_MS)
    expect(harnessed.written).toHaveLength(1)

    // And having written once it goes back to costing nothing.
    expect(harnessed.timers.armed).toBe(0)
    expect(harnessed.checkpoints.armedCount).toBe(0)
    harnessed.timers.advance(CHECKPOINT_INTERVAL_MS * 100)
    expect(harnessed.written).toHaveLength(1)
  })

  // A checkpoint is armed only when none is, and re-armed only by output after one fires.
  it('writes once for a burst, however much of it there is', () => {
    const harnessed = harness()
    for (let line = 0; line < 10_000; line++) prints(harnessed, `line ${line}\r\n`)
    expect(harnessed.checkpoints.armedCount).toBe(1)

    harnessed.timers.advance(CHECKPOINT_INTERVAL_MS)
    expect(harnessed.written).toHaveLength(1)
    expect(harnessed.written[0]?.text).toContain('line 9999')
  })

  it('never writes one pane twice inside an interval', () => {
    const harnessed = harness()
    prints(harnessed, 'first\r\n')
    harnessed.timers.advance(CHECKPOINT_INTERVAL_MS)

    // Output through the whole of the next interval.
    for (let step = 0; step < CHECKPOINT_INTERVAL_MS; step += 100) {
      prints(harnessed, 'more\r\n')
      harnessed.timers.advance(100)
    }

    // Two intervals have passed and there are two writes, not one per chunk.
    expect(harnessed.written).toHaveLength(2)
  })

  it('writes nothing for a pane that has gone in the meantime', () => {
    const harnessed = harness()
    prints(harnessed, 'output\r\n')
    harnessed.output.delete('term_1')

    harnessed.timers.advance(CHECKPOINT_INTERVAL_MS)
    expect(harnessed.written).toEqual([])
  })

  // A checkpoint armed by a closed pane's last chunk would put the file straight back.
  it('forgets a pane that has been closed before its checkpoint comes due', () => {
    const harnessed = harness()
    prints(harnessed, 'output\r\n')
    harnessed.checkpoints.cancel('term_1')

    expect(harnessed.timers.armed).toBe(0)
    harnessed.timers.advance(CHECKPOINT_INTERVAL_MS)
    expect(harnessed.written).toEqual([])
  })

  it('forgets every pane at once on the way out', () => {
    const harnessed = harness()
    harnessed.output.set('term_2', '')
    prints(harnessed, 'one\r\n')
    prints(harnessed, 'two\r\n', 'term_2')
    expect(harnessed.checkpoints.armedCount).toBe(2)

    harnessed.checkpoints.cancelAll()
    expect(harnessed.timers.armed).toBe(0)
    harnessed.timers.advance(CHECKPOINT_INTERVAL_MS)
    expect(harnessed.written).toEqual([])
  })

  // `put` takes empty text as a removal; only a pane being closed may cause one.
  it('never removes a record by checkpointing an empty pane', () => {
    const harnessed = harness()
    harnessed.checkpoints.note('term_1')

    harnessed.timers.advance(CHECKPOINT_INTERVAL_MS)
    expect(harnessed.written).toEqual([])
  })

  it('keeps its panes apart', () => {
    const harnessed = harness()
    harnessed.output.set('term_2', '')
    prints(harnessed, 'one\r\n')
    harnessed.timers.advance(CHECKPOINT_INTERVAL_MS / 2)
    prints(harnessed, 'two\r\n', 'term_2')

    harnessed.timers.advance(CHECKPOINT_INTERVAL_MS / 2)
    expect(harnessed.written).toEqual([{ terminalId: 'term_1', text: 'one\r\n' }])
    harnessed.timers.advance(CHECKPOINT_INTERVAL_MS / 2)
    expect(harnessed.written).toEqual([
      { terminalId: 'term_1', text: 'one\r\n' },
      { terminalId: 'term_2', text: 'two\r\n' }
    ])
  })
})

describe('what the interval is chosen against', () => {
  // Asserted so moving one of these numbers has to be a decision.
  it('is longer than the window this app calls a pane quiet in', () => {
    expect(CHECKPOINT_INTERVAL_MS).toBeGreaterThan(QUIET_AFTER_MS)
  })

  it('is shorter than the minute a record is dated to', () => {
    expect(CHECKPOINT_INTERVAL_MS).toBeLessThan(60_000)
  })

  // The sanitizer runs on the thread that pumps every PTY, so it reads a window, not the whole buffer.
  it('reads twice what it can keep, and no more', () => {
    expect(CHECKPOINT_SOURCE_BYTES).toBe(MAX_RECORD_BYTES * 2)
  })
})
