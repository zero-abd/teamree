// What is wrong with workspace.json, read on mount and on each `workspaceFile` event. A load problem is
// dismissed in this window; a failed save leaves only when a save lands.

import { useCallback, useEffect, useState } from 'react'
import type { WorkspaceFileProblem } from '@shared/entities'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'

export type StoreProblems = {
  problems: WorkspaceFileProblem[]
  retrying: boolean
  retry: () => void
  dismiss: (problem: WorkspaceFileProblem) => void
}

export function problemKey(problem: WorkspaceFileProblem): string {
  return problem.kind === 'saveFailed' ? problem.kind : `${problem.kind}:${problem.keptAt ?? problem.filePath}`
}

export function useStoreProblems(): StoreProblems {
  const [problems, setProblems] = useState<WorkspaceFileProblem[]>([])
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const [retrying, setRetrying] = useState(false)
  const read = useCallback(
    (): Promise<void> => runtimeClient.call('workspace.problems', {}).then(setProblems, () => {}),
    []
  )

  useEffect(() => {
    void read()
    const watch = runtimeClient.watchWorkspace((event) => {
      if (event.type === 'workspaceFile') void read()
    })
    return () => void watch.close()
  }, [read])

  return {
    problems: problems.filter((problem) => !dismissed.has(problemKey(problem))),
    retrying,
    retry: () => {
      setRetrying(true)
      runtimeClient
        .call('workspace.retrySave', {})
        .catch(() => {})
        .finally(() => {
          setRetrying(false)
          void read()
        })
    },
    dismiss: (problem) => setDismissed((current) => new Set(current).add(problemKey(problem)))
  }
}
