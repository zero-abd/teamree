// Clone a URL into a destination, then add it. Auth is git's own credential
// helper's business; nothing here asks for a password.

import { useEffect, useRef, useState } from 'react'
import { DEFAULT_CLONE_PARENT, repositoryNameFromUrl } from '@shared/cloneDestination'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Modal } from './Modal'

const PROGRESS_POLL_MS = 300

/** `~/code` with the home folder spelt out, as the runtime will resolve it; `~` with no preload (a test). */
export function defaultParent(): string {
  const home = window.teamree?.homeDir
  return home ? `${home}${DEFAULT_CLONE_PARENT.slice(1)}` : DEFAULT_CLONE_PARENT
}

export function CloneProjectDialog(): React.JSX.Element {
  const cloneProject = useWorkspaceStore((state) => state.cloneProject)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)

  const [url, setUrl] = useState('')
  // Null until edited: until then it follows the URL, inside `parent`.
  const [editedDestination, setEditedDestination] = useState<string | null>(null)
  const [parent, setParent] = useState(defaultParent)
  const [running, setRunning] = useState<string | null>(null)
  const [line, setLine] = useState('')
  const [error, setError] = useState('')
  const cancelled = useRef(false)

  const name = repositoryNameFromUrl(url)
  const destination = editedDestination ?? (name ? `${parent}/${name}` : '')
  const canSubmit = url.trim().length > 0 && running === null

  useEffect(() => {
    if (running === null) return
    let live = true
    const timer = setInterval(() => {
      void runtimeClient
        .call('project.cloneProgress', { url: running })
        .then((progress) => {
          if (live && progress?.line) setLine(progress.line)
        })
        .catch(() => undefined)
    }, PROGRESS_POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [running])

  // Closing the dialog mid-clone is a cancel, not a clone left running unseen.
  const runningRef = useRef(running)
  runningRef.current = running
  useEffect(
    () => () => {
      if (runningRef.current === null) return
      void runtimeClient.call('project.cancelClone', { url: runningRef.current }).catch(() => undefined)
    },
    []
  )

  const cancel = (): void => {
    if (running === null) return
    cancelled.current = true
    void runtimeClient.call('project.cancelClone', { url: running }).catch(() => undefined)
  }

  const choose = async (): Promise<void> => {
    const chosen = await window.teamree?.chooseFolder(parent)
    if (!chosen) return
    setParent(chosen)
    setEditedDestination(null)
  }

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!canSubmit) return
    const target = url.trim()
    cancelled.current = false
    setError('')
    setLine('')
    setRunning(target)
    const failure = await cloneProject(target, destination.trim())
    setRunning(null)
    if (failure && !cancelled.current) setError(failure)
  }

  return (
    <Modal title="Clone Repository" onClose={closeDialog}>
      <form className="form" onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span className="field__label">Repository URL</span>
          <input
            className="field__input field__input--mono"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value)
              setError('')
            }}
            placeholder="git@github.com:you/repo.git"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            disabled={running !== null}
          />
        </label>
        <div className="clone__destination">
          <label className="field">
            <span className="field__label">Destination</span>
            <input
              className="field__input field__input--mono"
              value={destination}
              onChange={(event) => {
                setEditedDestination(event.target.value)
                setError('')
              }}
              placeholder={`${parent}/repo`}
              autoComplete="off"
              spellCheck={false}
              disabled={running !== null}
            />
          </label>
          <button type="button" className="button" onClick={() => void choose()} disabled={running !== null}>
            Choose…
          </button>
        </div>
        {running !== null ? <pre className="clone__progress">{line || 'Cloning…'}</pre> : null}
        {error ? (
          <span className="field__error" role="alert">
            {error}
          </span>
        ) : null}
        <footer className="modal__actions">
          {running !== null ? (
            <button type="button" className="button button--ghost" onClick={cancel}>
              Cancel
            </button>
          ) : (
            <button type="button" className="button button--ghost" onClick={closeDialog}>
              Cancel
            </button>
          )}
          <button type="submit" className="button button--primary" disabled={!canSubmit}>
            {running !== null ? 'Cloning…' : 'Clone'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}
