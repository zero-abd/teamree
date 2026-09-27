// The strip's saved commands and prompts, after Run Dev and Run Tests: one menu of this project's,
// the repository's and every project's, with New and Edit at its foot.

import { useCallback, useMemo, useRef, useState } from 'react'
import { savedCommandsOf } from '@shared/savedCommands'
import { Icon } from '../icons/Icon'
import { RowMenu, type RowMenuAnchor, type RowMenuItem } from '../sidebar/RowMenu'
import { useSavedCommandsStore } from '../state/savedCommandsStore'
import { useWorkspaceStore } from '../state/workspaceStore'

const MENU_GAP_PX = 4
const HINT_CHARS = 36

export function SavedCommands({ worktreeId }: { worktreeId: string }): React.JSX.Element {
  const project = useWorkspaceStore((state) => {
    const worktree = state.worktrees.find((entry) => entry.id === worktreeId)
    return state.projects.find((entry) => entry.id === worktree?.projectId)
  })
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  const openSetting = useWorkspaceStore((state) => state.openSetting)
  const everywhere = useSavedCommandsStore((state) => state.everywhere)
  const run = useSavedCommandsStore((state) => state.run)
  const button = useRef<HTMLButtonElement | null>(null)
  const [menuAt, setMenuAt] = useState<RowMenuAnchor | null>(null)
  const closeMenu = useCallback((): void => {
    setMenuAt(null)
    button.current?.focus()
  }, [])

  const items = useMemo((): RowMenuItem[] => {
    const saved = savedCommandsOf(project, everywhere).map(
      ({ command }): RowMenuItem => ({
        label: command.label,
        hint: shortHint(command.text),
        onChoose: () => void run(worktreeId, command.id)
      })
    )
    return [
      ...saved,
      {
        label: 'New Command…',
        separated: saved.length > 0,
        onChoose: () => openDialog({ kind: 'saved-command', ...(project ? { projectId: project.id } : {}) })
      },
      { label: 'Edit Commands…', onChoose: () => openSetting(SAVED_COMMANDS_SETTING) }
    ]
  }, [project, everywhere, run, worktreeId, openDialog, openSetting])

  return (
    <>
      <button
        ref={button}
        type="button"
        className="run-buttons__run saved-commands"
        title="Commands"
        aria-label="Commands"
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
        onClick={() => {
          if (menuAt !== null) {
            closeMenu()
            return
          }
          const rect = button.current?.getBoundingClientRect()
          if (rect) setMenuAt({ x: rect.right, y: rect.bottom + MENU_GAP_PX, align: 'right' })
        }}
      >
        <Icon name="play" size={14} />
        <svg className="saved-commands__chevron" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5 L6 7.5 L9 4.5" />
        </svg>
      </button>
      {menuAt === null ? null : (
        <RowMenu label="Commands" anchor={menuAt} opener={button.current} onClose={closeMenu} items={items} />
      )}
    </>
  )
}

/** The Settings row that lists them, which Edit Commands… opens the page filtered to. */
export const SAVED_COMMANDS_SETTING = 'Saved commands'

function shortHint(text: string): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > HINT_CHARS || text.includes('\n') ? `${line.slice(0, HINT_CHARS - 1)}…` : line
}
