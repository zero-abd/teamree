// Remove from teamree: forgets a project or a worktree and closes its panes; nothing on disk moves.
// Red only when a pane is doing work the close would stop.

import { closePaneWarning } from './closePaneModel'
import { paneName } from '../sidebar/agentRows'
import { worktreeDisplay } from '../sidebar/worktreeDisplay'
import { useWorkspaceStore, type RemoveTarget } from '../state/workspaceStore'
import { Confirm } from './Confirm'

export function ConfirmForgetDialog({ target }: { target: RemoveTarget }): React.JSX.Element {
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const confirmForget = useWorkspaceStore((state) => state.confirmForget)
  const projects = useWorkspaceStore((state) => state.projects)
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const terminals = useWorkspaceStore((state) => state.terminals)

  const project = 'projectId' in target ? projects.find((entry) => entry.id === target.projectId) : undefined
  const worktree = 'worktreeId' in target ? worktrees.find((entry) => entry.id === target.worktreeId) : undefined
  const title = project?.name ?? (worktree === undefined ? undefined : worktreeDisplay(worktree).title)
  const worktreeIds = new Set(
    'worktreeId' in target
      ? [target.worktreeId]
      : worktrees.filter((entry) => entry.projectId === target.projectId).map((entry) => entry.id)
  )
  const working = Object.values(terminals)
    .filter((terminal) => worktreeIds.has(terminal.worktreeId) && closePaneWarning(terminal) !== null)
    .map(paneName)

  return (
    <Confirm
      title={`Remove ${title === undefined ? 'this' : `"${title}"`} from teamree?`}
      titleHint={project?.path ?? worktree?.path}
      cancel="Cancel"
      confirm={working.length > 0 ? 'Stop and Remove' : 'Remove'}
      tone={working.length > 0 ? 'danger' : 'primary'}
      onCancel={closeDialog}
      onConfirm={() => void confirmForget(target)}
    >
      {working.length > 0 ? (
        <ul className="confirm__files">
          {working.map((name, index) => (
            <li key={`${name}-${index}`} className="confirm__path">
              {name}
            </li>
          ))}
        </ul>
      ) : null}
    </Confirm>
  )
}
