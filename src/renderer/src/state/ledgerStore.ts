// Claims and notes per project, as the ledger keeps them. Read through the workspace
// refresher on `memory`; a write shows once the runtime says memory changed.

import { create } from 'zustand'
import type { ProjectMemory } from '@shared/ledgerMethods'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'

type LedgerState = {
  byProject: Record<string, ProjectMemory>
  refresh: (projectIds: readonly string[]) => Promise<void>
}

export const useLedger = create<LedgerState>()((set) => ({
  byProject: {},
  async refresh(projectIds) {
    const answers = await Promise.all(
      projectIds.map((projectId) => runtimeClient.call('memory.list', { projectId }).catch(() => null))
    )
    set((state) => {
      const byProject: Record<string, ProjectMemory> = {}
      projectIds.forEach((projectId, index) => {
        const read = answers[index] ?? state.byProject[projectId]
        if (read !== undefined) byProject[projectId] = read
      })
      return { byProject }
    })
  }
}))

export const ledgerWrites = {
  claim: (worktreeId: string, glob: string) => runtimeClient.call('memory.claim', { worktreeId, globs: [glob] }),
  unclaim: (worktreeId: string, glob: string) => runtimeClient.call('memory.unclaim', { worktreeId, globs: [glob] }),
  decide: (worktreeId: string, text: string) =>
    runtimeClient.call('memory.note', { worktreeId, kind: 'decision', text, scope: 'private' }),
  resolve: (noteId: string) => runtimeClient.call('memory.resolve', { noteId }),
  forget: (noteId: string) => runtimeClient.call('memory.forget', { noteId })
}
