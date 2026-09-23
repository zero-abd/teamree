// Type a few letters, go somewhere. The fastest path to any worktree once
// there are more of them than fit comfortably in a row of tabs.

import { useMemo, useState } from 'react'
import { Modal } from '../dialogs/Modal'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { isCommandAvailable, runWorkspaceCommand } from '../keyboard/workspaceCommands'
import { shortcutHint, type WorkspaceCommand } from '../keyboard/workspaceShortcuts'
import { useWorkspaceStore } from '../state/workspaceStore'
import { buildPaletteItems, filterPalette, moveSelection, type PaletteAction, type PaletteItem } from './paletteModel'

/**
 * Palette actions that are also workspace commands — so the palette can show
 * the chord, and so that choosing the row runs the same dispatcher the chord
 * and the menu item run. The rows that are not in this table are the palette's
 * own and have no chord and no menu item.
 */
const ACTION_SHORTCUTS: Partial<Record<PaletteAction, WorkspaceCommand>> = {
  'new-worktree': 'new-worktree',
  'new-terminal': 'new-terminal',
  'split-right': 'split-right',
  'split-down': 'split-down',
  'toggle-sidebar': 'toggle-sidebar',
  'open-dashboard': 'open-dashboard',
  'open-appearance': 'open-appearance',
  // Settings has no chord and is not given one here. `⌘,` is the appearance
  // dialog's and is labelled as such in the rail; a second punctuation chord
  // behind shift is one `KeyboardEvent.key` reports differently per layout,
  // and a palette row promising a key that does nothing is worse than a row
  // promising none.
  'open-help': 'open-help'
}

export function CommandPalette({ modifier }: { modifier: PlatformModifier }): React.JSX.Element {
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const projects = useWorkspaceStore((state) => state.projects)
  const activeWorktreeId = useWorkspaceStore((state) => state.activeWorktreeId)
  const agents = useWorkspaceStore((state) => state.agents)
  // Orders the agent rows, nothing else.
  const defaultAgent = useWorkspaceStore((state) => state.defaultAgent)
  const update = useWorkspaceStore((state) => state.update)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  // Names one of the actions: what is wrong with the CLI link decides what the
  // row offering to fix it is called.
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
        hintFor: (action) => {
          const command = ACTION_SHORTCUTS[action]
          return command ? shortcutHint(command, modifier) : ''
        }
      }),
    [worktrees, projects, activeWorktreeId, agents, defaultAgent, update, cli, modifier]
  )

  // Nothing offered that cannot work, here as in the menu bar: a row for a
  // command the window would refuse is left out rather than drawn in black
  // letters and ignored. Asked as of the moment after the palette closes,
  // because that is when the command would run — the palette is itself the
  // dialog `isCommandAvailable` refuses everything under.
  const consent = useWorkspaceStore((state) => state.consent)
  const layouts = useWorkspaceStore((state) => state.layouts)
  const watches = useWorkspaceStore((state) => state.watches)
  const focusedWatchId = useWorkspaceStore((state) => state.focusedWatchId)
  const offered = useMemo(
    () =>
      items.filter((item) => {
        if (item.kind !== 'action') return true
        const command = ACTION_SHORTCUTS[item.id]
        if (!command) return true
        return isCommandAvailable(command, {
          consent,
          dialog: null,
          projects,
          worktrees,
          activeWorktreeId,
          layouts,
          watches,
          focusedWatchId
        })
      }),
    [items, consent, projects, worktrees, activeWorktreeId, layouts, watches, focusedWatchId]
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

    // The command, not the kind: this is the thing the pane will run, and the
    // runtime pins the session id so a pane started here resumes like any other.
    if (item.kind === 'agent') {
      void store.startAgent(item.id)
      return
    }

    // A row that is also a command goes through the one dispatcher, so that
    // what the palette does and what the chord does cannot come apart. This
    // used to be a third copy of the same switch.
    const command = ACTION_SHORTCUTS[item.id]
    if (command) {
      runWorkspaceCommand(command, store)
      return
    }

    switch (item.id) {
      case 'toggle-changes':
        store.toggleChanges()
        break
      case 'add-project':
        store.openDialog({ kind: 'add-project' })
        break
      case 'open-settings':
        store.toggleSettings()
        break
      case 'install-cli':
        store.openDialog({ kind: 'install-cli' })
        break
      case 'check-for-updates':
        // The palette has already closed. The answer arrives as the card, or as
        // a notice saying this build is the latest — never as a dialog, because
        // this is news and news does not take the keyboard.
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
