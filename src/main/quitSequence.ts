// What ⌘Q has to do, and the second ⌘Q it has to survive. `preventDefault()`
// cancels the quit rather than deferring it, so a second press mid-teardown
// would end the process before the scrollback archive is written: every quit
// is held until the teardown finishes, and the only one let through is the one
// this file asks for. A quit during startup waits for the launch (bounded by
// the grace below), since `restoreSessions()` spawns panes before the handle
// that can kill them exists. A teardown that throws still quits. A quit the
// window declines (Cancel on its Save question) leaves everything running.

/**
 * How long a quit waits for a launch still in flight. A real launch takes
 * milliseconds; a hung one should cost one pause, not a process to kill outside.
 */
export const STARTUP_GRACE_MS = 5_000

export type QuitSequenceOptions = {
  /** Asks the window about unsaved files before anything stops; false keeps the app. */
  mayQuit?: () => Promise<boolean>
  /** `Runtime.stop`: kills the PTYs, closes the CLI socket, flushes the workspace and scrollback. */
  stop: () => Promise<void>
  /** Asks for the quit again once `stop` has finished. `app.quit`. */
  quit: () => void
  /**
   * The launch in flight, when there is one. Awaited before `stop`, so a quit
   * mid-launch tears down the panes that launch restored rather than racing them.
   * A call, not a promise, so it can be wired before there is a launch to name.
   */
  whenStarted?: () => Promise<unknown>
  /** Overrides {@link STARTUP_GRACE_MS}. For the tests, which cannot wait. */
  startupGraceMs?: number
  /** Where a teardown that failed goes. Never a dialog: the app is leaving. */
  onProblem?: (error: unknown) => void
}

/** One `before-quit` event, as much of it as this needs. */
export type Quittable = { preventDefault: () => void }

/** A `before-quit` handler that runs the teardown once and lets one quit through: its own. */
export function createQuitSequence(options: QuitSequenceOptions): (event: Quittable) => void {
  const onProblem = options.onProblem ?? ((error: unknown) => console.error('[quit]', error))
  let phase: 'idle' | 'stopping' | 'stopped' = 'idle'

  return (event: Quittable) => {
    // The quit this file asked for.
    if (phase === 'stopped') return

    // Before anything else is decided, so a second press cannot end the process mid-teardown.
    event.preventDefault()
    if (phase === 'stopping') return
    phase = 'stopping'

    void (async () => {
      try {
        if (options.whenStarted !== undefined) {
          await waitForLaunch(options.whenStarted, options.startupGraceMs ?? STARTUP_GRACE_MS, onProblem)
        }
        if (options.mayQuit !== undefined && !(await options.mayQuit())) {
          phase = 'idle'
          return
        }
        await options.stop()
      } catch (error) {
        onProblem(error)
      }
      phase = 'stopped'
      options.quit()
    })()
  }
}

/**
 * Waits for the launch in flight, and gives up on it after `graceMs`. A failed
 * launch is still over, so its rejection is swallowed; nothing is thrown either way.
 */
async function waitForLaunch(
  whenStarted: () => Promise<unknown>,
  graceMs: number,
  onProblem: (error: unknown) => void
): Promise<void> {
  let expiry: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome = await Promise.race([
      whenStarted().then(
        () => 'launched' as const,
        () => 'launched' as const
      ),
      new Promise<'gave up'>((resolve) => {
        expiry = setTimeout(() => resolve('gave up'), graceMs)
      })
    ])
    // The only record of why a quit left panes behind.
    if (outcome === 'gave up') {
      onProblem(new Error(`the launch had not finished after ${graceMs}ms, so this quit is not waiting for it`))
    }
  } finally {
    // A pending timer would hold a process that has been asked to leave.
    clearTimeout(expiry)
  }
}
