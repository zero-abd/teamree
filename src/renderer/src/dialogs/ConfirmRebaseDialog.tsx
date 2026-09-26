// Asked when a move needs the worktree's commits replayed onto its new parent's tip.

import { applyNest } from '../sidebar/nestDrag'
import { rebaseQuestion } from '../sidebar/nestDrop'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Confirm } from './Confirm'

export function ConfirmRebaseDialog({
  worktreeId,
  parentId
}: {
  worktreeId: string
  parentId: string
}): React.JSX.Element {
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const branch = (id: string): string => worktrees.find((entry) => entry.id === id)?.branch ?? ''
  return (
    <Confirm
      title={rebaseQuestion(worktrees, worktreeId, parentId)}
      titleHint={`${branch(worktreeId)} onto ${branch(parentId)}`}
      cancel="Cancel"
      confirm="Rebase"
      tone="primary"
      onCancel={closeDialog}
      onConfirm={() => {
        closeDialog()
        void applyNest(worktreeId, parentId, true)
      }}
    />
  )
}
