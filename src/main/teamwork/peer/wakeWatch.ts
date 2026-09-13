// The operating system's word for "this machine has been asleep", for the links
// that have to stop believing things when it has.
//
// Imported lazily, the way `startRuntime.ts` imports its IPC bridge: the runtime
// has to keep working headlessly outside Electron — the acceptance suite drives
// it under plain Node — so a top-level `import 'electron'` here would be a crash
// rather than a missing feature. Without Electron this is a no-op, and nothing
// depends on it: `peerLink.ts` reaches the same conclusion from its own clocks.
// What the power event buys is that it reaches it at once, instead of at the
// next deadline that happens to fire.
//
// `resume` only. `suspend` arrives with milliseconds left before the process
// stops running, and there is nothing useful to do in them — whatever a link
// believed is stale either way, and it is on waking that somebody is there to
// be told.

/** Subscribes to "this machine woke up"; returns the unsubscribe. */
export type WakeWatch = (onWake: () => void) => Promise<() => void>

const noWatch = (): void => {}

export const watchForWake: WakeWatch = async (onWake) => {
  // Asked of the process rather than of the import: outside Electron `electron`
  // resolves to a path string, and importing it to find that out is a cost with
  // no answer in it.
  if (!process.versions.electron) return noWatch

  try {
    const { powerMonitor } = await import('electron')
    if (typeof powerMonitor?.on !== 'function') return noWatch
    const resumed = (): void => onWake()
    powerMonitor.on('resume', resumed)
    return () => {
      powerMonitor.off('resume', resumed)
    }
  } catch {
    // A main process that cannot subscribe to power events still has links
    // worth running, and they still notice a sleep for themselves.
    return noWatch
  }
}
