// The one dialog in the app that exists to slow somebody down.
//
// It is never shown speculatively: it appears only after the runtime has
// already refused to remove the checkout, which it does for two reasons — work
// in there that is not committed anywhere, and files a .gitignore covers, which
// git itself would have deleted without a word. So the question is not "are you
// sure" but "this will be thrown away, and here is what".

import { Modal } from './Modal'
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
    <Modal title={`Discard ${worktree?.name ?? 'this worktree'}?`} onClose={closeDialog}>
      <div className="confirm">
        <p className="confirm__body">{reason}</p>
        {pending > 0 ? (
          <p className="confirm__detail">
            {pending} uncommitted change{pending === 1 ? '' : 's'} will be deleted with the checkout. Nothing here is on
            any branch, so there is no undo.
          </p>
        ) : null}
        {ignored > 0 ? (
          <p className="confirm__detail">
            {ignored} ignored file{ignored === 1 ? '' : 's'} or folder{ignored === 1 ? '' : 's'} will go too. teamree
            cannot tell a node_modules it could rebuild from the only copy of a .env — read the names above before you
            decide.
          </p>
        ) : null}
        {worktree ? <p className="confirm__path">{worktree.path}</p> : null}
        <div className="confirm__actions">
          <button type="button" className="button" onClick={closeDialog}>
            Keep it
          </button>
          <button type="button" className="button button--danger" onClick={() => void forceRemoveWorktree(worktreeId)}>
            {retrying ? 'Discard it and start again' : 'Discard the work'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
