// The Changes panel's Context: this task's claims and notes, editable, and the siblings'
// claims and decisions that touch its paths, read-only. Everything comes from `memory.list`.

import { useMemo, useState } from 'react'
import type { MemoryNote } from '@shared/memory'
import { ledgerWrites, useLedger } from '../../state/ledgerStore'
import { useWorkspaceStore } from '../../state/workspaceStore'
import { worktreeDisplay } from '../../sidebar/worktreeDisplay'
import { worktreeContext } from './contextModel'

export function ContextSection({ worktreeId }: { worktreeId: string }): React.JSX.Element | null {
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const projectId = worktrees.find((row) => row.id === worktreeId)?.projectId
  const memory = useLedger((state) => (projectId === undefined ? undefined : state.byProject[projectId]))
  const context = useMemo(() => worktreeContext(memory, worktreeId), [memory, worktreeId])
  const [claiming, setClaiming] = useState(false)
  if (projectId === undefined) return null

  const nameOf = (id: string): string => {
    const row = worktrees.find((entry) => entry.id === id)
    return row === undefined ? id : worktreeDisplay(row).title
  }

  return (
    <section className="context" aria-label="Context">
      <h3 className="commits__title">
        Context
        <button type="button" className="context__add" onClick={() => setClaiming(true)}>
          Add Claim…
        </button>
      </h3>
      {claiming ? (
        <LineField
          label="Claim"
          placeholder="src/api/**"
          autoFocus
          onSubmit={(glob) => {
            setClaiming(false)
            write(ledgerWrites.claim(worktreeId, glob))
          }}
          onCancel={() => setClaiming(false)}
        />
      ) : null}
      <ContextRows worktreeId={worktreeId} claims={context.claims} notes={context.notes} editable />
      {context.siblings.map((sibling) => (
        <div className="context__sibling" role="group" aria-label={nameOf(sibling.worktreeId)} key={sibling.worktreeId}>
          <p className="context__name">{nameOf(sibling.worktreeId)}</p>
          <ContextRows worktreeId={sibling.worktreeId} claims={sibling.claims} notes={sibling.notes} editable={false} />
        </div>
      ))}
      <LineField label="Note" placeholder="Note…" onSubmit={(text) => write(ledgerWrites.decide(worktreeId, text))} />
    </section>
  )
}

/** One task's claims and notes; `editable` adds Resolve on open questions and × on everything of its own. */
export function ContextRows({
  worktreeId,
  claims,
  notes,
  editable
}: {
  worktreeId: string
  claims: readonly string[]
  notes: readonly MemoryNote[]
  editable: boolean
}): React.JSX.Element | null {
  if (claims.length === 0 && notes.length === 0) return null
  return (
    <ul className="context__list">
      {claims.map((glob) => (
        <li className="context__row" key={`claim:${glob}`}>
          <span className="context__mark" aria-hidden="true">
            ⚑
          </span>
          <span className="context__glob">{glob}</span>
          {editable ? (
            <button
              type="button"
              className="context__x"
              aria-label={`Unclaim ${glob}`}
              title="Unclaim"
              onClick={() => write(ledgerWrites.unclaim(worktreeId, glob))}
            >
              ×
            </button>
          ) : null}
        </li>
      ))}
      {notes.map((note) => {
        const own = editable && note.author === 'me'
        return (
          <li className={`context__row context__row--${note.kind}`} key={note.id}>
            <span className="context__mark" role="img" aria-label={note.kind === 'question' ? 'Question' : 'Decision'}>
              {note.kind === 'question' ? '?' : '◆'}
            </span>
            <span className="context__text">{note.text}</span>
            {note.paths === undefined ? null : <span className="context__paths">{note.paths.join(', ')}</span>}
            {own && note.kind === 'question' ? (
              <button type="button" className="context__resolve" onClick={() => write(ledgerWrites.resolve(note.id))}>
                Resolve
              </button>
            ) : null}
            {own ? (
              <button
                type="button"
                className="context__x"
                aria-label={`Forget ${note.text}`}
                title="Forget"
                onClick={() => write(ledgerWrites.forget(note.id))}
              >
                ×
              </button>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

function write(pending: Promise<unknown>): void {
  pending.catch((error: unknown) =>
    useWorkspaceStore
      .getState()
      .showNotice(`Could not update context: ${error instanceof Error ? error.message : String(error)}`, 'error')
  )
}

function LineField({
  label,
  placeholder,
  autoFocus = false,
  onSubmit,
  onCancel
}: {
  label: string
  placeholder: string
  autoFocus?: boolean
  onSubmit: (text: string) => void
  onCancel?: () => void
}): React.JSX.Element {
  const [value, setValue] = useState('')
  return (
    <input
      className="changes__message context__field"
      aria-label={label}
      placeholder={placeholder}
      value={value}
      autoFocus={autoFocus}
      spellCheck={false}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => {
        if (value.trim() === '') onCancel?.()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && onCancel !== undefined) {
          event.stopPropagation()
          onCancel()
        } else if (event.key === 'Enter') {
          const text = value.trim()
          if (text === '') return
          setValue('')
          onSubmit(text)
        }
      }}
    />
  )
}
