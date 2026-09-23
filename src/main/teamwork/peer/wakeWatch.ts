// The OS's word for "this machine has been asleep". Imported lazily: the runtime runs headlessly outside
// Electron, where a top-level `import 'electron'` would crash. Without it this is a no-op and `peerLink.ts`
// reaches the same conclusion from its own clocks, only later. `resume` only: `suspend` leaves no time to act.

/** Subscribes to "this machine woke up"; returns the unsubscribe. */
export type WakeWatch = (onWake: () => void) => Promise<() => void>

const noWatch = (): void => {}

export const watchForWake: WakeWatch = async (onWake) => {
  // Asked of the process rather than of the import: outside Electron `electron` resolves to a path string.
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
    // Links still notice a sleep for themselves.
    return noWatch
  }
}
