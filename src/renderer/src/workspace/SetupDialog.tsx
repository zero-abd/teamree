// Help's Setup…: the welcome's rows again, once there is no welcome to come back to.

import { Modal } from '../dialogs/Modal'
import { useWorkspaceStore } from '../state/workspaceStore'
import { SetupRows } from './SetupRows'

export function SetupDialog(): React.JSX.Element {
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  return (
    <Modal title="Setup" onClose={closeDialog}>
      <SetupRows />
      <div className="modal__actions">
        <button type="button" className="button button--primary" onClick={closeDialog}>
          Done
        </button>
      </div>
    </Modal>
  )
}
