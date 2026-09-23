// Clone a URL into a destination, then add it. Auth is git's own credential
// helper's business; nothing here asks for a password.

import { useEffect, useRef, useState } from 'react'
import { DEFAULT_CLONE_PARENT, repositoryNameFromUrl } from '@shared/cloneDestination'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'

const PROGRESS_POLL_MS = 300

export function CloneProjectForm({ onBack }: { onBack: () => void }): React.JSX.Element {
  const cloneProject = useWorkspaceStore((state) => state.cloneProject)

  const [url, setUrl] = useState('')
  // Null until edited: until then it follows the URL.
  const [editedDestination, setEditedDestination] = useState<string | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [line, setLine] = useState('')
  const [error, setError] = useState('')
  const cancelled = useRef(false)

  const name = repositoryNameFromUrl(url)
  const destination = editedDestination ?? (name ? `${DEFAULT_CLONE_PARENT}/${name}` : '')
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
    <form className="form" onSubmit={(event) => void submit(event)}>
      <label className="field">
        <span className="field__label">Repository URL</span>
        <input
          className="field__input field__input--mono"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="git@github.com:you/repo.git"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          disabled={running !== null}
        />
      </label>
      <label className="field">
        <span className="field__label">Destination</span>
        <input
          className="field__input field__input--mono"
          value={destination}
          onChange={(event) => setEditedDestination(event.target.value)}
          placeholder={`${DEFAULT_CLONE_PARENT}/repo`}
          autoComplete="off"
          spellCheck={false}
          disabled={running !== null}
        />
      </label>
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
          <button type="button" className="button button--ghost" onClick={onBack}>
            Back
          </button>
        )}
        <button type="submit" className="button button--primary" disabled={!canSubmit}>
          {running !== null ? 'Cloning…' : 'Clone'}
        </button>
      </footer>
    </form>
  )
}
