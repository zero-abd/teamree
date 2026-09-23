// Setting teamwork up, given the whole main area. What the steps say is
// `TeamworkSteps`'s business and what they mean is `startTeamwork.ts`'s; this
// owns the reads, which job this visit is, and the push clock.

import { useCallback, useEffect, useState } from 'react'
import { copyText } from '../clipboard/clipboard'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'
import { TerminalView } from '../terminal/TerminalView'
import { PageFrame } from '../workspace/PageFrame'
import { TeamworkSteps } from './TeamworkSteps'
import type { TeamworkPath } from './startTeamwork'

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
  const [path, setPath] = useState<TeamworkPath | null>(null)

  return (
    <PageFrame label={`Set up teamwork in ${name}`} title="Start teamwork" onClose={closeTeamwork} focusKey={projectId}>
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
        onCancelPublish={() => void cancelPublish(projectId)}
        now={now}
        path={path}
        onChoosePath={setPath}
        projectName={name}
        onCopy={copyText}
      />
    </PageFrame>
  )
}
