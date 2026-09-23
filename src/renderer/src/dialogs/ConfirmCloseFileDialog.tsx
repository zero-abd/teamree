import { filePaneName, fileLeavesIn } from '@shared/filePane'
import { dropDraft } from '../files/fileDrafts'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Confirm } from './Confirm'

export function ConfirmCloseFileDialog({ terminalId }: { terminalId: string }): React.JSX.Element {
  const path = useWorkspaceStore((state) => {
    const layout = state.activeWorktreeId ? state.layouts[state.activeWorktreeId] : undefined
    return fileLeavesIn(layout?.root ?? null).find((leaf) => leaf.terminalId === terminalId)?.path
  })
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const forceCloseTerminal = useWorkspaceStore((state) => state.forceCloseTerminal)
  return (
    <Confirm
      title="Discard unsaved changes?"
      body={filePaneName(path ?? '')}
      cancel="Keep editing"
      confirm="Discard"
      onCancel={closeDialog}
      onConfirm={() => {
        closeDialog()
        dropDraft(terminalId)
        void forceCloseTerminal(terminalId)
      }}
    />
  )
}
