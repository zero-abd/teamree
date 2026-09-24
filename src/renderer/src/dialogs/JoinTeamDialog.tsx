// Joining from an invitation: where the checkout goes (or the one already
// here), and one button. What the button does is `joinTeam.ts`'s.

import { useEffect, useState } from 'react'
import { repositoryNameFromUrl } from '@shared/cloneDestination'
import type { Invitation } from '@shared/invitation'
import { checkOrigin, normaliseRemote } from '@shared/origin'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'
import type { JoinStage } from '../teamwork/joinTeam'
import { defaultParent } from './CloneProjectDialog'
import { Modal } from './Modal'

const STAGE_WORDS: Record<JoinStage, string> = {
  clone: 'Cloning…',
  read: 'Reading the project…',
  key: 'Adding your key…',
  push: 'Pushing…'
}

export function JoinTeamDialog({ invitation }: { invitation: Invitation }): React.JSX.Element {
  const projects = useWorkspaceStore((state) => state.projects)
  const joining = useWorkspaceStore((state) => state.joining)
  const joinTeam = useWorkspaceStore((state) => state.joinTeam)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)

  const [parent, setParent] = useState(defaultParent)
  const [edited, setEdited] = useState<string | null>(null)
  // The project here with the invitation's origin, once every project has been asked.
  const [existing, setExisting] = useState<string | null>(null)
  const [useExisting, setUseExisting] = useState(true)

  const wanted = checkOrigin(invitation.origin)
  useEffect(() => {
    if (!wanted.ok) return
    let live = true
    void Promise.all(
      projects.map(async (project) => {
        const status = await runtimeClient.call('teamwork.status', { projectId: project.id }).catch(() => null)
        return status?.state === 'read' && status.origin.ok && normaliseRemote(status.origin.url) === wanted.normalised
          ? project.id
          : null
      })
    ).then((found) => {
      if (live) setExisting(found.find((id) => id !== null) ?? null)
    })
    return () => {
      live = false
    }
  }, [projects, wanted.ok, wanted.ok ? wanted.normalised : null])

  const running = joining !== null && joining.error === null
  const found = projects.find((project) => project.id === existing)
  const reuse = found !== undefined && useExisting
  const destination = edited ?? `${parent}/${repositoryNameFromUrl(invitation.origin) || 'repository'}`

  const choose = async (): Promise<void> => {
    const chosen = await window.teamree?.chooseFolder(parent)
    if (!chosen) return
    setParent(chosen)
    setEdited(null)
  }

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (running || (!reuse && destination.trim() === '')) return
    void joinTeam(invitation, reuse ? { projectId: found.id } : { clone: destination.trim() })
  }

  return (
    <Modal title={`Join ${invitation.project} (from ${invitation.from})`} onClose={closeDialog}>
      <form className="form" onSubmit={submit}>
        <p className="join__origin">{invitation.origin}</p>
        {reuse ? (
          <div className="clone__destination">
            <p className="join__existing">
              {found.name} <span className="join__path">{found.path}</span>
            </p>
            <button type="button" className="button" onClick={() => setUseExisting(false)} disabled={running}>
              Clone Again…
            </button>
          </div>
        ) : (
          <div className="clone__destination">
            <label className="field">
              <span className="field__label">Destination</span>
              <input
                className="field__input field__input--mono"
                value={destination}
                onChange={(event) => setEdited(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={running}
              />
            </label>
            <button type="button" className="button" onClick={() => void choose()} disabled={running}>
              Choose…
            </button>
            {found === undefined ? null : (
              <button type="button" className="button" onClick={() => setUseExisting(true)} disabled={running}>
                Use Existing Checkout
              </button>
            )}
          </div>
        )}
        {running ? <pre className="clone__progress">{STAGE_WORDS[joining.stage]}</pre> : null}
        {joining?.error ? (
          <span className="field__error" role="alert">
            {joining.error}
          </span>
        ) : null}
        <footer className="modal__actions">
          <button type="button" className="button button--ghost" onClick={closeDialog}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={running}>
            {running ? 'Joining…' : 'Join'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}
