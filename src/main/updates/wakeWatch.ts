// Electron's word for "this machine has been asleep". Imported lazily: the runtime runs
// headlessly outside Electron, where a top-level `import 'electron'` would crash.

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
    return noWatch
  }
}
