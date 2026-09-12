// Type a few letters, go somewhere. The fastest path to any worktree once
// there are more of them than fit comfortably in a row of tabs.

import { useMemo, useState } from 'react'
import { Modal } from '../dialogs/Modal'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { shortcutHint, type WorkspaceCommand } from '../keyboard/workspaceShortcuts'
import { useWorkspaceStore } from '../state/workspaceStore'
import { buildPaletteItems, filterPalette, moveSelection, type PaletteAction, type PaletteItem } from './paletteModel'

/** Palette actions that are also a key chord, so the palette can show it. */
const ACTION_SHORTCUTS: Partial<Record<PaletteAction, WorkspaceCommand>> = {
  'new-worktree': 'new-worktree',
  'new-terminal': 'new-terminal',
  'split-right': 'split-right',
  'split-down': 'split-down',
  'toggle-sidebar': 'toggle-sidebar'
}

export function CommandPalette({ modifier }: { modifier: PlatformModifier }): React.JSX.Element {
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const projects = useWorkspaceStore((state) => state.projects)
  const activeWorktreeId = useWorkspaceStore((state) => state.activeWorktreeId)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)

  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)

  const items = useMemo(
    () =>
      buildPaletteItems({
        worktrees,
        projects,
        activeWorktreeId,
        hintFor: (action) => {
          const command = ACTION_SHORTCUTS[action]
          return command ? shortcutHint(command, modifier) : ''
        }
      }),
    [worktrees, projects, activeWorktreeId, modifier]
  )

  const matches = useMemo(() => filterPalette(items, query), [items, query])
  // The list can shrink under a selection that was valid a keystroke ago.
  const cursor = Math.min(selected, Math.max(matches.length - 1, 0))

  const run = (item: PaletteItem | undefined): void => {
    if (!item) return
    closeDialog()
    const store = useWorkspaceStore.getState()

    if (item.kind === 'worktree') {
      void store.openWorktree(item.id)
      return
    }

    switch (item.id) {
      case 'new-worktree': {
        const active = store.worktrees.find((worktree) => worktree.id === store.activeWorktreeId)
        const projectId = active?.projectId ?? store.projects[0]?.id
        if (projectId) store.openDialog({ kind: 'create-worktree', projectId })
        break
      }
      case 'new-terminal':
        if (store.activeWorktreeId) void store.createTerminal(store.activeWorktreeId)
        break
      case 'split-right':
        void store.splitFocusedPane('row')
        break
      case 'split-down':
        void store.splitFocusedPane('column')
        break
      case 'toggle-changes':
        store.toggleChanges()
        break
      case 'toggle-sidebar':
        store.toggleSidebar()
        break
      case 'add-project':
        store.openDialog({ kind: 'add-project' })
        break
    }
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
      event.preventDefault()
      setSelected(moveSelection(matches.length, cursor, 1))
      return
    }
    if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
      event.preventDefault()
      setSelected(moveSelection(matches.length, cursor, -1))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      run(matches[cursor])
    }
  }

  return (
    <Modal title="Go to" onClose={closeDialog}>
      <div className="palette">
        <input
          className="palette__input"
          type="text"
          value={query}
          placeholder="Worktree, branch, or a command…"
          aria-label="Search worktrees and commands"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value)
            setSelected(0)
          }}
          onKeyDown={onKeyDown}
        />

        {matches.length === 0 ? (
          <p className="palette__empty">Nothing matches “{query.trim()}”.</p>
        ) : (
          <ul className="palette__list" role="listbox" aria-label="Results">
            {matches.map((item, index) => (
              <li key={`${item.kind}:${item.id}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === cursor}
                  className={`palette__row${index === cursor ? ' palette__row--selected' : ''}`}
                  // Pointer selection follows the mouse, so clicking never runs
                  // a different row than the one under the cursor.
                  onMouseMove={() => setSelected(index)}
                  onClick={() => run(item)}
                >
                  <span className="palette__label">{item.label}</span>
                  <span className="palette__hint">{item.hint}</span>
                  <span className="palette__detail">{item.detail}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
