// Asked before Clear Lock deletes an `index.lock`; offered only once the runtime found no git running in its checkout.

import { Confirm } from './Confirm'
import { useWorkspaceStore } from '../state/workspaceStore'

export function ClearLockDialog({ worktreeId, lockPath }: { worktreeId: string; lockPath: string }): React.JSX.Element {
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const clearLock = useWorkspaceStore((state) => state.clearLock)
  return (
    <Confirm
      title="Clear Lock?"
      body="Deletes this lock file, then retries"
      cancel="Cancel"
      confirm="Clear Lock"
      onCancel={closeDialog}
      onConfirm={() => void clearLock(worktreeId, lockPath)}
    >
      <p className="confirm__path">{lockPath}</p>
    </Confirm>
  )
}
