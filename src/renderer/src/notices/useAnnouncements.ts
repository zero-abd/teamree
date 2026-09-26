// The live region's spoken line: re-read whenever panes, git or overlaps move, and said through `Announcer`.

import { useEffect, useState } from 'react'
import { useOverlaps } from '../state/overlapStore'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Announcer, announcements, heardStates } from './announcements'

/** The latest line and a count, so the same words said twice still replace the node and are heard again. */
export function useAnnouncements(): { text: string; serial: number } {
  const [spoken, setSpoken] = useState({ text: '', serial: 0 })
  useEffect(() => {
    const announcer = new Announcer((text) => setSpoken((last) => ({ text, serial: last.serial + 1 })))
    let read: { refs: readonly unknown[]; heard: ReturnType<typeof heardStates> } | null = null
    const listen = (): void => {
      const state = useWorkspaceStore.getState()
      const overlaps = useOverlaps.getState().byProject
      const refs = [state.terminals, state.worktrees, state.mergePreviews, state.statuses, state.landings, overlaps]
      // Output moves the store many times a second; these move only with what can be said.
      if (read !== null && refs.every((ref, index) => ref === read?.refs[index])) return
      const heard = heardStates({
        terminals: Object.values(state.terminals),
        worktrees: state.worktrees,
        mergePreviews: state.mergePreviews,
        statuses: state.statuses,
        landings: state.landings,
        overlaps
      })
      announcer.push(announcements(read?.heard ?? null, heard))
      read = { refs, heard }
    }
    listen()
    const stopWorkspace = useWorkspaceStore.subscribe(listen)
    const stopOverlaps = useOverlaps.subscribe(listen)
    return () => {
      stopWorkspace()
      stopOverlaps()
      announcer.stop()
    }
  }, [])
  return spoken
}
