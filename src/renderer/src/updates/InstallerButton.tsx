import { useState } from 'react'
import type { InstallerStep } from './updateNotice'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Icon } from '../icons/Icon'

/** Restart to Update, or Download, progress, Open Installer: the card's and the Settings row's one button. */
export function InstallerButton({ step, className }: { step: InstallerStep; className: string }): React.JSX.Element {
  const downloadUpdate = useWorkspaceStore((state) => state.downloadUpdate)
  const fetchInstaller = useWorkspaceStore((state) => state.fetchInstaller)
  const openInstaller = useWorkspaceStore((state) => state.openInstaller)
  const restartToUpdate = useWorkspaceStore((state) => state.restartToUpdate)
  const update = useWorkspaceStore((state) => state.update)
  // Stays pressed through the quit; a refused swap, or any word from the quit's question, hands it back.
  const [pressedAt, setPressedAt] = useState<typeof update | undefined>(undefined)
  const restarting = pressedAt === update
  const run = {
    browser: downloadUpdate,
    fetch: fetchInstaller,
    open: openInstaller,
    restart: async () => {
      setPressedAt(update)
      if (!(await restartToUpdate())) setPressedAt(undefined)
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
      {restart ? <Icon name="restart" size={14} className="installer-button__icon" /> : null}
      {restarting ? 'Restarting…' : step.label}
    </button>
  )
}
