// Move Under…: the row menu's way to nest a worktree, for whoever is not dragging. The rest of the
// project in tree order; a row it cannot go under stays listed, disabled, with the reason.

import { useState } from 'react'
import { moveWorktree } from '../sidebar/nestDrag'
import { moveUnderChoices } from '../sidebar/nestDrop'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Modal } from './Modal'

export function MoveUnderDialog({ worktreeId }: { worktreeId: string }): React.JSX.Element | null {
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<string | null>(null)
  const moved = worktrees.find((entry) => entry.id === worktreeId)
  if (moved === undefined) return null

  const needle = query.trim().toLowerCase()
  const rows = moveUnderChoices(worktrees, worktreeId).filter(
    (row) => needle === '' || row.worktree.name.toLowerCase().includes(needle)
  )
  const open = rows.filter((row) => row.refused === undefined)
  const row = open.find((entry) => entry.worktree.id === chosen) ?? open[0]

  const move = (by: number): void => {
    if (open.length === 0) return
    const at = row === undefined ? -1 : open.indexOf(row)
    setChosen(open[(at + by + open.length) % open.length]?.worktree.id ?? null)
  }
  const submit = (): void => {
    if (row === undefined) return
    closeDialog()
    void moveWorktree(worktreeId, row.worktree.id)
  }

  return (
    <Modal title={`Move ${moved.name} under`} onClose={closeDialog}>
      <form
        className="form palette"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <input
          className="palette__input"
          aria-label="Filter"
          placeholder="Filter tasks"
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
        {rows.length === 0 ? (
          <p className="palette__empty">No other task</p>
        ) : (
          <ul className="palette__list" role="listbox" aria-label="Tasks">
            {rows.map((entry) => (
              <li
                key={entry.worktree.id}
                role="option"
                aria-selected={entry === row}
                aria-disabled={entry.refused === undefined ? undefined : true}
              >
                <button
                  type="button"
                  className={`palette__row move-under__row${entry === row ? ' palette__row--selected' : ''}`}
                  style={{ '--depth': entry.depth } as React.CSSProperties}
                  tabIndex={-1}
                  disabled={entry.refused !== undefined}
                  onClick={() => setChosen(entry.worktree.id)}
                  onDoubleClick={() => {
                    setChosen(entry.worktree.id)
                    submit()
                  }}
                >
                  <span className="palette__label">{entry.worktree.name}</span>
                  {entry.refused === undefined ? null : <span className="palette__trailing">{entry.refused}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        <footer className="modal__actions">
          <button type="button" className="button button--ghost" onClick={closeDialog}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={row === undefined}>
            Move
          </button>
        </footer>
      </form>
    </Modal>
  )
}
