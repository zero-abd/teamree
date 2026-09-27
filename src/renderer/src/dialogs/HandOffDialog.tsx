// Hand Off…: a roster teammate and a note for them. Sending stops the agent and commits the
// uncommitted work when asked, pushes the branch, then offers it.

import { useEffect, useMemo, useState } from 'react'
import { teammatesHeard } from '@shared/entities'
import { harnessName } from '../agents/harnesses'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'
import { commitSuggestion } from '../workspace/rightPanel/commitMessage'
import { Modal } from './Modal'
import { Select } from '../ui/Select'
import { Textarea } from '../ui/Input'

export function HandOffDialog({ worktreeId }: { worktreeId: string }): React.JSX.Element | null {
  const worktree = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === worktreeId))
  const presence = useWorkspaceStore((state) =>
    worktree === undefined ? undefined : state.teammates[worktree.projectId]
  )
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const status = useWorkspaceStore((state) => state.statuses[worktreeId])
  const pending = useWorkspaceStore((state) => state.changes[worktreeId]?.total ?? 0)
  const terminals = useWorkspaceStore((state) => state.terminals)
  const agents = useMemo(
    () => [
      ...new Set(
        Object.values(terminals).flatMap((pane) =>
          pane.worktreeId === worktreeId && pane.running && pane.agent !== undefined ? [pane.agent] : []
        )
      )
    ],
    [terminals, worktreeId]
  )
  const teammates = teammatesHeard(presence)?.teammates ?? []
  const [to, setTo] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [include, setInclude] = useState(true)
  const [message, setMessage] = useState<string | null>(null)
  const [stop, setStop] = useState(true)
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
  const uncommitted = Math.max(pending, status === undefined ? 0 : status.staged + status.unstaged + status.untracked)
  const files = `${uncommitted} ${uncommitted === 1 ? 'File' : 'Files'}`
  const shownMessage = message ?? `WIP: ${commitSuggestion(worktree)?.text ?? worktree.name}`
  const committing = uncommitted > 0 && include
  const stopping = agents.length > 0 && stop
  const blocked = chosen === '' || (committing && shownMessage.trim() === '')

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (sending || blocked) return
    setSending(true)
    setError(null)
    try {
      await runtimeClient.call('teamwork.handOff', {
        worktreeId,
        to: chosen,
        note: (note ?? '').trim(),
        ...(committing ? { commit: shownMessage.trim() } : {}),
        ...(stopping ? { stopAgents: true } : {})
      })
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
          <Textarea
            rows={8}
            value={note ?? ''}
            onChange={(event) => setNote(event.target.value)}
            spellCheck={true}
            disabled={sending}
          />
        </label>
        {uncommitted === 0 ? null : (
          <label className="confirm__check">
            <input
              type="checkbox"
              checked={include}
              disabled={sending}
              onChange={(event) => setInclude(event.target.checked)}
            />
            {`Commit ${files} as WIP`}
          </label>
        )}
        {committing ? (
          <Textarea
            className="field__message"
            rows={1}
            value={shownMessage}
            aria-label="Commit message"
            disabled={sending}
            onChange={(event) => setMessage(event.target.value)}
          />
        ) : uncommitted === 0 ? null : (
          <span className="field__hint">{`${uncommitted} uncommitted ${
            uncommitted === 1 ? 'file stays' : 'files stay'
          } here`}</span>
        )}
        {agents.length === 0 ? null : (
          <label className="confirm__check">
            <input
              type="checkbox"
              checked={stop}
              disabled={sending}
              onChange={(event) => setStop(event.target.checked)}
            />
            {`Stop ${agents.length === 1 && agents[0] !== undefined ? harnessName(agents[0]) : 'Agents'} in This Task`}
          </label>
        )}
        {error === null ? null : (
          <span className="field__error" role="alert">
            {error}
          </span>
        )}
        <footer className="modal__actions">
          <button type="button" className="button button--ghost" onClick={closeDialog}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={sending || blocked}>
            {sending ? 'Handing Off…' : 'Hand Off'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}
