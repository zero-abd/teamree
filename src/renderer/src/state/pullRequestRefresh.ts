// Which pull requests are asked about again without a git change to prompt it: on focus, and slowly while
// checks run. Both are background reads, so a project with background fetching off gets neither.

import type { Project, Worktree, WorktreeLanding } from '@shared/entities'
import type { PushState } from './workspaceStore'

/** Two focuses closer than this read once. */
export const FOCUS_GAP_MS = 30_000
export const PENDING_POLL_MS = 60_000
/** A push's checks take a while to be reported at all; until then nothing is pending. */
export const AFTER_PUSH_MS = 5 * 60_000

export type RefreshFacts = {
  worktrees: readonly Pick<Worktree, 'id' | 'projectId'>[]
  projects: readonly Pick<Project, 'id' | 'fetchInBackground'>[]
  landings: Readonly<Record<string, WorktreeLanding>>
  pushes: Readonly<Record<string, PushState>>
}

function readable(facts: RefreshFacts): { id: string; landing: WorktreeLanding }[] {
  const off = new Set(facts.projects.filter((project) => project.fetchInBackground === false).map((p) => p.id))
  return facts.worktrees.flatMap((worktree) => {
    const landing = facts.landings[worktree.id]
    if (off.has(worktree.projectId) || landing === undefined) return []
    if (landing.host !== 'github' || !landing.published || landing.merged || landing.parent !== undefined) return []
    return [{ id: worktree.id, landing }]
  })
}

export function focusRefresh(facts: RefreshFacts, now: number, lastFocusRead: number | undefined): string[] {
  if (lastFocusRead !== undefined && now - lastFocusRead < FOCUS_GAP_MS) return []
  return readable(facts).map((entry) => entry.id)
}

export function pollRefresh(facts: RefreshFacts, now: number): string[] {
  return readable(facts)
    .filter(({ id, landing }) => {
      const push = facts.pushes[id]
      if (push?.phase === 'pushed' && now - push.at < AFTER_PUSH_MS) return true
      return landing.pullRequest?.state === 'open' && (landing.pullRequest.checks?.pending ?? 0) > 0
    })
    .map((entry) => entry.id)
}
