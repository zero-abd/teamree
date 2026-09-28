// A commit a hook refused, under the message box, on its notice and in a sheet: Details and Send to Agent.

import { useState } from 'react'
import { Modal } from '../../dialogs/Modal'
import { worktreeDisplay, worktreeLabel } from '../../sidebar/worktreeDisplay'
import { useWorkspaceStore } from '../../state/workspaceStore'
import { Button, type ButtonVariant } from '../../ui/Button'
import { idleAgentPane } from './checkFailure'
import { firstLines, sendCommitBlock } from './commitBlock'

export function CommitBlocked({ worktreeId }: { worktreeId: string }): React.JSX.Element | null {
  const block = useWorkspaceStore((state) => state.commitBlocks[worktreeId])
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  if (block === undefined) return null
  return (
    <div className="changes__blocked" role="alert">
      <p className="changes__blockedHead">{`Commit blocked · ${block.hook}`}</p>
      <pre className="changes__blockedLines">{firstLines(block, 2).join('\n')}</pre>
      <div className="changes__blockedActions">
        <Button size="sm" onClick={() => openDialog({ kind: 'commit-output', worktreeId })}>
          Details
        </Button>
        <SendBlockToAgent worktreeId={worktreeId} />
      </div>
    </div>
  )
}

/** Pastes the hook's output into the worktree's idle agent, then goes to it. */
export function SendBlockToAgent({
  worktreeId,
  variant = 'secondary',
  onSent
}: {
  worktreeId: string
  variant?: ButtonVariant
  onSent?: () => void
}): React.JSX.Element {
  const idle = useWorkspaceStore((state) =>
    idleAgentPane(state.terminals, worktreeId, state.layouts[worktreeId]?.focusedTerminalId ?? null)
  )
  const revealPane = useWorkspaceStore((state) => state.revealPane)
  const showNotice = useWorkspaceStore((state) => state.showNotice)
  const [sending, setSending] = useState(false)

  const send = async (): Promise<void> => {
    const target = idle?.id
    setSending(true)
    const outcome = await sendCommitBlock(worktreeId).finally(() => setSending(false))
    if (outcome === 'sent' && target !== undefined) {
      onSent?.()
      void revealPane(worktreeId, target)
    } else if (outcome === 'refused') showNotice('The agent is busy', 'info')
    else if (outcome === 'failed') showNotice('Could not type into the pane', 'error')
  }

  return (
    <Button
      variant={variant}
      size="sm"
      disabled={idle === undefined || sending}
      title={idle === undefined ? 'No idle agent' : undefined}
      onClick={() => void send()}
    >
      Send to Agent
    </Button>
  )
}

/** The hook's whole output, as it stood when the sheet opened. */
export function CommitOutputSheet({ worktreeId }: { worktreeId: string }): React.JSX.Element {
  const [block] = useState(() => useWorkspaceStore.getState().commitBlocks[worktreeId])
  const worktree = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === worktreeId))
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const copy = useWorkspaceStore((state) => state.copyToClipboard)
  const hook = block?.hook ?? 'hook'
  const name = worktree === undefined ? '' : ` · ${worktreeLabel(worktreeDisplay(worktree))}`
  return (
    <Modal title={`Commit blocked · ${hook}${name}`} onClose={closeDialog}>
      <pre className="pane-log">{block?.output ?? ''}</pre>
      <div className="modal__actions">
        <Button disabled={!block?.output} onClick={() => void copy(block?.output ?? '', `the ${hook} output`)}>
          Copy
        </Button>
        <SendBlockToAgent worktreeId={worktreeId} onSent={closeDialog} />
        <Button variant="primary" onClick={closeDialog}>
          Done
        </Button>
      </div>
    </Modal>
  )
}
