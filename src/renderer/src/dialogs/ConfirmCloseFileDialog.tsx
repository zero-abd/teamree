import { filePaneName, fileLeavesIn } from '@shared/filePane'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Confirm } from './Confirm'

export function ConfirmCloseFileDialog({ terminalId }: { terminalId: string }): React.JSX.Element {
  const path = useWorkspaceStore((state) => {
    const layout = state.activeWorktreeId ? state.layouts[state.activeWorktreeId] : undefined
    return fileLeavesIn(layout?.root ?? null).find((leaf) => leaf.terminalId === terminalId)?.path
  })
  const answer = useWorkspaceStore((state) => state.answerUnsaved)
  return (
    <Confirm
      title={`Save changes to ${filePaneName(path ?? '')}?`}
      cancel="Cancel"
      confirm="Save"
      tone="primary"
      decline={{ label: "Don't Save", onChoose: () => void answer('discard') }}
      onCancel={() => void answer('cancel')}
      onConfirm={() => void answer('save')}
    >
      {path === undefined ? null : <p className="confirm__path">{path}</p>}
    </Confirm>
  )
}
