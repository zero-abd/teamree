// The window's end of the notification an agent raises when it stops.
//
// The notification itself belongs to the main process, which is the only one
// that can raise one — and, as with the menu bar, the one that knows least
// about what is going on. Two of the three things the decision needs are facts
// about this window and nowhere else: which pane has the focus, and whether the
// person at this machine wants to be interrupted at all. So they are published
// whenever they change, and nothing in main has to guess at either.
//
// The other direction is one pane. Clicking a notification is a request to go
// and look at the thing it was about, and this window already knows how to do
// that: `revealPane` is what a sidebar row does. So what arrives is an address
// and not an instruction — it can put you in front of a pane of your own, and
// there is nothing else it can ask for.
//
// Republished on the store changes that change the answer and on no others, the
// same way `useMenuBar` is and for the cheaper half of the same reason: almost
// every store change — a byte of pane output, a git status coming back — leaves
// both of these exactly as they were.

import { useEffect } from 'react'
import type { Layout } from '@shared/entities'
import { useWorkspaceStore } from '../state/workspaceStore'

/** The parts of the store this reads, named so this module does not need its type. */
export type FocusState = {
  activeWorktreeId: string | null
  layouts: Readonly<Record<string, Layout>>
  focusedWatchId: string | null
}

/**
 * The pane this window is showing, as far as a notification is concerned.
 *
 * Null when a teammate's pane has the focus as well as when nothing does: a
 * watched pane is somebody else's session, no notification here is ever about
 * one, and calling it "the focused pane" would suppress a notice about a pane
 * of your own that happened to share its id.
 */
export function focusedOwnPaneId(state: FocusState): string | null {
  if (state.focusedWatchId !== null) return null
  const layout = state.activeWorktreeId ? state.layouts[state.activeWorktreeId] : undefined
  return layout?.focusedTerminalId ?? null
}

export function useAgentNotices(): void {
  useEffect(() => {
    // Absent in a test that renders the app without the preload, and in a
    // browser pointed at the dev server. Neither has a notification centre.
    const notices = window.teamree?.notices
    if (!notices) return

    const stopListening = notices.onReveal((pane) => {
      // Checked against what this window actually has rather than trusted,
      // because it arrives over IPC: `revealPane` opens a worktree tab, and an
      // id that is not a worktree here would open an empty one.
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
