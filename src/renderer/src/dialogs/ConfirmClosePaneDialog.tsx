// The second dialog in this app that exists to slow somebody down.
//
// Like the first, it is never shown speculatively: `closeTerminal` raises it
// only for a pane whose process is still doing work, so by the time it is on
// screen the answer to "is anything actually running" is already yes. The
// question is not "are you sure" but "this is what is there, and closing kills
// it".
//
// It reads the terminal out of the store rather than taking the sentences as
// props, so what it says is the pane's state now and not its state when the ×
// was pressed. A pane that finishes while the question is up stops warning
// about work that is no longer in flight, and the dialog closes itself: there
// is nothing left to ask about, and holding somebody at a question whose answer
// has stopped mattering is how a safeguard becomes a thing to click past.

import { useEffect } from 'react'
import { Modal } from './Modal'
import { closePaneWarning } from './closePaneModel'
import { useWorkspaceStore } from '../state/workspaceStore'

export function ConfirmClosePaneDialog({ terminalId }: { terminalId: string }): React.JSX.Element | null {
  const terminal = useWorkspaceStore((state) => state.terminals[terminalId])
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const forceCloseTerminal = useWorkspaceStore((state) => state.forceCloseTerminal)

  const warning = closePaneWarning(terminal)

  // In an effect rather than during the render, because closing the dialog is a
  // write to the same store this is reading. The pane going quiet underneath is
  // the ordinary way here — an agent answering the question it was holding, a
  // build finishing — and it is also what happens when the pane is closed from
  // somewhere else entirely while this is open.
  useEffect(() => {
    if (warning === null) closeDialog()
  }, [warning, closeDialog])

  if (warning === null) return null

  return (
    <Modal title={warning.title} onClose={closeDialog}>
      <div className="confirm">
        <p className="confirm__body">{warning.body}</p>
        <div className="confirm__actions">
          <button type="button" className="button" onClick={closeDialog}>
            Leave it open
          </button>
          <button
            type="button"
            className="button button--danger"
            onClick={() => {
              closeDialog()
              void forceCloseTerminal(terminalId)
            }}
          >
            {warning.confirm}
          </button>
        </div>
      </div>
    </Modal>
  )
}
