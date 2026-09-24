// Asked only for a pane whose process is working. It reads the terminal live from the store, so if the
// pane finishes while this is up the dialog closes itself.

import { useEffect } from 'react'
import { Confirm } from './Confirm'
import { closePaneWarning } from './closePaneModel'
import { useWorkspaceStore } from '../state/workspaceStore'

export function ConfirmClosePaneDialog({ terminalId }: { terminalId: string }): React.JSX.Element | null {
  const terminal = useWorkspaceStore((state) => state.terminals[terminalId])
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const forceCloseTerminal = useWorkspaceStore((state) => state.forceCloseTerminal)

  const warning = closePaneWarning(terminal)

  // In an effect: closing writes to the store this reads.
  useEffect(() => {
    if (warning === null) closeDialog()
  }, [warning, closeDialog])

  if (warning === null) return null

  return (
    <Confirm
      title={warning.title}
      body={warning.body}
      cancel="Leave Open"
      confirm={warning.confirm}
      onCancel={closeDialog}
      onConfirm={() => {
        closeDialog()
        void forceCloseTerminal(terminalId)
      }}
    />
  )
}
