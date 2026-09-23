// Edited files, asked about once before a quit, a window close or a worktree removal.

import { useWorkspaceStore } from '../state/workspaceStore'
import { Confirm } from './Confirm'

export function ConfirmUnsavedDialog({
  paneIds,
  after
}: {
  paneIds: readonly string[]
  after: 'quit' | 'close' | { remove: string }
}): React.JSX.Element {
  const editedFiles = useWorkspaceStore((state) => state.editedFiles)
  const answer = useWorkspaceStore((state) => state.answerUnsaved)
  const removing = typeof after === 'object'
  const files = paneIds.map((paneId) => editedFiles[paneId]?.path).filter((path) => path !== undefined)
  const count = files.length === 1 ? '1 unsaved file' : `${files.length} unsaved files`
  return (
    <Confirm
      title={
        after === 'quit'
          ? 'Save before quitting?'
          : after === 'close'
            ? 'Save before closing?'
            : 'Save before removing?'
      }
      body={count}
      cancel="Cancel"
      confirm={removing ? 'Save' : 'Save All'}
      tone="primary"
      decline={{ label: removing ? "Don't Save" : 'Discard', onChoose: () => void answer('discard') }}
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
