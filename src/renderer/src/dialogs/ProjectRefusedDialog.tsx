// A picked or dropped folder the runtime would not add: the reason, and Initialize git when that is the fix.

import { useState } from 'react'
import type { ProjectAddRefusal } from '@shared/methods'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Modal } from './Modal'

export function ProjectRefusedDialog({
  folder,
  refusal
}: {
  folder: string
  refusal: ProjectAddRefusal
}): React.JSX.Element {
  const addProject = useWorkspaceStore((state) => state.addProject)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const [shown, setShown] = useState(refusal)
  const [adding, setAdding] = useState(false)

  const initialize = async (): Promise<void> => {
    setAdding(true)
    try {
      const answer = await addProject(folder, undefined, true)
      if (answer) setShown(answer)
    } finally {
      setAdding(false)
    }
  }

  return (
    <Modal title="Add project" onClose={closeDialog}>
      <div className="form">
        <span className="field__error" role="alert" title={folder}>
          {`${folderName(folder)}: ${shown === 'not-a-repository' ? 'Not a git repository' : 'No commits yet'}`}
        </span>
        <footer className="modal__actions">
          <button type="button" className="button button--ghost" onClick={closeDialog}>
            Cancel
          </button>
          {shown === 'not-a-repository' ? (
            <button
              type="button"
              className="button button--primary"
              data-default
              onClick={() => void initialize()}
              disabled={adding}
            >
              Initialize git
            </button>
          ) : null}
        </footer>
      </div>
    </Modal>
  )
}

function folderName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path
}
