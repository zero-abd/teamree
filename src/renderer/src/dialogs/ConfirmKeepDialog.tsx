// Asked before a task's other runs are removed for the one kept: each run by its agent, and what it
// holds that would go, read fresh as the removal dialog reads it. Force only when something was shown.

import { useEffect, useState } from 'react'
import type { WorktreeChanges, WorktreeStatus } from '@shared/entities'
import { runName, siblingRuns } from '../compare/siblingRuns'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Confirm } from './Confirm'

const FILES_SHOWN = 5

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

type Held = { files: string[]; more: number; ignored: number; ahead: number }

export function ConfirmKeepDialog({ worktreeId }: { worktreeId: string }): React.JSX.Element {
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const refused = useWorkspaceStore((state) => state.dialog?.kind === 'confirm-keep' && state.dialog.refused === true)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const confirmKeepRun = useWorkspaceStore((state) => state.confirmKeepRun)
  const kept = worktrees.find((entry) => entry.id === worktreeId)
  const others = kept === undefined ? [] : siblingRuns(kept, worktrees)
  const otherIds = others.map((other) => other.id).join(' ')
  const [held, setHeld] = useState<Record<string, Held>>({})

  useEffect(() => {
    let alive = true
    for (const id of otherIds.split(' ').filter(Boolean)) {
      void Promise.all([
        runtimeClient.call('worktree.status', { worktreeId: id }).catch((): WorktreeStatus | null => null),
        runtimeClient
          .call('worktree.changes', { worktreeId: id, limit: FILES_SHOWN })
          .catch((): WorktreeChanges | null => null)
      ]).then(([status, changes]) => {
        if (!alive) return
        const files = changes?.changes.slice(0, FILES_SHOWN).map((change) => change.path) ?? []
        const read = {
          files,
          more: (changes?.total ?? 0) - files.length,
          ignored: status?.ignored ?? 0,
          ahead: status?.ahead ?? 0
        }
        setHeld((current) => ({ ...current, [id]: read }))
      })
    }
    return () => {
      alive = false
    }
  }, [otherIds])

  const lines = (read: Held | undefined): string[] =>
    read === undefined
      ? []
      : [
          ...read.files,
          ...(read.more > 0 ? [`+${read.more} more`] : []),
          ...(read.ignored > 0 ? [count(read.ignored, 'ignored file or folder', 'ignored files or folders')] : []),
          ...(read.ahead > 0 ? [count(read.ahead, 'unpushed commit', 'unpushed commits')] : [])
        ]
  const force =
    refused || others.some((other) => (held[other.id]?.files.length ?? 0) > 0 || (held[other.id]?.ignored ?? 0) > 0)
  const name = kept === undefined ? 'this' : runName(kept)

  return (
    <Confirm
      title={`Keep ${name} run, remove ${count(others.length, 'other', 'others')}?`}
      cancel="Cancel"
      confirm="Keep and Remove"
      onCancel={closeDialog}
      onConfirm={() => void confirmKeepRun(worktreeId, force)}
    >
      {others.map((other) => {
        const shown = lines(held[other.id])
        if (shown.length === 0) return null
        return (
          <div key={other.id} className="confirm__run">
            <p className="confirm__runName" title={other.path}>
              {runName(other)}
            </p>
            <ul className="confirm__files">
              {shown.map((line) => (
                <li key={line} className="confirm__path">
                  {line}
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </Confirm>
  )
}
