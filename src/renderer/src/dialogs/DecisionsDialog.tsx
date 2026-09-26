// Show Decisions: every live task's claims, decisions and open questions in one project.

import { useMemo } from 'react'
import { useLedger } from '../state/ledgerStore'
import { useWorkspaceStore } from '../state/workspaceStore'
import { worktreeDisplay } from '../sidebar/worktreeDisplay'
import { ContextRows } from '../workspace/rightPanel/ContextSection'
import { projectContext } from '../workspace/rightPanel/contextModel'
import { Modal } from './Modal'

export function DecisionsDialog({ projectId }: { projectId: string }): React.JSX.Element {
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const openWorktree = useWorkspaceStore((state) => state.openWorktree)
  const memory = useLedger((state) => state.byProject[projectId])
  const tasks = useMemo(
    () =>
      projectContext(memory).flatMap((task) => {
        const worktree = worktrees.find((row) => row.id === task.worktreeId)
        return worktree === undefined ? [] : [{ ...task, name: worktreeDisplay(worktree).title }]
      }),
    [memory, worktrees]
  )

  return (
    <Modal title="Decisions" onClose={closeDialog}>
      <div className="decisions">
        {tasks.length === 0 ? <p className="decisions__empty">No claims or decisions</p> : null}
        {tasks.map((task) => (
          <div className="decisions__task" role="group" aria-label={task.name} key={task.worktreeId}>
            <button
              type="button"
              className="decisions__name"
              onClick={() => {
                closeDialog()
                void openWorktree(task.worktreeId)
              }}
            >
              {task.name}
            </button>
            <ContextRows worktreeId={task.worktreeId} claims={task.claims} notes={task.notes} editable />
          </div>
        ))}
      </div>
      <div className="modal__actions">
        <button type="button" className="button button--ghost" onClick={closeDialog}>
          Close
        </button>
      </div>
    </Modal>
  )
}
