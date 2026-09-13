// Setting teamwork up, given the whole main area.
//
// It was a modal, and a modal was the wrong shape for it. Five steps, two files
// to write, a decision about where a relay lives and a block of commands to
// copy into a terminal do not belong in a box that is 640px wide and dismissed
// by clicking beside it — least of all when the thing being read alongside them
// is a repository. So this fills the main area the way a worktree's panes do,
// and the way the pane board already does: it is about a project rather than
// about whichever worktree happens to be open, which is exactly the kind of
// question that should not be framed by that worktree's tab.
//
// Nothing about the steps themselves changed. `TeamworkSteps` is the same
// component under the same props, and `startTeamwork.ts` is the same reading of
// the same three runtime answers. This is presentation, and it says so by
// owning nothing but the chrome, the three reads on open, and the way out.

import { useEffect, useRef } from 'react'
import { useWorkspaceStore } from '../state/workspaceStore'
import { TeamworkSteps } from './TeamworkSteps'

export function TeamworkView({ projectId }: { projectId: string }): React.JSX.Element {
  const project = useWorkspaceStore((state) => state.projects.find((entry) => entry.id === projectId))
  const list = useWorkspaceStore((state) => state.members[projectId])
  const relay = useWorkspaceStore((state) => state.relays[projectId])
  const status = useWorkspaceStore((state) => state.teamwork[projectId])
  const readErrors = useWorkspaceStore((state) => state.teamworkReadErrors[projectId])
  const membersPending = useWorkspaceStore((state) => state.membersPending)
  const membersError = useWorkspaceStore((state) => state.membersError)
  const relayPending = useWorkspaceStore((state) => state.relayPending)
  const relayError = useWorkspaceStore((state) => state.relayError)
  const loadMembers = useWorkspaceStore((state) => state.loadMembers)
  const loadRelay = useWorkspaceStore((state) => state.loadRelay)
  const loadTeamwork = useWorkspaceStore((state) => state.loadTeamwork)
  const setRelay = useWorkspaceStore((state) => state.setRelay)
  const joinProject = useWorkspaceStore((state) => state.joinProject)
  const clearMembersError = useWorkspaceStore((state) => state.clearMembersError)
  const closeTeamwork = useWorkspaceStore((state) => state.closeTeamwork)

  // All three read on open. The runtime watches `.teamree` and says when it
  // moves, so this is belt and braces rather than the only way any of them is
  // refreshed — and it is what covers a project whose watch could not be set up.
  useEffect(() => {
    void loadMembers(projectId)
    void loadRelay(projectId)
    void loadTeamwork(projectId)
  }, [loadMembers, loadRelay, loadTeamwork, projectId])

  // Escape is what every reader tries first on a view they opened to look at
  // something, and it is what the modal this replaced did. Capture, for the
  // reason the chords are captured: a focused pane must not eat it first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // A dialog opened on top owns Escape — the task composer, say. Closing
      // both with one press would take away more than the reader asked for.
      if (useWorkspaceStore.getState().dialog) return
      event.preventDefault()
      closeTeamwork()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [closeTeamwork])

  // The view is reached from a button somewhere else in the window, so the
  // keyboard has to come with it: without this, Tab from the sidebar walks the
  // rest of the sidebar while the thing that just opened is unreachable.
  // Focusing the region rather than a control inside it puts the next Tab on
  // the first step's own button and reads the view's name out on arrival.
  const region = useRef<HTMLElement>(null)
  useEffect(() => {
    region.current?.focus()
  }, [projectId])

  const name = project?.name ?? 'this repository'

  return (
    <main className="workspace teamwork-view" aria-label={`Set up teamwork in ${name}`} tabIndex={-1} ref={region}>
      <header className="teamwork-view__head">
        {/* Laid out over the same column the steps are, so the title sits above
            the thing it titles rather than out at the window's edge. */}
        <div className="teamwork-view__column teamwork-view__head-row">
          <div className="teamwork-view__identity">
            <h1 className="teamwork-view__title">Start teamwork</h1>
            <p className="teamwork-view__lede">Everyone who can push to {name} is on the team. Their keys are in it.</p>
          </div>
          <button type="button" className="button button--ghost button--small" onClick={closeTeamwork}>
            Close
          </button>
        </div>
      </header>

      <div className="teamwork-view__body">
        <div className="teamwork-view__column">
          <TeamworkSteps
            projectPath={project?.path}
            list={list}
            relay={relay}
            status={status}
            membersPending={membersPending}
            membersError={membersError}
            relayPending={relayPending}
            relayError={relayError}
            readErrors={readErrors ?? {}}
            onJoin={(handle) => void joinProject(projectId, handle)}
            onClearMembersError={clearMembersError}
            onSetRelay={(url) => void setRelay(projectId, url)}
            onRetry={(read) => {
              if (read === 'list') void loadMembers(projectId)
              else if (read === 'relay') void loadRelay(projectId)
              else void loadTeamwork(projectId)
            }}
          />
        </div>
      </div>
    </main>
  )
}
