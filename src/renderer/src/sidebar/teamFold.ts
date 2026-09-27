// Which teammates' groups are folded in the sidebar, and going to a teammate's row from a cue.

import { create } from 'zustand'
import { useWorkspaceStore } from '../state/workspaceStore'

type TeamFoldState = {
  /** By `projectId handle`; absent is open. */
  folded: Record<string, true>
  setFolded: (projectId: string, handle: string, folded: boolean) => void
}

const key = (projectId: string, handle: string): string => `${projectId} ${handle}`

export const useTeamFold = create<TeamFoldState>()((set) => ({
  folded: {},
  setFolded(projectId, handle, folded) {
    set((state) => {
      const next = { ...state.folded }
      if (folded) next[key(projectId, handle)] = true
      else delete next[key(projectId, handle)]
      return { folded: next }
    })
  }
}))

export function isFolded(folded: Readonly<Record<string, true>>, projectId: string, handle: string): boolean {
  return folded[key(projectId, handle)] === true
}

/** The sidebar row matching `selector` under a project, unfolding the project and the teammate first. */
export function revealTeamRow(projectId: string, selector: string, handle?: string): void {
  const workspace = useWorkspaceStore.getState()
  if (workspace.collapsedProjects[projectId]) workspace.toggleProject(projectId)
  if (handle !== undefined) useTeamFold.getState().setFolded(projectId, handle, false)
  // After the unfold has drawn the row.
  requestAnimationFrame(() => {
    const row = document.querySelector<HTMLElement>(`[data-project-id="${CSS.escape(projectId)}"] ${selector}`)
    row?.scrollIntoView?.({ block: 'nearest' })
    row?.focus()
  })
}

/** `[data-name="value"]`, escaped. */
export function dataSelector(name: string, value: string): string {
  return `[data-${name}="${CSS.escape(value)}"]`
}
