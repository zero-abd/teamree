// Asked before any discard from the Changes tab. It names the file, counts the files or shows a hunk's lines, and
// says where an untracked one goes; a copy is kept first, so the notice after it offers Undo.

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
      {hunk === undefined ? null : <HunkPreview hunk={hunk} />}
    </Confirm>
  )
}

const PREVIEW_LINES = 8

function HunkPreview({ hunk }: { hunk: PatchHunk }): React.JSX.Element {
  const changed = hunk.lines.filter((line) => line.kind !== 'context')
  const more = changed.length - PREVIEW_LINES
  return (
    <div className="confirm__hunk">
      {changed.slice(0, PREVIEW_LINES).map((line, index) => (
        <div key={index} className={`confirm__hunkLine confirm__hunkLine--${line.kind}`}>
          {`${line.kind === 'added' ? '+' : '-'}${line.text}`}
        </div>
      ))}
      {more > 0 ? <div className="confirm__hunkMore">{`+${more} more`}</div> : null}
    </div>
  )
}
