// Adding a repository. The runtime validates the path; this only insists that
// something was typed and offers to infer the display name from it.
//
// The folder picker opens from its button and from nothing else. It used to
// open from a mount effect, which put an OS sheet over the dialog before the
// dialog had been read — and over a path field somebody may have meant to type
// into.

import { useCallback, useRef, useState } from 'react'
import type { ProjectAddRefusal } from '@shared/methods'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Modal } from './Modal'

export function AddProjectDialog(): React.JSX.Element {
  const addProject = useWorkspaceStore((state) => state.addProject)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)

  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [browsing, setBrowsing] = useState(false)
  const [browseError, setBrowseError] = useState('')
  const [refused, setRefused] = useState<{ path: string; refusal: ProjectAddRefusal } | null>(null)
  const [adding, setAdding] = useState(false)
  const pickerOpen = useRef(false)

  const inferred = path.split(/[/\\]/).filter(Boolean).pop() ?? ''
  const browse = useCallback(async (): Promise<void> => {
    if (pickerOpen.current) return
    pickerOpen.current = true
    setBrowsing(true)
    setBrowseError('')
    try {
      const selected = await window.teamree.selectProjectFolder()
      if (selected) setPath(selected)
    } catch {
      setBrowseError('Could not open the folder picker. You can enter the path below.')
    } finally {
      pickerOpen.current = false
      setBrowsing(false)
    }
  }, [])
  const canSubmit = path.trim().length > 0 && !adding
  // Keyed by path so an edit to the field retires the refusal without an effect.
  const refusal = refused?.path === path.trim() ? refused.refusal : null

  const add = async (init: boolean): Promise<void> => {
    const target = path.trim()
    setAdding(true)
    try {
      const answer = await addProject(target, name.trim() || undefined, init)
      setRefused(answer ? { path: target, refusal: answer } : null)
    } finally {
      setAdding(false)
    }
  }

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (!canSubmit) return
    void add(false)
  }

  return (
    <Modal title="Add project" description="Point teamree at an existing git checkout." onClose={closeDialog}>
      <form className="form" onSubmit={submit}>
        <button type="button" className="button" onClick={() => void browse()} disabled={browsing}>
          {browsing ? 'Choosing folder…' : 'Choose folder…'}
        </button>
        {browseError ? <p role="alert">{browseError}</p> : null}
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
        {refusal ? (
          <div className="field__refusal">
            <span className="field__error" role="alert">
              {refusal === 'not-a-repository' ? 'Not a git repository' : 'No commits yet'}
            </span>
            {refusal === 'not-a-repository' ? (
              <button type="button" className="button button--small" onClick={() => void add(true)} disabled={adding}>
                Initialize git
              </button>
            ) : null}
          </div>
        ) : null}

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

        <footer className="modal__actions">
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
