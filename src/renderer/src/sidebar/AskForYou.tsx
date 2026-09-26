// A task's question for you, under its row: the question, its options as buttons, and Reply… for anything else.

import { useState } from 'react'
import type { TaskMessage } from '@shared/messages'
import { useMessageStore } from '../state/messages'

export function AskForYou({ ask }: { ask: TaskMessage }): React.JSX.Element {
  const answer = useMessageStore((state) => state.answer)
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

  return (
    <div className="worktree__ask" role="group" aria-label={`Question #${ask.id}`}>
      <p className="worktree__ask-text" title={ask.text}>
        {ask.text}
      </p>
      {replying ? (
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
      ) : (
        <span className="answers">
          {(ask.options ?? []).map((option) => (
            <button
              key={option}
              type="button"
              className="button button--tiny answers__choice"
              disabled={sending}
              onClick={() => void send(option)}
            >
              {option}
            </button>
          ))}
          <button type="button" className="button button--ghost button--tiny" onClick={() => setReplying(true)}>
            Reply…
          </button>
        </span>
      )}
    </div>
  )
}
