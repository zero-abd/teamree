// The pane host as Settings › Panes shows it: read on open, every few seconds, and after each action.

import { useCallback, useEffect, useState } from 'react'
import type { PaneHostStatus } from '@shared/entities'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'

const EVERY_MS = 2_000

export type PaneHostState = {
  status: PaneHostStatus | null
  /** Why the last action failed, or null. */
  problem: string | null
  pending: boolean
  stop: () => void
  keepShells: () => void
}

export function usePaneHostStatus(): PaneHostState {
  const [status, setStatus] = useState<PaneHostStatus | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const read = useCallback((): Promise<void> => runtimeClient.call('paneHost.status', {}).then(setStatus, () => {}), [])

  useEffect(() => {
    let live = true
    const tick = (): void => {
      if (live) void read()
    }
    tick()
    const timer = setInterval(tick, EVERY_MS)
    const watch = runtimeClient.watchWorkspace((event) => {
      if (event.type === 'settings') tick()
    })
    return () => {
      live = false
      clearInterval(timer)
      void watch.close()
    }
  }, [read])

  const act = (work: () => Promise<unknown>): void => {
    setPending(true)
    setProblem(null)
    work()
      .catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        setPending(false)
        void read()
      })
  }
  return {
    status,
    problem,
    pending,
    stop: () => act(() => runtimeClient.call('paneHost.stop', {})),
    keepShells: () => act(() => runtimeClient.call('paneHost.keepShells', {}))
  }
}
