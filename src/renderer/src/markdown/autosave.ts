// A save that waits for the typing to pause, and never runs two at once.

/** How long after the last keystroke the file is written. */
export const AUTOSAVE_DELAY_MS = 500

export type Autosave = {
  /** The document as it is now; the write happens once typing pauses. */
  change: (text: string) => void
  /** Writes whatever is pending now, and resolves once it is on disk. */
  flush: () => Promise<void>
  /** Forgets what is pending without writing it. */
  cancel: () => void
  pending: () => boolean
}

export function createAutosave(options: { save: (text: string) => Promise<void>; delayMs?: number }): Autosave {
  const delay = options.delayMs ?? AUTOSAVE_DELAY_MS
  let waiting: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null

  const run = async (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    // One at a time: a write that overtook the one before it could land the
    // older text last.
    if (inFlight !== null) await inFlight
    if (waiting === null) return
    const text = waiting
    waiting = null
    inFlight = options.save(text).finally(() => {
      inFlight = null
    })
    await inFlight
    // Typing during the write is a newer document; it goes out next.
    if (waiting !== null) await run()
  }

  return {
    change(text) {
      waiting = text
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => void run(), delay)
    },
    flush: () => run(),
    cancel() {
      waiting = null
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
    pending: () => waiting !== null || inFlight !== null
  }
}
