// Window-level key handling. The listener runs in the capture phase so a chord
// is claimed before xterm's textarea sees it, and `isAppChord` is handed to the
// terminals so they decline the same set.

import { useCallback, useEffect } from 'react'
import { useWorkspaceStore } from '../state/workspaceStore'
import type { ModifierState, PlatformModifier } from './platformModifier'
import { commandForEvent } from './workspaceShortcuts'

export function useWorkspaceShortcuts(modifier: PlatformModifier): (event: KeyboardEvent) => boolean {
  const isAppChord = useCallback(
    (event: KeyboardEvent) => commandForEvent(toModifierState(event), modifier) !== null,
    [modifier]
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const command = commandForEvent(toModifierState(event), modifier)
      if (!command) return

      const store = useWorkspaceStore.getState()
      // A modal owns the keyboard while it is up.
      if (store.dialog) return

      event.preventDefault()
      event.stopPropagation()

      switch (command) {
        case 'split-right':
          void store.splitFocusedPane('row')
          break
        case 'split-down':
          void store.splitFocusedPane('column')
          break
        case 'close-pane': {
          const layout = store.activeWorktreeId ? store.layouts[store.activeWorktreeId] : undefined
          if (layout?.focusedTerminalId) void store.closeTerminal(layout.focusedTerminalId)
          break
        }
        case 'new-terminal':
          if (store.activeWorktreeId) void store.createTerminal(store.activeWorktreeId)
          break
        case 'new-worktree': {
          const active = store.worktrees.find((worktree) => worktree.id === store.activeWorktreeId)
          const projectId = active?.projectId ?? store.projects[0]?.id
          if (projectId) store.openDialog({ kind: 'create-worktree', projectId })
          break
        }
        case 'toggle-sidebar':
          store.toggleSidebar()
          break
        case 'focus-next-pane':
          store.focusNextPane()
          break
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [modifier])

  return isAppChord
}

function toModifierState(event: KeyboardEvent): ModifierState & { key: string } {
  return {
    key: event.key,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey
  }
}
