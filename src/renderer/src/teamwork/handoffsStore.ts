// Worktrees handed between teammates, as the window holds them: each project's incoming offers and
// the ones this machine made. Re-read on the `teammates` event.

import { create } from 'zustand'
import type { PeerHandoff, TeamworkHandoffs } from '@shared/tasks'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'

/** How many offers ask at once; the rest wait their turn, oldest first. */
export const MAX_HANDOFF_POPUPS = 3

type HandoffsState = {
  byProject: Record<string, TeamworkHandoffs>
  refresh: (projectIds: readonly string[]) => Promise<void>
  /** Checks the branch out here and starts `agent` with the note; the new worktree's id. */
  take: (projectId: string, id: string, agent: string | undefined) => Promise<string>
  dismiss: (projectId: string, id: string) => Promise<void>
}

/** The offers asking now, oldest first, with the project each is in. */
export function handoffPopups(
  byProject: Readonly<Record<string, TeamworkHandoffs>>
): (PeerHandoff & { projectId: string })[] {
  return Object.entries(byProject)
    .flatMap(([projectId, read]) => read.incoming.map((handoff) => ({ ...handoff, projectId })))
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_HANDOFF_POPUPS)
}

/** What a worktree's row says about its latest offer, if it made one. */
export function handoffLine(outgoing: readonly PeerHandoff[], worktreeId: string): string | null {
  const latest = outgoing.filter((handoff) => handoff.worktreeId === worktreeId).sort((a, b) => b.at - a.at)[0]
  if (latest === undefined) return null
  return latest.takenAt === undefined ? `Handed to ${latest.to}` : `Taken by ${latest.to}`
}

const without = (read: TeamworkHandoffs | undefined, id: string): TeamworkHandoffs => ({
  incoming: (read?.incoming ?? []).filter((handoff) => handoff.id !== id),
  outgoing: read?.outgoing ?? []
})

export const useHandoffs = create<HandoffsState>()((set) => ({
  byProject: {},

  async refresh(projectIds) {
    const reads = await Promise.all(
      projectIds.map(async (projectId) => {
        const read = await runtimeClient.call('teamwork.handoffs', { projectId }).catch(() => null)
        return [projectId, read] as const
      })
    )
    set((state) => {
      const byProject = { ...state.byProject }
      for (const [projectId, read] of reads) if (read) byProject[projectId] = read
      return { byProject }
    })
  },

  async take(projectId, id, agent) {
    const worktree = await runtimeClient.call('teamwork.take', {
      projectId,
      id,
      ...(agent === undefined ? {} : { agent })
    })
    set((state) => ({ byProject: { ...state.byProject, [projectId]: without(state.byProject[projectId], id) } }))
    return worktree.id
  },

  async dismiss(projectId, id) {
    set((state) => ({ byProject: { ...state.byProject, [projectId]: without(state.byProject[projectId], id) } }))
    await runtimeClient.call('teamwork.dismissHandoff', { projectId, id }).catch(() => undefined)
  }
}))
