// When a *running* pane's output is written down.
//
// The archive writes at two moments: a pane exits, and the app quits. Both are
// endings, and a pane that is still running when the machine loses power has
// neither — so what it printed since it last exited is gone, which is precisely
// the pane somebody wanted back. A forty-minute build, an agent halfway through
// a task and a migration that stopped on an error are the cases the archive was
// built for, and "only on a clean exit" does not cover any of them.
//
// So there is a third moment, and this is it. The hard part is not taking the
// checkpoint; it is not paying for it.
//
// **Nothing is polled.** There is no timer per pane ticking away at an idle
// app. A checkpoint is armed by output arriving and by nothing else, so a pane
// sitting at a prompt — which is most panes, most of the time — costs exactly
// one map lookup at the moment it last printed and nothing afterwards. The
// cost of this feature is proportional to the thing it protects.
//
// **A pane cannot be checkpointed more often than the interval**, and that
// falls out of the shape rather than being enforced on top of it: the timer is
// armed only when none is already armed, and it is only ever re-armed by output
// that arrives after it has fired. Ten thousand chunks in a second are one
// checkpoint. The floor and the debounce are the same number because they want
// to be the same number, and a second constant would only be a way for the two
// to disagree.
//
// **A checkpoint reads a bounded window**, because the sanitizer is linear in
// what it is handed and it runs on the thread that pumps every PTY in the app.
// That is what `CHECKPOINT_SOURCE_BYTES` is for, and it is the whole difference
// between a checkpoint nobody notices and a pane that stutters every interval.
//
// **A checkpoint only ever adds.** It hands the archive text and the archive
// decides whether that is worth a write — it keeps the last record's
// fingerprint and skips one that would change nothing, which is what stops a
// full-screen agent redrawing a spinner from rewriting an identical file every
// interval, and what stops the quit path writing a pane the exit path just
// wrote. Removing a record belongs to the pane being closed, and a checkpoint
// that finds nothing to say says nothing rather than deleting anything.

/**
 * How long after output a running pane's record is written.
 *
 * Fifteen seconds is the answer to two questions at once, and they pull in
 * opposite directions. Shorter loses less to a power cut; longer costs less.
 *
 * Below, it would start to cost something real: a checkpoint is a read of the
 * pane's tail, a pass of the sanitizer over it, and a small atomic write with
 * an fsync, and a dozen panes all producing output is a dozen of those per
 * interval, forever. Above, the loss window stops being "the last few lines"
 * and starts being "the part I wanted".
 *
 * Fifteen also sits either side of two numbers this app already has. It is
 * comfortably longer than `QUIET_AFTER_MS`, the four seconds after which a pane
 * is called quiet, so an agent that works in bursts and pauses is checkpointed
 * once per burst rather than once per pause. And it is shorter than the minute
 * `clockLabel` resolves to, so a record can never be described by a clock
 * reading that is already a minute out of date.
 */
export const CHECKPOINT_INTERVAL_MS = 15_000

/**
 * How much of a live pane's output one checkpoint looks at: twice the archive's
 * `MAX_RECORD_BYTES`.
 *
 * A pane's live buffer holds four megabytes, sixteen times what a record keeps,
 * and reducing output to something safe to replay is a character-at-a-time pass
 * over every byte of what it is given. Measured, that pass is about three
 * milliseconds over 128 KiB and about four hundred over the whole buffer — and
 * it runs on the main thread, between the PTY's read and the renderer's frame.
 * Four hundred milliseconds every fifteen seconds, per busy pane, is the pane
 * stuttering; three is nobody noticing.
 *
 * Twice the cap rather than exactly the cap because the sanitizer only ever
 * shrinks what it is given: doubling leaves room for the escapes it drops, so
 * an ordinary pane still checkpoints a full record. A pane whose output is
 * almost entirely escape sequences checkpoints less than the cap, which is a
 * shorter record rather than a broken one — and its exit and quit records are
 * still taken from the whole buffer.
 */
export const CHECKPOINT_SOURCE_BYTES = 256 * 1024

export type ScrollbackCheckpointOptions = {
  /**
   * What the pane has printed, or undefined when there is no such pane any
   * more. A checkpoint is armed by output and taken an interval later, and a
   * pane can be closed in between; answering undefined is how that is said.
   */
  read: (terminalId: string) => string | undefined
  /** Where a checkpoint goes: the archive's `put`, which caps, reduces and dedupes. */
  put: (terminalId: string, text: string) => void
  intervalMs?: number
  /** Timer seam, so a test need not wait out an interval. */
  schedule?: (run: () => void, delayMs: number) => () => void
}

/** The checkpoints currently armed, one at most per pane. */
export class ScrollbackCheckpoints {
  readonly #armed = new Map<string, () => void>()
  readonly #options: ScrollbackCheckpointOptions
  readonly #intervalMs: number

  constructor(options: ScrollbackCheckpointOptions) {
    this.#options = options
    this.#intervalMs = options.intervalMs ?? CHECKPOINT_INTERVAL_MS
  }

  /**
   * Called for every chunk a pane prints, so it has to stay this cheap: a pane
   * already waiting on a checkpoint is one map lookup and a return.
   */
  note(terminalId: string): void {
    if (this.#armed.has(terminalId)) return
    const cancel = this.#scheduler(
      () => {
        this.#armed.delete(terminalId)
        this.#take(terminalId)
      },
      this.#intervalMs
    )
    this.#armed.set(terminalId, cancel)
  }

  /**
   * Forgets a pane's pending checkpoint, because something final has happened
   * to it: it exited, it was closed, or the app is on its way out. Each of
   * those writes the pane's record itself, and a timer still armed afterwards
   * would at best repeat that write and at worst put a file back for a pane
   * whose record was just deliberately removed.
   */
  cancel(terminalId: string): void {
    const cancel = this.#armed.get(terminalId)
    if (cancel === undefined) return
    this.#armed.delete(terminalId)
    cancel()
  }

  /** The same, for every pane at once: the shutdown path. */
  cancelAll(): void {
    for (const terminalId of [...this.#armed.keys()]) this.cancel(terminalId)
  }

  /** How many panes are waiting on a checkpoint. Exposed so a test can say "none". */
  get armedCount(): number {
    return this.#armed.size
  }

  #take(terminalId: string): void {
    const text = this.#options.read(terminalId)
    // A pane that has gone, and a pane with nothing to say. The second is not
    // the same as a pane whose record should go: `put` treats empty text as a
    // removal, and a checkpoint must never be the reason a record disappears.
    if (text === undefined || text.length === 0) return
    this.#options.put(terminalId, text)
  }

  get #scheduler(): (run: () => void, delayMs: number) => () => void {
    return this.#options.schedule ?? scheduleUnref
  }
}

/** A timer that is never the reason a process stays alive. */
function scheduleUnref(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}
