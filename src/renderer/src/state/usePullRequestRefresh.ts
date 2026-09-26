// Asks about pull requests again on window focus and, while checks run, once a minute; the rules are pullRequestRefresh's.

import { useEffect } from 'react'
import { focusRefresh, PENDING_POLL_MS, pollRefresh, type RefreshFacts } from './pullRequestRefresh'
import { useWorkspaceStore } from './workspaceStore'

function facts(): RefreshFacts {
  const { worktrees, projects, landings, pushes } = useWorkspaceStore.getState()
  return { worktrees, projects, landings, pushes }
}

export function usePullRequestRefresh(): void {
  useEffect(() => {
    let lastFocusRead: number | undefined
    const read = (worktreeIds: string[]): void => {
      if (worktreeIds.length > 0) void useWorkspaceStore.getState().refreshPullRequests(worktreeIds)
    }
    const onFocus = (): void => {
      const now = Date.now()
      const due = focusRefresh(facts(), now, lastFocusRead)
      if (due.length > 0) lastFocusRead = now
      read(due)
    }
    const timer = setInterval(() => read(pollRefresh(facts(), Date.now())), PENDING_POLL_MS)
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [])
}
