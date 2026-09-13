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
// What the steps say is still entirely `TeamworkSteps`'s business, and what
// they mean is still `startTeamwork.ts`'s. This owns the chrome, the reads, and
// the way out — plus the three things that are genuinely about *this* window
// rather than about the flow: which of the two jobs this visit is (state of a
// visit, not of a project), the clock the push's elapsed time is measured
// against, and the clipboard.

import { useCallback, useEffect, useRef, useState } from 'react'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'
import { TerminalView } from '../terminal/TerminalView'
import { TeamworkSteps } from './TeamworkSteps'
import type { TeamworkPath } from './startTeamwork'

/**
 * How often the deploy pane is read for the URL it printed.
 *
 * The pane streams to xterm, not to this file, so the only way to know what it
 * said is to ask the runtime for its scrollback. Once and a half a second is
 * far below anybody's reading speed and costs one small call while a deploy is
 * on screen and nothing at all when none is.
 */
const DEPLOY_POLL_MS = 1_500

/** Enough of the tail to hold the endpoint the deploy prints at the very end. */
const DEPLOY_TAIL_BYTES = 32_768

/**
 * How often a running push is asked what it is doing.
 *
 * Twice a second, which is what makes an elapsed counter read as a counter
 * rather than as a number that occasionally changes — and it is also the tick
 * that moves that counter at all, since the whole view re-renders on the answer
 * and the clock is read then. It costs one map lookup in the main process and
 * runs only while a push is in flight.
 */
const PUBLISH_POLL_MS = 500

/**
 * Puts text on the clipboard, by whichever of the two ways is available.
 *
 * The async clipboard API needs a secure context, and a renderer loaded from a
 * file URL in a packaged build is not reliably one — so the old selection-based
 * copy is kept as the fallback rather than as a relic. There is nothing to
 * report back: a copy that fails both ways leaves the text on screen, which is
 * where it already was, and the invitation is rendered in full for exactly that
 * reason.
 */
function copyToClipboard(text: string): void {
  const async = navigator.clipboard?.writeText(text)
  if (async !== undefined) {
    void async.catch(() => selectAndCopy(text))
    return
  }
  selectAndCopy(text)
}

function selectAndCopy(text: string): void {
  const field = document.createElement('textarea')
  field.value = text
  // Off-screen rather than hidden: a `display: none` element cannot be selected,
  // which is the whole mechanism this depends on.
  field.style.position = 'fixed'
  field.style.left = '-9999px'
  document.body.append(field)
  field.select()
  try {
    document.execCommand('copy')
  } catch {
    // Nothing to do and nothing to say. The text is on screen either way.
  }
  field.remove()
}

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
  const originPending = useWorkspaceStore((state) => state.originPending)
  const originError = useWorkspaceStore((state) => state.originError)
  const setOrigin = useWorkspaceStore((state) => state.setOrigin)
  const deploy = useWorkspaceStore((state) => state.relayDeploys[projectId])
  const startRelayDeploy = useWorkspaceStore((state) => state.startRelayDeploy)
  const closeRelayDeploy = useWorkspaceStore((state) => state.closeRelayDeploy)
  const noteRelayDeploy = useWorkspaceStore((state) => state.noteRelayDeploy)
  const publishPlan = useWorkspaceStore((state) => state.publishPlans[projectId])
  const publishPending = useWorkspaceStore((state) => state.publishPending)
  const publishError = useWorkspaceStore((state) => state.publishError)
  const publishResult = useWorkspaceStore((state) => state.publishResults[projectId])
  const loadPublishPlan = useWorkspaceStore((state) => state.loadPublishPlan)
  const publishTeamwork = useWorkspaceStore((state) => state.publishTeamwork)
  const publishProgress = useWorkspaceStore((state) => state.publishProgress[projectId])
  const loadPublishProgress = useWorkspaceStore((state) => state.loadPublishProgress)
  const cancelPublish = useWorkspaceStore((state) => state.cancelPublish)
  const deployRunning = useWorkspaceStore((state) =>
    deploy === undefined ? false : (state.terminals[deploy.terminalId]?.running ?? false)
  )

  // All three read on open. The runtime watches `.teamree` and says when it
  // moves, so this is belt and braces rather than the only way any of them is
  // refreshed — and it is what covers a project whose watch could not be set up.
  useEffect(() => {
    void loadMembers(projectId)
    void loadRelay(projectId)
    void loadTeamwork(projectId)
    // The fourth read: what the commit-and-push button would do. It is a git
    // call rather than a file read, so it is asked for here rather than folded
    // into one of the three — and asked for on open, because the button has to
    // be able to say what it will do before anybody presses it.
    void loadPublishPlan(projectId)
  }, [loadMembers, loadPublishPlan, loadRelay, loadTeamwork, projectId])

  // What the push would do is a git call, not a file read, so it is not on the
  // watch that carries `.teamree`. Re-read whenever either of the two facts it
  // describes moves — a key written here or pulled in, a relay set or changed —
  // because a plan that is one step behind is a button describing the wrong
  // commit.
  const enrolled = list?.enrolled === true
  const selfFile = list === undefined ? null : list.selfFile
  const relayOnDisk = relay?.onDisk.url ?? null
  useEffect(() => {
    void loadPublishPlan(projectId)
  }, [enrolled, loadPublishPlan, projectId, relayOnDisk, selfFile])

  // What the push is doing, asked for only while one is running.
  //
  // This is the whole of the fix for "it gets stuck at git push" on this side
  // of the wire: `teamwork.publish` does not answer until the push is over, so
  // the only way to say anything in between is to ask a second question. It is
  // a poll rather than a subscription for the same reason the deploy pane below
  // is polled — the thing being watched lives for seconds, and a subscription
  // to set up and tear down for it would be more machinery than the question
  // deserves. `now` moves with it, so the elapsed time on screen is this
  // render's clock rather than the one from whenever the panel last happened to
  // redraw.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!publishPending) return
    let alive = true
    const tick = (): void => {
      if (!alive) return
      setNow(Date.now())
      void loadPublishProgress(projectId)
    }
    tick()
    const timer = setInterval(tick, PUBLISH_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [loadPublishProgress, projectId, publishPending])

  // What the deploy pane has printed, asked for while one is on screen and
  // never otherwise. The endpoint is the last thing the command says and there
  // is no other way back from a program in a terminal.
  const terminalId = deploy?.terminalId
  useEffect(() => {
    if (terminalId === undefined) return
    let alive = true
    const read = async (): Promise<void> => {
      try {
        const { data } = await runtimeClient.call('terminal.read', {
          terminalId,
          tailBytes: DEPLOY_TAIL_BYTES
        })
        if (alive) noteRelayDeploy(projectId, data, useWorkspaceStore.getState().terminals[terminalId]?.running ?? true)
      } catch {
        // A pane that has gone is the close button's problem, not a poll's.
      }
    }
    void read()
    const timer = setInterval(() => void read(), DEPLOY_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [noteRelayDeploy, projectId, terminalId])

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

  // The pane is rendered here rather than inside the steps, so the steps stay a
  // pure function of their props and can be rendered whole without a canvas.
  const [paneFocused, setPaneFocused] = useState(false)
  const renderDeployPane = useCallback(
    (id: string): React.ReactNode => (
      <TerminalView
        terminalId={id}
        focused={paneFocused}
        onFocus={() => setPaneFocused(true)}
        isAppChord={() => false}
        searchOpen={false}
        searchToken={0}
        onCloseSearch={() => undefined}
      />
    ),
    [paneFocused]
  )

  const name = project?.name ?? 'this repository'

  // Which of the two jobs this is, kept here and not in the store: it is a
  // statement about this visit rather than about the project, and a project
  // that remembered "I am joining" would go on saying it to whoever opened the
  // panel next, including the person who set the team up.
  const [path, setPath] = useState<TeamworkPath | null>(null)

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
            origin={{ pending: originPending, error: originError }}
            onSetOrigin={(url) => void setOrigin(projectId, url)}
            deploy={deploy === undefined ? undefined : { ...deploy, running: deployRunning }}
            onDeployRelay={() => void startRelayDeploy(projectId)}
            onCloseDeploy={() => void closeRelayDeploy(projectId)}
            renderDeployPane={renderDeployPane}
            publish={{
              plan: publishPlan,
              pending: publishPending,
              error: publishError,
              result: publishResult,
              progress: publishProgress
            }}
            onPublish={() => void publishTeamwork(projectId)}
            onCancelPublish={() => void cancelPublish(projectId)}
            now={now}
            path={path}
            onChoosePath={setPath}
            projectName={name}
            onCopy={copyToClipboard}
          />
        </div>
      </div>
    </main>
  )
}
