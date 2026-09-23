// The runtime's fuzzy file matches for what is typed, asked once typing pauses. The ranking over the
// whole index runs in the runtime, so a 10k-file worktree never reaches this window.

import { useEffect, useState } from 'react'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'

/** How long after a keystroke the runtime is asked. */
export const FILE_FIND_DEBOUNCE_MS = 80

export type FileMatches = { query: string; paths: readonly string[] }

/** The latest answer, possibly for an earlier query; null until the first. Off while `worktreeId` is null. */
export function useFileMatches(worktreeId: string | null, query: string, limit: number): FileMatches | null {
  const [answer, setAnswer] = useState<FileMatches | null>(null)
  const wanted = query.trim()

  useEffect(() => {
    if (worktreeId === null || wanted === '') return
    let live = true
    const timer = setTimeout(() => {
      runtimeClient
        .call('worktree.findFiles', { worktreeId, query: wanted, limit, fuzzy: true })
        .then((found) => {
          if (live) setAnswer({ query: wanted, paths: found.paths })
        })
        .catch(() => {
          if (live) setAnswer({ query: wanted, paths: [] })
        })
    }, FILE_FIND_DEBOUNCE_MS)
    // A reply to a query already typed past is dropped.
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [worktreeId, wanted, limit])

  return answer
}
