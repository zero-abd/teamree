// Asked before any discard from the Changes tab. It names the file, or counts the files, and says where an
// untracked one goes; a copy is kept first, so the notice after it offers Undo.

import type { PatchHunk } from '@shared/patch'
import { Confirm } from './Confirm'
import { useWorkspaceStore } from '../state/workspaceStore'

export function ConfirmDiscardDialog({
  worktreeId,
  path,
  hunk,
  paths
}: {
  worktreeId: string
  path: string
  hunk?: PatchHunk
  paths?: readonly string[]
}): React.JSX.Element {
  const named = paths ?? [path]
  const untracked = useWorkspaceStore((state) =>
    (state.changes[worktreeId]?.changes ?? []).some(
      (change) => change.kind === 'untracked' && named.includes(change.path)
    )
  )
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const discardChange = useWorkspaceStore((state) => state.discardChange)
  const discardChanges = useWorkspaceStore((state) => state.discardChanges)
  const title =
    paths !== undefined
      ? `Discard changes to ${paths.length} file${paths.length === 1 ? '' : 's'}?`
      : hunk === undefined
        ? `Discard changes to ${path}?`
        : `Discard this hunk of ${path}?`

  return (
    <Confirm
      title={title}
      {...(untracked && hunk === undefined
        ? { body: paths === undefined ? 'Moves to the Trash' : 'New files move to the Trash' }
        : {})}
      cancel="Keep"
      confirm="Discard"
      onCancel={closeDialog}
      onConfirm={() => {
        closeDialog()
        if (paths !== undefined) void discardChanges(worktreeId, paths)
        else void discardChange(worktreeId, path, hunk)
      }}
    >
      {hunk === undefined ? null : <p className="confirm__path">{hunk.header}</p>}
    </Confirm>
  )
}
