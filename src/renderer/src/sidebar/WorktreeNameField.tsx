// The sidebar row's name, being edited in place. Return commits and Escape
// cancels; a blur commits too, as a click away from a Finder rename does.

import { useEffect, useRef, useState } from 'react'

type WorktreeNameFieldProps = {
  name: string
  /** Called at most once, with the trimmed name; never with a blank one or the unchanged one. */
  onRename: (name: string) => void
  onDone: () => void
}

export function WorktreeNameField({ name, onRename, onDone }: WorktreeNameFieldProps): React.JSX.Element {
  const [draft, setDraft] = useState(name)
  const [refused, setRefused] = useState(false)
  // Return unmounts the field, and a blur can still arrive after it: one outcome only.
  const settled = useRef(false)
  const field = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [])

  const finish = (commit: boolean): void => {
    if (settled.current) return
    settled.current = true
    const named = draft.trim()
    if (commit && named.length > 0 && named !== name) onRename(named)
    onDone()
  }

  return (
    <input
      ref={field}
      className="worktree__name-field"
      type="text"
      spellCheck={false}
      autoComplete="off"
      aria-label="Worktree name"
      aria-invalid={refused ? 'true' : undefined}
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value)
        setRefused(false)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          if (draft.trim().length === 0) setRefused(true)
          else finish(true)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          finish(false)
        }
      }}
      onBlur={() => finish(true)}
    />
  )
}
