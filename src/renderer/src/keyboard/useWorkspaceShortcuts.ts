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
      // A modal owns the keyboard while it is up — except the palette's own
      // chord, which closes it again the way every palette does.
      if (store.dialog) {
        if (command !== 'open-palette' || store.dialog.kind !== 'palette') return
        event.preventDefault()
        store.closeDialog()
        return
      }

      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) return

      switch (command) {
        case 'split-right':
          void store.splitFocusedPane('row')
          break
        case 'split-down':
          void store.splitFocusedPane('column')
          break
        case 'close-pane': {
          // A teammate's pane closes with the same chord as your own, and for
          // this one closing is the whole of stopping the watch: the pane is
          // the subscription, and nothing flows once it is gone.
          if (store.focusedWatchId !== null) {
            store.closeWatchedPane(store.focusedWatchId)
            break
          }
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
          if (projectId) store.openDialog({ kind: 'new-task', projectId })
          break
        }
        case 'toggle-sidebar':
          store.toggleSidebar()
          break
        case 'focus-next-pane':
          store.focusNextPane()
          break
        case 'open-palette':
          store.openDialog({ kind: 'palette' })
          break
        case 'find-in-pane':
          store.openPaneSearch()
          break
        case 'open-dashboard':
          store.toggleDashboard()
          break
        case 'open-appearance':
          store.openDialog({ kind: 'appearance' })
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
