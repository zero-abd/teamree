// Reviews asked of this machine and by it, per project, as the window holds them. Re-read on the `teammates` event.

import { create } from 'zustand'
import type { PeerReviewRequest, TeamworkReviewRequests } from '@shared/teammateReview'
import { useTeammateReview } from '../review/teammateReviewStore'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'

/** How many request popups are on screen at once; the rest wait their turn, oldest first. */
export const MAX_REQUEST_POPUPS = 3

type ReviewRequestsState = {
  byProject: Record<string, TeamworkReviewRequests>
  refresh: (projectIds: readonly string[]) => Promise<void>
  /** Asks `to` to review one of this machine's tasks, and says so. */
  request: (worktreeId: string, to: string) => Promise<void>
  /** `seen` retires the popup; `opened` also moves it to Reviewing; `later` takes the request off the list. */
  settle: (projectId: string, id: string, how: 'seen' | 'later' | 'opened') => Promise<void>
}

/** The requests asking now: unseen ones, oldest first, with the project each is in. */
export function requestPopups(
  byProject: Readonly<Record<string, TeamworkReviewRequests>>
): (PeerReviewRequest & { projectId: string })[] {
  return Object.entries(byProject)
    .flatMap(([projectId, read]) => read.incoming.map((request) => ({ ...request, projectId })))
    .filter((request) => request.seen !== true)
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_REQUEST_POPUPS)
}

export const useReviewRequests = create<ReviewRequestsState>()((set) => ({
  byProject: {},

  async refresh(projectIds) {
    const reads = await Promise.all(
      projectIds.map(async (projectId) => {
        const read = await runtimeClient.call('teamwork.reviewRequests', { projectId }).catch(() => null)
        return [projectId, read] as const
      })
    )
    set((state) => {
      const byProject = { ...state.byProject }
      for (const [projectId, read] of reads) if (read) byProject[projectId] = read
      return { byProject }
    })
  },

  async request(worktreeId, to) {
    const { showNotice } = useWorkspaceStore.getState()
    try {
      await runtimeClient.call('teamwork.requestReview', { worktreeId, to })
      showNotice(`Asked ${to} to review`)
    } catch (failure) {
      showNotice(`Not asked: ${failure instanceof Error ? failure.message : String(failure)}`, 'error')
    }
  },

  async settle(projectId, id, how) {
    set((state) => {
      const read = state.byProject[projectId]
      if (read === undefined) return {}
      const settled = how === 'opened' ? { seen: true as const, opened: true as const } : { seen: true as const }
      const incoming =
        how === 'later'
          ? read.incoming.filter((request) => request.id !== id)
          : read.incoming.map((request) => (request.id === id ? { ...request, ...settled } : request))
      return { byProject: { ...state.byProject, [projectId]: { ...read, incoming } } }
    })
    await runtimeClient.call('teamwork.settleReviewRequest', { projectId, id, how }).catch(() => undefined)
  }
}))

/** Opens the task a request is about beside the workspace, moving it from Waiting on you to Reviewing. */
export function reviewRequested(request: PeerReviewRequest & { projectId: string }): void {
  useTeammateReview.getState().openReview({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    title: `${request.from ?? request.to} · ${request.worktreeName}`
  })
  void useReviewRequests.getState().settle(request.projectId, request.id, 'opened')
}
