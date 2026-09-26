import type { CommitSuggestion } from './commitMessage'

/** `from report ✕` beside a commit message still as suggested; ✕ empties it. */
export function CommitFrom({
  from,
  onClear
}: {
  from: CommitSuggestion['from'] | null
  onClear: () => void
}): React.JSX.Element | null {
  if (from === null) return null
  return (
    <span className="commit-from">
      {`from ${from}`}
      <button type="button" className="commit-from__clear" aria-label="Clear message" onClick={onClear}>
        ✕
      </button>
    </span>
  )
}
