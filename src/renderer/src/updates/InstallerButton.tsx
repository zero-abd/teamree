import { useState } from 'react'
import type { InstallerStep } from './updateNotice'
import { useWorkspaceStore } from '../state/workspaceStore'

/** Restart to Update, or Download, progress, Open Installer: the card's and the Settings row's one button. */
export function InstallerButton({ step, className }: { step: InstallerStep; className: string }): React.JSX.Element {
  const downloadUpdate = useWorkspaceStore((state) => state.downloadUpdate)
  const fetchInstaller = useWorkspaceStore((state) => state.fetchInstaller)
  const openInstaller = useWorkspaceStore((state) => state.openInstaller)
  const restartToUpdate = useWorkspaceStore((state) => state.restartToUpdate)
  // Stays pressed through the quit; a refused swap hands the button back.
  const [restarting, setRestarting] = useState(false)
  const run = {
    browser: downloadUpdate,
    fetch: fetchInstaller,
    open: openInstaller,
    restart: async () => {
      setRestarting(true)
      if (!(await restartToUpdate())) setRestarting(false)
    },
    progress: null
  }[step.kind]
  const restart = step.kind === 'restart'

  return (
    <button
      type="button"
      className={restart ? `${className} installer-button--restart` : className}
      disabled={run === null || restarting}
      aria-busy={restarting || undefined}
      onClick={() => {
        if (run !== null) void run()
      }}
    >
      {restart ? (
        <svg className="installer-button__icon" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
          <path d="M12.5 1.8v2.8H9.7" />
        </svg>
      ) : null}
      {restarting ? 'Restarting…' : step.label}
    </button>
  )
}
