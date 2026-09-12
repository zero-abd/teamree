// Reading what a project can branch from. A failed listing is not fatal: the
// dialog still accepts a ref typed by hand, so this reports the error rather
// than throwing the user out of the flow.

import { useCallback, useEffect, useState } from 'react'
import type { StartPointList } from '@shared/entities'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'

export type StartPointsState =
  | { phase: 'loading' }
  | { phase: 'ready'; list: StartPointList }
  | { phase: 'error'; message: string }

export function useStartPoints(projectId: string): { state: StartPointsState; reload: () => void } {
  const [state, setState] = useState<StartPointsState>({ phase: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    // A listing that arrives after the dialog has moved on must not land.
    let live = true
    setState({ phase: 'loading' })
    runtimeClient
      .call('worktree.startPoints', { projectId })
      .then((list) => {
        if (live) setState({ phase: 'ready', list })
      })
      .catch((error: unknown) => {
        if (live) setState({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      live = false
    }
  }, [projectId, attempt])

  const reload = useCallback(() => setAttempt((previous) => previous + 1), [])
  return { state, reload }
}

/** What the picker filters against while the listing is missing. */
export const EMPTY_START_POINTS: StartPointList = {
  baseRef: '',
  options: [],
  total: 0,
  limit: 0,
  truncated: false
}
