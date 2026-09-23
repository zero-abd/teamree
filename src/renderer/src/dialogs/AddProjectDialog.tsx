// Adding a repository: a picked folder is added at once, under its own name,
// or one is cloned. The picker opens from its button and nothing else.

import { useCallback, useRef, useState } from 'react'
import type { ProjectAddRefusal } from '@shared/methods'
import { useWorkspaceStore } from '../state/workspaceStore'
import { CloneProjectForm } from './CloneProjectForm'
import { Modal } from './Modal'

type AddProjectDialogProps = {
  /** A dropped folder the runtime already refused, with the refusal to show. */
  folder?: string
  refusal?: ProjectAddRefusal
}

export function AddProjectDialog({ folder, refusal }: AddProjectDialogProps): React.JSX.Element {
  const addProject = useWorkspaceStore((state) => state.addProject)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)

  const [cloning, setCloning] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [browseError, setBrowseError] = useState('')
  const [refused, setRefused] = useState(folder && refusal ? { path: folder, refusal } : null)
  const [adding, setAdding] = useState(false)
  const pickerOpen = useRef(false)

  const add = useCallback(
    async (path: string, init: boolean): Promise<void> => {
      setAdding(true)
      try {
        const answer = await addProject(path, undefined, init)
        setRefused(answer ? { path, refusal: answer } : null)
      } finally {
        setAdding(false)
      }
    },
    [addProject]
  )

  const browse = useCallback(async (): Promise<void> => {
    if (pickerOpen.current) return
    pickerOpen.current = true
    setBrowsing(true)
    setBrowseError('')
    let selected: string | null = null
    try {
      selected = await window.teamree.selectProjectFolder()
    } catch {
      setBrowseError('Could not open the folder picker')
    } finally {
      pickerOpen.current = false
      setBrowsing(false)
    }
    if (selected) await add(selected, false)
  }, [add])

  if (cloning) {
    return (
      <Modal title="Clone repository" onClose={closeDialog}>
        <CloneProjectForm onBack={() => setCloning(false)} />
      </Modal>
    )
  }

  return (
    <Modal title="Add project" onClose={closeDialog}>
      <div className="form">
        <div className="add-project__choices">
          <button
            type="button"
            className="button button--primary"
            onClick={() => void browse()}
            disabled={browsing || adding}
          >
            {browsing ? 'Choosing Folder…' : 'Choose Folder…'}
          </button>
          <button type="button" className="button" onClick={() => setCloning(true)} disabled={adding}>
            Clone…
          </button>
        </div>
        {browseError ? <p role="alert">{browseError}</p> : null}
        {refused ? (
          <div className="field__refusal">
            <span className="field__error" role="alert" title={refused.path}>
              {`${folderName(refused.path)}: ${
                refused.refusal === 'not-a-repository' ? 'Not a git repository' : 'No commits yet'
              }`}
            </span>
            {refused.refusal === 'not-a-repository' ? (
              <button
                type="button"
                className="button button--small"
                data-default
                onClick={() => void add(refused.path, true)}
                disabled={adding}
              >
                Initialize git
              </button>
            ) : null}
          </div>
        ) : null}
        <footer className="modal__actions">
          <button type="button" className="button button--ghost" onClick={closeDialog}>
            Cancel
          </button>
        </footer>
      </div>
    </Modal>
  )
}

function folderName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path
}
