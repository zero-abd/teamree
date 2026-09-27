// A worktree's past Claude Code and Codex conversations, newest first; the one chosen resumes in a new pane,
// or in the ended pane it was opened from when that pane runs the same agent.

import { useEffect, useState } from 'react'
import type { AgentConversation } from '@shared/entities'
import { AgentGlyph } from '../agents/glyphs'
import { harnessName } from '../agents/harnesses'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { agoLabel } from '../sidebar/agentRows'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Modal } from './Modal'

type Listing =
  | { phase: 'loading' }
  | { phase: 'ready'; conversations: AgentConversation[] }
  | { phase: 'error'; message: string }

export const RESUME_CONVERSATION_TITLE = 'Resume Conversation'

const keyOf = (conversation: AgentConversation): string => `${conversation.agent}:${conversation.sessionId}`

export function ResumeConversationDialog({
  worktreeId,
  terminalId
}: {
  worktreeId: string
  terminalId?: string
}): React.JSX.Element {
  const agents = useWorkspaceStore((state) => state.agents)
  const resumeConversation = useWorkspaceStore((state) => state.resumeConversation)
  const relaunchTerminal = useWorkspaceStore((state) => state.relaunchTerminal)
  const pane = useWorkspaceStore((state) => (terminalId === undefined ? undefined : state.terminals[terminalId]))
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)

  const [listing, setListing] = useState<Listing>({ phase: 'loading' })
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    runtimeClient.call('agent.conversations', { worktreeId }).then(
      (conversations) => live && setListing({ phase: 'ready', conversations }),
      (error: unknown) =>
        live && setListing({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
    )
    return () => {
      live = false
    }
  }, [worktreeId])

  const installed = (conversation: AgentConversation): boolean =>
    agents.some((agent) => agent.kind === conversation.agent)
  const wanted = query.trim().toLowerCase()
  const rows =
    listing.phase === 'ready'
      ? listing.conversations.filter((conversation) =>
          `${conversation.title ?? ''} ${conversation.prompt} ${harnessName(conversation.agent)}`
            .toLowerCase()
            .includes(wanted)
        )
      : []
  const choosable = rows.filter(installed)
  const row = choosable.find((entry) => keyOf(entry) === chosen) ?? choosable[0]

  const move = (by: number): void => {
    if (choosable.length === 0) return
    const at = row === undefined ? -1 : choosable.indexOf(row)
    const next = choosable[(at + by + choosable.length) % choosable.length]
    setChosen(next === undefined ? null : keyOf(next))
  }

  const resume = (conversation: AgentConversation | undefined): void => {
    if (conversation === undefined || !installed(conversation)) return
    closeDialog()
    if (pane !== undefined && !pane.running && pane.agent === conversation.agent) {
      void relaunchTerminal(pane.id, { resume: conversation.sessionId })
    } else {
      void resumeConversation(worktreeId, conversation.agent, conversation.sessionId)
    }
  }

  return (
    <Modal title={RESUME_CONVERSATION_TITLE} onClose={closeDialog}>
      <form
        className="form palette"
        onSubmit={(event) => {
          event.preventDefault()
          resume(row)
        }}
      >
        <input
          className="palette__input"
          aria-label="Filter"
          placeholder="Filter conversations"
          value={query}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              move(event.key === 'ArrowDown' ? 1 : -1)
            }
          }}
        />
        {listing.phase === 'loading' ? <p className="palette__empty">Reading…</p> : null}
        {listing.phase === 'error' ? <p className="palette__empty">{listing.message}</p> : null}
        {listing.phase === 'ready' && rows.length === 0 ? (
          <p className="palette__empty">{wanted === '' ? 'No past conversations' : 'No matches'}</p>
        ) : null}
        {rows.length === 0 ? null : (
          <ul className="palette__list" role="listbox" aria-label="Conversations">
            {rows.map((entry) => {
              const usable = installed(entry)
              const selected = entry === row
              return (
                <li key={keyOf(entry)} role="option" aria-selected={selected} aria-disabled={!usable || undefined}>
                  <button
                    type="button"
                    className={`palette__row${selected ? ' palette__row--selected' : ''}${
                      usable ? '' : ' palette__row--dimmed'
                    }`}
                    disabled={!usable}
                    title={usable ? entry.prompt : `${harnessName(entry.agent)} not installed`}
                    onClick={() => setChosen(keyOf(entry))}
                    onDoubleClick={() => resume(entry)}
                  >
                    <AgentGlyph kind={entry.agent} />
                    <span className="palette__label">{entry.title ?? entry.prompt}</span>
                    <span className="palette__trailing">
                      {`${agoLabel(Date.now() - entry.updatedAt)} · ${entry.messages} ${
                        entry.messages === 1 ? 'message' : 'messages'
                      }`}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        <footer className="modal__actions">
          <button type="button" className="button button--ghost" onClick={closeDialog}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={row === undefined}>
            Resume
          </button>
        </footer>
      </form>
    </Modal>
  )
}
