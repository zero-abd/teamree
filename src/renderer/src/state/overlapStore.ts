// Which worktrees change the same files, per project, as the runtime's ledger ranks them.
// Read through the workspace refresher on `memory` and `teammates`; never polled.

import { create } from 'zustand'
import type { WorktreeOverlap } from '@shared/tasks'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'

type OverlapState = {
  byProject: Record<string, WorktreeOverlap[]>
  refresh: (projectIds: readonly string[]) => Promise<void>
}

export const useOverlaps = create<OverlapState>()((set) => ({
  byProject: {},
  async refresh(projectIds) {
    const answers = await Promise.all(
      projectIds.map((projectId) => runtimeClient.call('worktree.overlaps', { projectId }).catch(() => null))
    )
    set((state) => {
      const byProject: Record<string, WorktreeOverlap[]> = {}
      projectIds.forEach((projectId, index) => {
        const read = answers[index]?.overlaps ?? state.byProject[projectId]
        if (read !== undefined) byProject[projectId] = read
      })
      return { byProject }
    })
  }
}))
