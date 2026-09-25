import type { InstallerStep } from './updateNotice'
import { useWorkspaceStore } from '../state/workspaceStore'

/** Restart to Update, or Download, progress, Open Installer: the card's and the Settings row's one button. */
export function InstallerButton({ step, className }: { step: InstallerStep; className: string }): React.JSX.Element {
  const downloadUpdate = useWorkspaceStore((state) => state.downloadUpdate)
  const fetchInstaller = useWorkspaceStore((state) => state.fetchInstaller)
  const openInstaller = useWorkspaceStore((state) => state.openInstaller)
  const restartToUpdate = useWorkspaceStore((state) => state.restartToUpdate)
  const run = {
    browser: downloadUpdate,
    fetch: fetchInstaller,
    open: openInstaller,
    restart: restartToUpdate,
    progress: null
  }[step.kind]

  return (
    <button
      type="button"
      className={className}
      disabled={run === null}
      onClick={() => {
        if (run !== null) void run()
      }}
    >
      {step.label}
    </button>
  )
}
