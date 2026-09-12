// Adding a repository. The runtime validates the path; this only insists that
// something was typed and offers to infer the display name from it.

import { useState } from 'react'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Modal } from './Modal'

export function AddProjectDialog(): React.JSX.Element {
  const addProject = useWorkspaceStore((state) => state.addProject)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)

  const [path, setPath] = useState('')
  const [name, setName] = useState('')

  const inferred = path.split('/').filter(Boolean).pop() ?? ''
  const canSubmit = path.trim().length > 0

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (!canSubmit) return
    void addProject(path.trim(), name.trim() || undefined)
  }

  return (
    <Modal title="Add project" description="Point teamree at an existing git checkout." onClose={closeDialog}>
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span className="field__label">Repository path</span>
          <input
            className="field__input field__input--mono"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/Users/you/code/atlas"
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span className="field__label">Display name</span>
          <input
            className="field__input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={inferred || 'atlas'}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="field__hint">Optional — defaults to the folder name.</span>
        </label>

        <footer className="form__actions">
          <button type="button" className="button button--ghost" onClick={closeDialog}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={!canSubmit}>
            Add project
          </button>
        </footer>
      </form>
    </Modal>
  )
}
