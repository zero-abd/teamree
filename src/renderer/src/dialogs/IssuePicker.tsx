// The composer's From Issue… list: the project's open GitHub issues through the user's own `gh`.

import { useEffect, useState } from 'react'
import type { IssueEntry } from '@shared/entities'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { filterIssues } from './issueModel'
import { useEscapeClaim } from './Modal'

type Listing =
  | { phase: 'loading' }
  | { phase: 'ready'; issues: IssueEntry[] }
  | { phase: 'unavailable'; reason: string }

export function IssuePicker({
  projectId,
  onPick,
  onClose
}: {
  projectId: string
  onPick: (issue: IssueEntry) => void
  onClose: () => void
}): React.JSX.Element {
  const [listing, setListing] = useState<Listing>({ phase: 'loading' })
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<number | null>(null)
  useEscapeClaim(() => {
    onClose()
    return true
  })

  useEffect(() => {
    let live = true
    runtimeClient.call('worktree.issues', { projectId }).then(
      (list) =>
        live &&
        setListing(
          list.available
            ? { phase: 'ready', issues: list.issues }
            : { phase: 'unavailable', reason: list.reason ?? 'Needs gh' }
        ),
      (error: unknown) =>
        live && setListing({ phase: 'unavailable', reason: error instanceof Error ? error.message : String(error) })
    )
    return () => {
      live = false
    }
  }, [projectId])

  const issues = listing.phase === 'ready' ? filterIssues(listing.issues, query) : []
  const issue = issues.find((entry) => entry.number === chosen) ?? issues[0]

  const move = (by: number): void => {
    if (issues.length === 0) return
    const at = issue === undefined ? -1 : issues.indexOf(issue)
    setChosen(issues[(at + by + issues.length) % issues.length]?.number ?? null)
  }

  return (
    <div className="issue-picker">
      <input
        className="palette__input"
        aria-label="Filter issues"
        placeholder="Filter issues"
        value={query}
        autoFocus
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            move(event.key === 'ArrowDown' ? 1 : -1)
          } else if (event.key === 'Enter') {
            // The form's Enter would start the task.
            event.preventDefault()
            if (issue !== undefined) onPick(issue)
          }
        }}
      />
      {listing.phase === 'loading' ? <p className="palette__empty">Reading…</p> : null}
      {listing.phase === 'unavailable' ? (
        <p className="palette__empty issue-picker__unavailable">{listing.reason}</p>
      ) : null}
      {listing.phase === 'ready' && issues.length === 0 ? <p className="palette__empty">No open issues</p> : null}
      {issues.length === 0 ? null : (
        <ul className="palette__list issue-picker__list" role="listbox" aria-label="Issues">
          {issues.map((entry) => (
            <li key={entry.number} role="option" aria-selected={entry === issue}>
              <button
                type="button"
                className={`palette__row${entry === issue ? ' palette__row--selected' : ''}`}
                onClick={() => onPick(entry)}
              >
                <span className="palette__label">{`#${entry.number} ${entry.title}`}</span>
                {entry.labels.length === 0 ? null : (
                  <span className="palette__trailing">{entry.labels.join(' · ')}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
