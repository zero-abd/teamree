// "<name> handed you <task>" in the corner, one per offer waiting, oldest first. Never takes the focus.

import { defaultAgentKind } from '../dialogs/taskPlan'
import { useWorkspaceStore } from '../state/workspaceStore'
import { handoffPopups, useHandoffs } from './handoffsStore'

export function HandoffPopups(): React.JSX.Element | null {
  const byProject = useHandoffs((state) => state.byProject)
  const dismiss = useHandoffs((state) => state.dismiss)
  const popups = handoffPopups(byProject)
  if (popups.length === 0) return null

  return (
    <div className="notices" role="status" aria-live="polite">
      {popups.map((handoff) => (
        <div className="notice notice--info handoff" key={handoff.id} title={handoff.note}>
          <span className="notice__text">
            {handoff.from ?? handoff.to} handed you <strong>{handoff.worktreeName}</strong>
          </span>
          <button
            type="button"
            className="notice__action"
            onClick={() => void takeHandoff(handoff.projectId, handoff.id)}
          >
            Take
          </button>
          <button type="button" className="notice__action" onClick={() => void dismiss(handoff.projectId, handoff.id)}>
            Dismiss
          </button>
        </div>
      ))}
    </div>
  )
}

/** Checks the offer out here with the default agent and opens it. */
export async function takeHandoff(projectId: string, id: string): Promise<void> {
  const { agents, defaultAgent, openWorktree, showNotice } = useWorkspaceStore.getState()
  const kind = defaultAgentKind(agents, defaultAgent)
  const agent = agents.find((candidate) => candidate.kind === kind)?.command
  try {
    await openWorktree(await useHandoffs.getState().take(projectId, id, agent))
  } catch (error) {
    showNotice(`Could not take it: ${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}
