// Share on a markdown pane's bar: sends the page to every teammate online on its project, after a
// one-line confirm naming them. Dimmed, with the reason on hover, when there is nobody to send to.

import { useState } from 'react'
import { teammatesHeard, teamworkFacts } from '@shared/entities'
import { MAX_SHARED_NOTE_BYTES, NOTE_TOO_LARGE, sharedNoteBytes, type NoteShareResult } from '@shared/sharedNote'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'
import { notePayload, noteTitle } from './shareNote'

type Draft = { title: string; markdown: string; imagesLeftOut: number }

/** What the sender is told: who got it, and who did not and why. */
export function shareOutcome(result: NoteShareResult): string {
  const missed = result.missed.map((entry) => `${entry.handle} ${entry.reason}`).join(', ')
  if (result.delivered.length === 0) return `Not shared · ${missed}`
  return `Shared with ${result.delivered.join(', ')}${missed === '' ? '' : ` · ${missed}`}`
}

export function ShareNoteButton({
  worktreeId,
  path,
  getMarkdown
}: {
  worktreeId: string
  path: string
  getMarkdown: () => string
}): React.JSX.Element {
  const projectId = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === worktreeId)?.projectId)
  const facts = useWorkspaceStore((state) =>
    projectId === undefined ? undefined : teamworkFacts(state.teamwork[projectId])
  )
  const roster = useWorkspaceStore((state) =>
    projectId === undefined ? undefined : teammatesHeard(state.teammates[projectId])?.teammates
  )
  const [draft, setDraft] = useState<Draft | null>(null)
  const [sending, setSending] = useState(false)

  const online = (roster ?? []).filter((teammate) => teammate.connected).map((teammate) => teammate.handle)
  const offline = (roster ?? []).filter((teammate) => !teammate.connected).map((teammate) => teammate.handle)
  const reason =
    facts === undefined || facts.disabledReason !== null
      ? 'Teamwork off'
      : (roster ?? []).length === 0
        ? 'No teammates'
        : online.length === 0
          ? 'No teammates online'
          : null

  const ask = (): void => {
    const { markdown, imagesLeftOut } = notePayload(getMarkdown())
    const title = noteTitle(markdown, path)
    if (sharedNoteBytes(title, markdown) > MAX_SHARED_NOTE_BYTES) {
      useWorkspaceStore.getState().showNotice(NOTE_TOO_LARGE, 'error')
      return
    }
    setDraft({ title, markdown, imagesLeftOut })
  }

  const send = async (note: Draft): Promise<void> => {
    if (projectId === undefined) return
    const { showNotice } = useWorkspaceStore.getState()
    setSending(true)
    try {
      const result = await runtimeClient.call('teamwork.shareNote', {
        projectId,
        noteId: path,
        title: note.title,
        markdown: note.markdown
      })
      showNotice(shareOutcome(result), result.delivered.length === 0 ? 'error' : 'info')
    } catch (failure) {
      showNotice(`Not shared: ${failure instanceof Error ? failure.message : String(failure)}`, 'error')
    } finally {
      setSending(false)
      setDraft(null)
    }
  }

  if (draft !== null) {
    const extra = [
      ...(offline.length === 0 ? [] : [`${offline.join(', ')} offline`]),
      ...(draft.imagesLeftOut === 0
        ? []
        : [`${draft.imagesLeftOut} image${draft.imagesLeftOut === 1 ? '' : 's'} left out`])
    ]
    return (
      <span className="share-note" role="group" aria-label="Share note">
        <span className="share-note__ask">
          Share with {online.join(', ')}?
          {extra.length === 0 ? null : <span className="file__dir"> · {extra.join(' · ')}</span>}
        </span>
        <button type="button" className="pane__again" disabled={sending} onClick={() => void send(draft)}>
          Share
        </button>
        <button type="button" className="file__tool" disabled={sending} onClick={() => setDraft(null)}>
          Cancel
        </button>
      </span>
    )
  }

  return (
    <button
      type="button"
      className="file__tool"
      disabled={reason !== null}
      title={reason ?? 'Share with the team'}
      onClick={ask}
    >
      Share
    </button>
  )
}
