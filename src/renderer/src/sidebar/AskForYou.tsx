// A task's question for you, under its row: the question, its options as buttons, and Reply… for anything else.
// Once the agent stops waiting it says so, and an answer goes as a note.

import { useState } from 'react'
import type { TaskMessage } from '@shared/messages'
import { useMessageStore, waitedOn } from '../state/messages'
import { AnswerChoices } from './AnswerButtons'

export function AskForYou({ ask, compact = false }: { ask: TaskMessage; compact?: boolean }): React.JSX.Element {
  const answer = useMessageStore((state) => state.answer)
  const dismiss = useMessageStore((state) => state.dismiss)
  const lapsed = !waitedOn(ask)
  const [answering, setAnswering] = useState(false)
  const [replying, setReplying] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  const send = async (text: string): Promise<void> => {
    setSending(true)
    const sent = await answer(ask, text)
    setSending(false)
    if (sent) {
      setReplying(false)
      setDraft('')
    }
  }

  const actions = replying ? (
    <form
      className="worktree__ask-reply"
      onSubmit={(event) => {
        event.preventDefault()
        void send(draft)
      }}
    >
      <input
        className="worktree__ask-field"
        aria-label="Answer"
        placeholder="Answer"
        value={draft}
        disabled={sending}
        autoComplete="off"
        autoFocus
        data-own-escape
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setReplying(false)
        }}
      />
    </form>
  ) : lapsed && !answering ? (
    <AnswerChoices choices={[]} onChoose={() => {}}>
      <button type="button" className="button button--tiny" onClick={() => setAnswering(true)}>
        Send Anyway…
      </button>
      <button type="button" className="button button--ghost button--tiny" onClick={() => void dismiss(ask)}>
        Dismiss
      </button>
    </AnswerChoices>
  ) : (
    <AnswerChoices
      choices={(ask.options ?? []).map((label) => ({ label }))}
      onChoose={(index) => {
        const option = ask.options?.[index]
        if (option !== undefined) void send(option)
      }}
      disabled={sending}
    >
      <button type="button" className="button button--ghost button--tiny" onClick={() => setReplying(true)}>
        Reply…
      </button>
    </AnswerChoices>
  )

  return (
    <div
      className={`worktree__ask${compact ? ' worktree__ask--compact' : ''}${lapsed ? ' worktree__ask--lapsed' : ''}`}
      role="group"
      aria-label={`Question #${ask.id}`}
    >
      {lapsed ? <p className="worktree__ask-lapsed">{lapsedWords(ask)}</p> : null}
      <p className="worktree__ask-text" title={ask.text}>
        {ask.text}
      </p>
      {actions}
    </div>
  )
}

/** Why nothing waits on the ask any more: only a timeout is said as one. */
export function lapsedWords(ask: Pick<TaskMessage, 'expiredBy'>): string {
  if (ask.expiredBy === 'app') return 'Ask ended with the app'
  if (ask.expiredBy === 'agent') return 'The agent stopped'
  return 'Timed out · the agent moved on'
}
