// Type a few letters, go somewhere. The fastest path to any worktree once
// there are more of them than fit comfortably in a row of tabs.

import { useMemo, useState } from 'react'
import { Modal } from '../dialogs/Modal'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { isCommandAvailable, runWorkspaceCommand } from '../keyboard/workspaceCommands'
import { commandNamed, shortcutHint } from '../keyboard/workspaceShortcuts'
import { useWorkspaceStore } from '../state/workspaceStore'
import { buildPaletteItems, filterPalette, moveSelection, type PaletteItem } from './paletteModel'

export function CommandPalette({ modifier }: { modifier: PlatformModifier }): React.JSX.Element {
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const projects = useWorkspaceStore((state) => state.projects)
  const activeWorktreeId = useWorkspaceStore((state) => state.activeWorktreeId)
  const agents = useWorkspaceStore((state) => state.agents)
  // Orders the agent rows, nothing else.
  const defaultAgent = useWorkspaceStore((state) => state.defaultAgent)
  const update = useWorkspaceStore((state) => state.update)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  // The CLI link's state names the row that fixes it.
  const cli = useWorkspaceStore((state) => state.cli)

  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)

  const items = useMemo(
    () =>
      buildPaletteItems({
        worktrees,
        projects,
        activeWorktreeId,
        agents,
        defaultAgent,
        update,
        cli,
        // Empty for a command with no key.
        hintFor: (action) => {
          const command = commandNamed(action)
          return command ? shortcutHint(command, modifier) : ''
        }
      }),
    [worktrees, projects, activeWorktreeId, agents, defaultAgent, update, cli, modifier]
  )

  // Rows the window would refuse are left out, asked as of after the palette closes (it is a dialog too).
  const consent = useWorkspaceStore((state) => state.consent)
  const layouts = useWorkspaceStore((state) => state.layouts)
  const watches = useWorkspaceStore((state) => state.watches)
  const focusedWatchId = useWorkspaceStore((state) => state.focusedWatchId)
  const statuses = useWorkspaceStore((state) => state.statuses)
  const pushing = useWorkspaceStore((state) => state.pushing)
  const offered = useMemo(
    () =>
      items.filter((item) => {
        if (item.kind !== 'action') return true
        const command = commandNamed(item.id)
        if (!command) return true
        return isCommandAvailable(command, {
          consent,
          dialog: null,
          projects,
          worktrees,
          activeWorktreeId,
          layouts,
          watches,
          focusedWatchId,
          statuses,
          pushing
        })
      }),
    [items, consent, projects, worktrees, activeWorktreeId, layouts, watches, focusedWatchId, statuses, pushing]
  )

  const matches = useMemo(() => filterPalette(offered, query), [offered, query])
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

    // The command, not the kind; the runtime pins the session id so it resumes like any other pane.
    if (item.kind === 'agent') {
      void store.startAgent(item.id)
      return
    }

    // Commands go through the one dispatcher, so palette and chord cannot come apart.
    const command = commandNamed(item.id)
    if (command) {
      runWorkspaceCommand(command, store)
      return
    }

    switch (item.id) {
      case 'toggle-changes':
        store.toggleChanges()
        break
      case 'show-files':
        store.showRightPanelTab('files')
        break
      case 'add-project':
        store.openDialog({ kind: 'add-project' })
        break
      case 'install-cli':
        store.openDialog({ kind: 'install-cli' })
        break
      case 'check-for-updates':
        // The answer arrives as the card or a notice, never a dialog.
        void store.checkForUpdates()
        break
      case 'toggle-automatic-updates':
        void store.setAutomaticUpdates(!(store.update?.automatic ?? true))
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
                  // Selection follows the pointer, so a click runs the row under it.
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
