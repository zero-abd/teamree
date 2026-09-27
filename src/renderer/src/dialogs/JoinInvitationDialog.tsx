// Join a Team…: paste the invitation, and the Join sheet takes over.

import { useState } from 'react'
import { parsePastedInvitation } from '@shared/invitation'
import { useWorkspaceStore } from '../state/workspaceStore'
import { INVITATION_PLACEHOLDER } from '../teamwork/startTeamwork'
import { Modal } from './Modal'

export function JoinInvitationDialog(): React.JSX.Element {
  const openInvitation = useWorkspaceStore((state) => state.openInvitation)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const [raw, setRaw] = useState('')
  const [refused, setRefused] = useState<string | null>(null)

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (raw.trim() !== '') setRefused(openInvitation(raw))
  }

  return (
    <Modal title="Join a Team" onClose={closeDialog}>
      <form className="form" onSubmit={submit}>
        <input
          className="field__input field__input--mono"
          aria-label="Invitation"
          placeholder={INVITATION_PLACEHOLDER}
          value={raw}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            const value = event.target.value
            setRaw(value)
            setRefused(null)
            // A paste opens the sheet at once; half-typed text waits for Join.
            if (parsePastedInvitation(value).ok) openInvitation(value)
          }}
        />
        {refused === null ? null : (
          <span className="field__error" role="alert">
            {refused}
          </span>
        )}
        <footer className="modal__actions">
          <button type="button" className="button button--ghost" onClick={closeDialog}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={raw.trim() === ''}>
            Join
          </button>
        </footer>
      </form>
    </Modal>
  )
}
