// The one dialog in the app that exists to slow somebody down.
//
// It is never shown speculatively: it appears only after the runtime has
// already refused to remove the checkout, which it does for two reasons — work
// in there that is not committed anywhere, and files a .gitignore covers, which
// git itself would have deleted without a word. So the question is not "are you
// sure" but "this will be thrown away, and here is what".

import { Confirm } from './Confirm'
import { useWorkspaceStore } from '../state/workspaceStore'

export function ConfirmRemoveDialog({ worktreeId, reason }: { worktreeId: string; reason: string }): React.JSX.Element {
  const worktree = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === worktreeId))
  const status = useWorkspaceStore((state) => state.statuses[worktreeId])
  const retrying = useWorkspaceStore(
    (state) => state.dialog?.kind === 'confirm-remove' && state.dialog.intent === 'retry'
  )
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const forceRemoveWorktree = useWorkspaceStore((state) => state.forceRemoveWorktree)

  const pending = status === undefined ? 0 : status.staged + status.unstaged + status.untracked + status.conflicted
  const ignored = status?.ignored ?? 0

  return (
    <Confirm
      title={`Discard ${worktree?.name ?? 'this worktree'}?`}
      body={reason}
      cancel="Keep it"
      confirm={retrying ? 'Discard it and start again' : 'Discard the work'}
      onCancel={closeDialog}
      onConfirm={() => void forceRemoveWorktree(worktreeId)}
    >
      {pending > 0 ? (
        <p className="confirm__detail">
          {pending} uncommitted change{pending === 1 ? '' : 's'}
        </p>
      ) : null}
      {ignored > 0 ? (
        <p className="confirm__detail">
          {ignored} ignored file{ignored === 1 ? '' : 's'} or folder{ignored === 1 ? '' : 's'}
        </p>
      ) : null}
      {worktree ? <p className="confirm__path">{worktree.path}</p> : null}
    </Confirm>
  )
}
