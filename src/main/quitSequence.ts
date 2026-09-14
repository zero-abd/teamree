// What ⌘Q has to do, and the second ⌘Q it has to survive.
//
// Quitting this app is not instant and cannot be. The runtime kills a process
// tree per pane, releases its socket and its discovery file, and writes down
// what every pane printed so that the next launch can put it back — and all of
// that happens after `before-quit` has been told to wait. On a Mac that wait is
// visible: `event.preventDefault()` cancels the quit rather than deferring it,
// so the windows stay exactly where they are while it runs, and ⌘Q looks for a
// second or two like a key that did nothing.
//
// Which is why this file exists. The obvious shape — a flag that says "already
// stopping, let this one through" — reads as a way of not doing the work twice,
// and is in fact a way of abandoning it: the second quit is not prevented, so
// Electron closes the windows and ends the process while the first quit is
// still mid-teardown. What is lost is precisely the part that runs last, which
// is the scrollback archive: the transcript of every open pane, gone because
// somebody pressed the quit key twice at an app that looked stuck. Nothing on
// Linux would ever show this — ⌘Q is a Mac gesture and the pause is what
// invites the second press.
//
// So every quit is held back until the teardown is finished, and the teardown
// is started by the first one only. The one quit that is let through is the one
// this file asks for afterwards, which is the only quit that is safe.
//
// A teardown that throws still quits. An app that cannot be quit is a worse
// failure than a transcript that was not written, and the alternative — letting
// the rejection escape — is an unhandled rejection in the main process during
// shutdown, which says nothing useful about a shutdown that was going to end
// anyway.
//
// A quit pressed during startup is the same loss arrived at from the other end.
// The panes of the last session come back before the handle that can kill them
// exists: `restoreSessions()` spawns a pty per recorded pane while `startRuntime`
// is still opening the scrollback archive, binding the CLI socket and writing
// the discovery file, so for that second there is a great deal to tear down and
// nothing to tear it down with. A quit let through then ends the process with
// those panes still running, and they die of a master fd closing under them —
// unkilled, their transcripts never written, the discovery file left behind for
// the next launch to find. So a quit that arrives during a launch waits for the
// launch to finish and then tears down what it produced. Waiting is the honest
// shape here because the teardown that works is the one the launch hands back;
// the alternative is a second teardown that knows every half-built state
// `startRuntime` passes through, kept in step with it forever, for a window a
// second wide.
//
// That wait has an end. A launch that has not finished within the grace below
// is not one a user pressing ⌘Q should be held hostage to, and the rule is the
// one the failing teardown already follows: an app that cannot be quit is the
// worse failure. When the grace runs out the quit goes ahead with whatever
// teardown is reachable — which may be none — and says so on the way past.

/**
 * How long a quit waits for a launch that is still in flight.
 *
 * Long enough that a launch doing real work is never cut off — reading the
 * workspace file, sweeping the scrollback directory and spawning a pane's
 * worth of pty each take milliseconds, not seconds, even on a slow disk — and
 * short enough that a launch which is never going to finish costs the user one
 * pause rather than a process they have to kill from outside.
 */
export const STARTUP_GRACE_MS = 5_000

export type QuitSequenceOptions = {
  /**
   * Releases everything the app holds. `Runtime.stop`, which kills the PTYs,
   * closes the CLI socket and flushes both the workspace file and the
   * scrollback archive.
   */
  stop: () => Promise<void>
  /** Asks for the quit again once `stop` has finished. `app.quit`. */
  quit: () => void
  /**
   * The launch in flight, when there is one: `whenReady` through to the first
   * window. Awaited before `stop`, so that a quit arriving mid-launch tears
   * down the panes that launch restored rather than racing them.
   *
   * A call rather than a promise, like everything else this is handed, so that
   * the sequence can be wired where the other handlers are — before there is
   * any launch to name — and asks only once a quit has actually arrived.
   */
  whenStarted?: () => Promise<unknown>
  /** Overrides {@link STARTUP_GRACE_MS}. For the tests, which cannot wait. */
  startupGraceMs?: number
  /** Where a teardown that failed goes. Never a dialog: the app is leaving. */
  onProblem?: (error: unknown) => void
}

/** One `before-quit` event, as much of it as this needs. */
export type Quittable = { preventDefault: () => void }

/**
 * A `before-quit` handler that runs the teardown exactly once and lets exactly
 * one quit through — the one it asks for itself.
 */
export function createQuitSequence(options: QuitSequenceOptions): (event: Quittable) => void {
  const onProblem = options.onProblem ?? ((error: unknown) => console.error('[quit]', error))
  let phase: 'idle' | 'stopping' | 'stopped' = 'idle'

  return (event: Quittable) => {
    // The quit this file asked for. Everything is already released, so this is
    // the one that is allowed to end the process.
    if (phase === 'stopped') return

    // Held back before anything else is decided, so that the second press of a
    // key the user thinks did nothing cannot end the process mid-teardown.
    event.preventDefault()
    if (phase === 'stopping') return
    phase = 'stopping'

    void (async () => {
      try {
        if (options.whenStarted !== undefined) {
          await waitForLaunch(options.whenStarted, options.startupGraceMs ?? STARTUP_GRACE_MS, onProblem)
        }
        await options.stop()
      } catch (error) {
        onProblem(error)
      } finally {
        phase = 'stopped'
        options.quit()
      }
    })()
  }
}

/**
 * Waits for the launch in flight, and gives up on it after `graceMs`.
 *
 * A launch that failed is still a launch that is over, so its rejection is
 * swallowed here rather than reported: the failure belongs to whoever started
 * it, and all this needs to know is that the waiting is finished. The teardown
 * that follows then runs against whatever that launch left behind.
 *
 * Nothing is thrown either way, because every outcome leads to the same place —
 * tear down what can be reached, and quit.
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
    // Worth a line: the teardown about to run is one that may reach nothing,
    // and this is the only record of why a quit left panes behind.
    if (outcome === 'gave up') {
      onProblem(new Error(`the launch had not finished after ${graceMs}ms, so this quit is not waiting for it`))
    }
  } finally {
    // Otherwise the pending timer is one more thing holding a process that has
    // been asked to leave.
    clearTimeout(expiry)
  }
}
