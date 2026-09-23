// The window's end of agent-stopped notifications: main raises them, this publishes the focused pane
// and the interrupt preference when they change, and turns a click into `revealPane` on a checked id.

import { useEffect } from 'react'
import type { Layout } from '@shared/entities'
import { useWorkspaceStore } from '../state/workspaceStore'

/** The parts of the store this reads, named so this module does not need its type. */
export type FocusState = {
  activeWorktreeId: string | null
  layouts: Readonly<Record<string, Layout>>
  focusedWatchId: string | null
}

/** The pane this window shows, for notices; null for a teammate's pane, which no notice is about. */
export function focusedOwnPaneId(state: FocusState): string | null {
  if (state.focusedWatchId !== null) return null
  const layout = state.activeWorktreeId ? state.layouts[state.activeWorktreeId] : undefined
  return layout?.focusedTerminalId ?? null
}

export function useAgentNotices(): void {
  useEffect(() => {
    // Absent without the preload (tests, a browser on the dev server).
    const notices = window.teamree?.notices
    if (!notices) return

    const stopListening = notices.onReveal((pane) => {
      // Checked, since it arrives over IPC and an unknown id would open an empty tab.
      const state = useWorkspaceStore.getState()
      if (!state.worktrees.some((worktree) => worktree.id === pane.worktreeId)) return
      void state.revealPane(pane.worktreeId, pane.terminalId)
    })

    let published: string | null = null
    const publish = (): void => {
      const state = useWorkspaceStore.getState()
      const settings = { preference: state.agentNotices, focusedPaneId: focusedOwnPaneId(state) }
      const description = JSON.stringify(settings)
      if (description === published) return
      published = description
      notices.publish(settings)
    }

    publish()
    const stopWatching = useWorkspaceStore.subscribe(publish)

    return () => {
      stopListening()
      stopWatching()
    }
  }, [])
}
