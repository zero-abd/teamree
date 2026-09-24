// Asked before any discard from the Changes tab. It names the file, and says where an untracked one goes;
// a copy is kept first, so the notice after it offers Undo.

import type { PatchHunk } from '@shared/patch'
import { Confirm } from './Confirm'
import { useWorkspaceStore } from '../state/workspaceStore'

export function ConfirmDiscardDialog({
  worktreeId,
  path,
  hunk
}: {
  worktreeId: string
  path: string
  hunk?: PatchHunk
}): React.JSX.Element {
  const untracked = useWorkspaceStore(
    (state) => state.changes[worktreeId]?.changes.find((change) => change.path === path)?.kind === 'untracked'
  )
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const discardChange = useWorkspaceStore((state) => state.discardChange)

  return (
    <Confirm
      title={hunk === undefined ? `Discard changes to ${path}?` : `Discard this hunk of ${path}?`}
      {...(untracked && hunk === undefined ? { body: 'Moves to the Trash' } : {})}
      cancel="Keep"
      confirm="Discard"
      onCancel={closeDialog}
      onConfirm={() => {
        closeDialog()
        void discardChange(worktreeId, path, hunk)
      }}
    >
      {hunk === undefined ? null : <p className="confirm__path">{hunk.header}</p>}
    </Confirm>
  )
}
