// Asked before every removal: the worktree by name, and what would go with it, read fresh on open.
// Force is sent only when the list showed something, or the runtime has already refused.

import { useEffect, useState } from 'react'
import type { WorktreeChanges, WorktreeStatus } from '@shared/entities'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { agentName, worktreeDisplay } from '../sidebar/worktreeDisplay'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Confirm } from './Confirm'

const FILES_SHOWN = 5

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

export function ConfirmRemoveDialog({ worktreeId }: { worktreeId: string }): React.JSX.Element {
  const worktree = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === worktreeId))
  const cached = useWorkspaceStore((state) => state.statuses[worktreeId])
  const merged = useWorkspaceStore((state) => state.landings[worktreeId]?.merged === true)
  const dialog = useWorkspaceStore((state) => (state.dialog?.kind === 'confirm-remove' ? state.dialog : null))
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const confirmRemoveWorktree = useWorkspaceStore((state) => state.confirmRemoveWorktree)

  const [status, setStatus] = useState<WorktreeStatus | undefined>(cached)
  const [changes, setChanges] = useState<WorktreeChanges | null>(null)
  useEffect(() => {
    let alive = true
    runtimeClient
      .call('worktree.status', { worktreeId })
      .then((read) => {
        if (alive) setStatus(read)
      })
      .catch(() => undefined)
    runtimeClient
      .call('worktree.changes', { worktreeId, limit: FILES_SHOWN })
      .then((read) => {
        if (alive) setChanges(read)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [worktreeId])

  const files = changes?.changes.slice(0, FILES_SHOWN).map((change) => change.path) ?? []
  const more = (changes?.total ?? 0) - files.length
  const ignored = status?.ignored ?? 0
  const ahead = merged ? 0 : (status?.ahead ?? 0)
  const lines = [
    ...files,
    ...(more > 0 ? [`+${more} more`] : []),
    ...(ignored > 0 ? [count(ignored, 'ignored file or folder', 'ignored files or folders')] : []),
    ...(ahead > 0 ? [count(ahead, 'unpushed commit', 'unpushed commits')] : [])
  ]
  const retrying = dialog?.intent === 'retry'
  const force = retrying || dialog?.refused === true || files.length > 0 || ignored > 0
  const display = worktree === undefined ? null : worktreeDisplay(worktree)
  const named = display === null ? null : `"${display.title}"${display.agent ? ` (${agentName(display.agent)})` : ''}`

  return (
    <Confirm
      title={retrying ? `Remove ${named ?? 'this worktree'}?` : `Delete ${named ?? 'this worktree'}?`}
      titleHint={worktree?.path}
      cancel="Cancel"
      confirm={retrying ? 'Remove and Retry' : 'Delete'}
      deleteConfirms
      onCancel={closeDialog}
      onConfirm={() => void confirmRemoveWorktree(worktreeId, force)}
    >
      {lines.length > 0 ? (
        <ul className="confirm__files">
          {lines.map((line) => (
            <li key={line} className="confirm__path">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
    </Confirm>
  )
}
