// Edited files, asked about once before a quit, a window close or a worktree removal, in the words
// closing one file uses.

import { filePaneName } from '@shared/filePane'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Confirm } from './Confirm'

export function ConfirmUnsavedDialog({ paneIds }: { paneIds: readonly string[] }): React.JSX.Element {
  const editedFiles = useWorkspaceStore((state) => state.editedFiles)
  const answer = useWorkspaceStore((state) => state.answerUnsaved)
  const files = paneIds.map((paneId) => editedFiles[paneId]?.path).filter((path) => path !== undefined)
  const several = files.length > 1
  return (
    <Confirm
      title={several ? `Save changes to ${files.length} files?` : `Save changes to ${filePaneName(files[0] ?? '')}?`}
      cancel="Cancel"
      confirm={several ? 'Save All' : 'Save'}
      tone="primary"
      decline={{ label: "Don't Save", onChoose: () => void answer('discard') }}
      onCancel={() => void answer('cancel')}
      onConfirm={() => void answer('save')}
    >
      <ul className="confirm__files">
        {files.map((path) => (
          <li key={path} className="confirm__path">
            {path}
          </li>
        ))}
      </ul>
    </Confirm>
  )
}
