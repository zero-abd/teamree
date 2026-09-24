// The focused file's entry in the Changes list. The list is only read while the panel shows it, so
// otherwise the runtime is asked for that one path.

import { useEffect, useState } from 'react'
import type { WorktreeChange } from '@shared/entities'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'

/** Undefined when the file has no change, or no file is focused. */
export function useFocusedChange(worktreeId: string | null, path: string | undefined): WorktreeChange | undefined {
  const listed = useWorkspaceStore((state) => (worktreeId === null ? undefined : state.changes[worktreeId]))
  const [read, setRead] = useState<WorktreeChange | undefined>(undefined)

  useEffect(() => {
    setRead(undefined)
    if (worktreeId === null || path === undefined || listed !== undefined) return
    let alive = true
    runtimeClient
      .call('worktree.changes', { worktreeId, path, limit: 1 })
      .then((changes) => {
        if (alive) setRead(changes?.changes.find((entry) => entry.path === path))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [worktreeId, path, listed])

  if (path === undefined) return undefined
  return listed === undefined ? read : listed.changes.find((entry) => entry.path === path)
}
