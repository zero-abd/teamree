// The open worktree's setup questions, in the status rail: a row over the panes refit them, and a
// floating card covered the prompt line.

import { useWorkspaceStore } from '../state/workspaceStore'
import { SetupAsk } from './SetupAsk'
import { SetupOffer } from './SetupOffer'

export function WorktreeAsks(): React.JSX.Element | null {
  const worktree = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === state.activeWorktreeId))
  const project = useWorkspaceStore((state) => state.projects.find((entry) => entry.id === worktree?.projectId))
  const runAsk = useWorkspaceStore((state) => state.runAsk)
  const answerSetup = useWorkspaceStore((state) => state.answerSetup)
  const answerRunAsk = useWorkspaceStore((state) => state.answerRunAsk)
  // The pages that take the area from the worktree, as `WorkspaceView` orders them.
  const covered = useWorkspaceStore(
    (state) => state.dashboardOpen || state.teamworkProjectId !== null || state.settingsOpen || state.helpOpen
  )
  if (worktree === undefined || covered) return null
  return (
    <>
      {worktree.setupAsk === undefined ? null : (
        <SetupAsk command={worktree.setupAsk} onAnswer={(run) => void answerSetup(worktree.id, run)} />
      )}
      {runAsk === null || runAsk.worktreeId !== worktree.id ? null : (
        <SetupAsk command={runAsk.command} label={runAsk.kind} onAnswer={(run) => void answerRunAsk(run)} />
      )}
      {project === undefined ? null : <SetupOffer key={worktree.id} project={project} worktree={worktree} />}
    </>
  )
}
