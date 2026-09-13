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

export type QuitSequenceOptions = {
  /**
   * Releases everything the app holds. `Runtime.stop`, which kills the PTYs,
   * closes the CLI socket and flushes both the workspace file and the
   * scrollback archive.
   */
  stop: () => Promise<void>
  /** Asks for the quit again once `stop` has finished. `app.quit`. */
  quit: () => void
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
