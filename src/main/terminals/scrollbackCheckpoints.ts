// When a *running* pane's output is written down: a power cut has neither an
// exit nor a quit. Nothing is polled — a checkpoint is armed by output, at most
// one per interval, reads a bounded window, and only ever adds.

/**
 * How long after output a running pane's record is written. Longer than
 * `QUIET_AFTER_MS`, so a bursty agent is checkpointed per burst; shorter than
 * the minute `clockLabel` resolves to.
 */
export const CHECKPOINT_INTERVAL_MS = 15_000

/**
 * How much of a live pane one checkpoint looks at: twice `MAX_RECORD_BYTES`.
 * Measured, the sanitizer takes ~3ms over 128 KiB and ~400ms over the whole 4MB
 * buffer, on the main thread. Twice, to leave room for the escapes it drops.
 */
export const CHECKPOINT_SOURCE_BYTES = 256 * 1024

export type ScrollbackCheckpointOptions = {
  /** What the pane has printed, or undefined when it was closed since the checkpoint was armed. */
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

  /** Called for every chunk a pane prints, so it has to stay this cheap. */
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

  /** Forgets a pane's pending checkpoint: a timer left armed would put a removed file back. */
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
    // `put` treats empty text as a removal, and a checkpoint must never remove.
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
