// Hand Off…: a roster teammate and a note for them. Sending pushes the branch, then offers it.

import { useEffect, useState } from 'react'
import { teammatesHeard } from '@shared/entities'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Modal } from './Modal'
import { Select } from './Select'

export function HandOffDialog({ worktreeId }: { worktreeId: string }): React.JSX.Element | null {
  const worktree = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === worktreeId))
  const presence = useWorkspaceStore((state) =>
    worktree === undefined ? undefined : state.teammates[worktree.projectId]
  )
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const teammates = teammatesHeard(presence)?.teammates ?? []
  const [to, setTo] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const task = worktree?.task
  useEffect(() => {
    let live = true
    void runtimeClient
      .call('teamwork.handoffDraft', { worktreeId })
      .then(({ note: draft }) => draft)
      .catch(() => task ?? '')
      .then((draft) => {
        if (live) setNote((current) => current ?? draft)
      })
    return () => {
      live = false
    }
  }, [worktreeId, task])

  if (worktree === undefined) return null
  const chosen = to ?? (teammates.find((person) => person.connected) ?? teammates[0])?.handle ?? ''

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (sending || chosen === '') return
    setSending(true)
    setError(null)
    try {
      await runtimeClient.call('teamwork.handOff', { worktreeId, to: chosen, note: (note ?? '').trim() })
      closeDialog()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setSending(false)
    }
  }

  return (
    <Modal title={`Hand Off ${worktree.name}`} onClose={closeDialog}>
      <form className="form hand-off" onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span className="field__label">To</span>
          <Select value={chosen} onChange={(event) => setTo(event.target.value)} disabled={sending} autoFocus>
            {teammates.length === 0 ? <option value="">No teammates</option> : null}
            {teammates.map((person) => (
              <option key={person.publicKey} value={person.handle}>
                {person.connected ? person.handle : `${person.handle} · away`}
              </option>
            ))}
          </Select>
        </label>
        <label className="field">
          <span className="field__label">Note</span>
          <textarea
            className="field__input"
            rows={8}
            value={note ?? ''}
            onChange={(event) => setNote(event.target.value)}
            spellCheck={true}
            disabled={sending}
          />
        </label>
        {error === null ? null : (
          <span className="field__error" role="alert">
            {error}
          </span>
        )}
        <footer className="modal__actions">
          <button type="button" className="button button--ghost" onClick={closeDialog}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={sending || chosen === ''}>
            {sending ? 'Pushing…' : 'Hand Off'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}
