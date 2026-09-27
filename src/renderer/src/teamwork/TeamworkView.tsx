// Teamwork, given the whole main area: the team's home once this machine is on the roster, the setup
// before. What the steps say is `TeamworkSteps`'s business and what they mean is `startTeamwork.ts`'s;
// this owns the reads, which job this visit is, and the push clock.

import { useCallback, useEffect, useState } from 'react'
import { teamworkFacts } from '@shared/entities'
import { copyText } from '../clipboard/clipboard'
import { Select } from '../ui/Select'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'
import { TerminalView } from '../terminal/TerminalView'
import { PageFrame } from '../workspace/PageFrame'
import { SharedNotesList } from './SharedNotesList'
import { unreadNotes, useSharedNotes } from './sharedNotesStore'
import { onlineCount } from './homeRows'
import { TeamHome, TeamInviteActions } from './TeamHome'
import { TeamworkSteps } from './TeamworkSteps'
import { inviteText, startTeamworkFlow, type TeamworkPath } from './startTeamwork'

/**
 * How often the relay pane's scrollback is read; the pane streams to xterm,
 * not to this file. One small call while a relay command is on screen.
 */
const RELAY_PANE_POLL_MS = 1_500

/** Enough of the tail to hold the endpoint a deploy or a relay prints at the end. */
const RELAY_PANE_TAIL_BYTES = 32_768

/**
 * How often a running push is asked what it is doing. This is also the tick
 * that moves the elapsed counter: the clock is read on each re-render.
 */
const PUBLISH_POLL_MS = 500

export function TeamworkView({ projectId }: { projectId: string }): React.JSX.Element {
  const projects = useWorkspaceStore((state) => state.projects)
  const project = projects.find((entry) => entry.id === projectId)
  const openTeamwork = useWorkspaceStore((state) => state.openTeamwork)
  const inbox = useSharedNotes((state) => state.inbox)
  const deleting = useSharedNotes((state) => state.deleting)
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
  const pane = useWorkspaceStore((state) => state.relayPanes[projectId])
  const startRelayPane = useWorkspaceStore((state) => state.startRelayPane)
  const closeRelayPane = useWorkspaceStore((state) => state.closeRelayPane)
  const noteRelayPane = useWorkspaceStore((state) => state.noteRelayPane)
  const publishPlan = useWorkspaceStore((state) => state.publishPlans[projectId])
  const publishPending = useWorkspaceStore((state) => state.publishPending)
  const publishError = useWorkspaceStore((state) => state.publishError)
  const publishResult = useWorkspaceStore((state) => state.publishResults[projectId])
  const loadPublishPlan = useWorkspaceStore((state) => state.loadPublishPlan)
  const publishTeamwork = useWorkspaceStore((state) => state.publishTeamwork)
  const publishProgress = useWorkspaceStore((state) => state.publishProgress[projectId])
  const loadPublishProgress = useWorkspaceStore((state) => state.loadPublishProgress)
  const cancelPublish = useWorkspaceStore((state) => state.cancelPublish)
  const pullTeamwork = useWorkspaceStore((state) => state.pullTeamwork)
  const joinedFrom = useWorkspaceStore((state) => state.joinedFrom[projectId])
  const openInvitation = useWorkspaceStore((state) => state.openInvitation)
  const paneRunning = useWorkspaceStore((state) =>
    pane === undefined ? false : (state.terminals[pane.terminalId]?.running ?? false)
  )

  // All three read on open: belt and braces beside the `.teamree` watch, and
  // the only refresh for a project whose watch could not be set up.
  useEffect(() => {
    void loadMembers(projectId)
    void loadRelay(projectId)
    void loadTeamwork(projectId)
    // The fourth read, a git call: the button has to say what it will do before it is pressed.
    void loadPublishPlan(projectId)
  }, [loadMembers, loadPublishPlan, loadRelay, loadTeamwork, projectId])

  // The plan is not on the `.teamree` watch, so re-read when either fact it
  // describes moves: a plan one step behind is a button describing the wrong commit.
  const enrolled = list?.enrolled === true
  const selfFile = list === undefined ? null : list.selfFile
  const relayOnDisk = relay?.onDisk.url ?? null
  useEffect(() => {
    void loadPublishPlan(projectId)
  }, [enrolled, loadPublishPlan, projectId, relayOnDisk, selfFile])

  // What the push is doing, polled only while one is running: `teamwork.publish`
  // does not answer until the push is over, so this is the only way to say
  // anything in between. `now` moves with it so the elapsed time is this render's clock.
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

  // What the relay pane has printed, polled only while one is on screen: the
  // endpoint is the last thing a deploy or a relay says, and there is no other
  // way back from a program in a terminal. Which verb may yield a URL is the store's business.
  const terminalId = pane?.terminalId
  useEffect(() => {
    if (terminalId === undefined) return
    let alive = true
    const read = async (): Promise<void> => {
      try {
        const { data } = await runtimeClient.call('terminal.read', {
          terminalId,
          tailBytes: RELAY_PANE_TAIL_BYTES
        })
        if (alive) noteRelayPane(projectId, data, useWorkspaceStore.getState().terminals[terminalId]?.running ?? true)
      } catch {
        // A pane that has gone is the close button's problem, not a poll's.
      }
    }
    void read()
    const timer = setInterval(() => void read(), RELAY_PANE_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [noteRelayPane, projectId, terminalId])

  // The pane is rendered here so the steps stay a pure function of their props.
  const [paneFocused, setPaneFocused] = useState(false)
  const renderRelayPane = useCallback(
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

  // Which of the two jobs this is, kept here and not in the store: it is about
  // this visit, and a project that remembered "I am joining" would say it to whoever opened it next.
  const [path, setPath] = useState<TeamworkPath | null>(joinedFrom === undefined ? null : 'join')

  // On the roster is on the team: the question of starting or joining one is behind us.
  const home = enrolled
  const flow = startTeamworkFlow({
    list,
    relay,
    status,
    failedReads: readErrors ?? {},
    path: path ?? 'start',
    publish: publishResult,
    waitingFor: joinedFrom
  })
  // A push teamree cannot check is not left to do once a teammate's key has come the other way.
  const current = flow.steps.find((step) => step.id === flow.currentId)
  const teammateOnRoster = list?.members.some((member) => !member.isSelf) === true
  const toDo =
    current !== undefined &&
    current.id !== 'connected' &&
    !(current.id === 'push' && current.mark === 'unchecked' && teammateOnRoster)
  // Undefined until pressed: open while a step is still to do, folded once nothing is.
  const [setupShown, setSetupShown] = useState<boolean | undefined>(undefined)
  const setupOpen = setupShown ?? toDo
  const presence = useWorkspaceStore((state) => state.teammates[projectId])
  const origin = teamworkFacts(status)?.origin
  const invite = inviteText({
    originUrl: origin?.ok === true ? origin.url : null,
    projectName: name,
    handle: list?.self.handle ?? null
  })

  const steps = (
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
      pane={pane === undefined ? undefined : { ...pane, running: paneRunning }}
      onStartRelayPane={(kind, argument) => void startRelayPane(projectId, kind, argument)}
      onClosePane={() => void closeRelayPane(projectId)}
      renderRelayPane={renderRelayPane}
      publish={{
        plan: publishPlan,
        pending: publishPending,
        error: publishError,
        result: publishResult,
        progress: publishProgress
      }}
      onPublish={() => void publishTeamwork(projectId)}
      onPullAndPublish={() => void publishTeamwork(projectId, { pull: true })}
      onPull={() => void pullTeamwork(projectId)}
      onCancelPublish={() => void cancelPublish(projectId)}
      now={now}
      path={home ? (path ?? 'start') : path}
      onChoosePath={setPath}
      projectName={name}
      onCopy={copyText}
      waitingFor={joinedFrom}
      onPasteInvitation={(raw) => openInvitation(raw)}
      inHome={home}
    />
  )

  const setup = (
    <section className="team-home__section team-setup" aria-label="Setup">
      <h2 className="team-home__head">
        <button
          type="button"
          className="team-setup__toggle"
          aria-expanded={setupOpen}
          onClick={() => setSetupShown(!setupOpen)}
        >
          <span className="disclosure__caret" aria-hidden="true">
            {setupOpen ? '▾' : '▸'}
          </span>
          Setup
        </button>
      </h2>
      {setupOpen ? steps : null}
    </section>
  )

  const projectSelect =
    projects.length > 1 ? (
      <Select aria-label="Project" value={projectId} onChange={(event) => openTeamwork(event.target.value)}>
        {projects.map((entry) => {
          const unread = unreadNotes({ inbox, deleting }, entry.id)
          return (
            <option key={entry.id} value={entry.id}>
              {unread > 0 ? `${entry.name} · ${unread} unread` : entry.name}
            </option>
          )
        })}
      </Select>
    ) : null

  return (
    <PageFrame
      label={home ? `Teamwork in ${name}` : `Set up teamwork in ${name}`}
      title={project?.name ?? 'Teamwork'}
      lede={
        project === undefined
          ? undefined
          : home
            ? `Teamwork · ${onlineCount({ list, presence, status })} online`
            : 'Teamwork'
      }
      actions={
        home ? (
          <>
            {projectSelect}
            <TeamInviteActions invite={invite} onCopy={copyText} onPasteInvitation={(raw) => openInvitation(raw)} />
          </>
        ) : (
          (projectSelect ?? undefined)
        )
      }
      onClose={closeTeamwork}
      focusKey={projectId}
    >
      {home ? (
        <>
          {/* First while a step is left to do: that step is the thing to do. */}
          {toDo ? setup : null}
          <TeamHome projectId={projectId} />
          {toDo ? null : setup}
        </>
      ) : (
        <>
          <SharedNotesList projectId={projectId} />
          {steps}
        </>
      )}
    </PageFrame>
  )
}
