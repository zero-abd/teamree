// The right-hand side: which worktree is open, what it is doing, and its panes.

import { useCallback, useMemo } from 'react'
import { Dashboard } from '../dashboard/Dashboard'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { shortcutHint } from '../keyboard/workspaceShortcuts'
import { PaneTree } from '../panes/PaneTree'
import { TEAMWORK_BUTTON_LABEL } from '../sidebar/teamworkSummary'
import { TeamworkView } from '../teamwork/TeamworkView'
import { WatchedPaneView } from '../terminal/WatchedPaneView'
import { ChangesPanel } from './ChangesPanel'
import { useWorkspaceStore } from '../state/workspaceStore'
import { terminalTarget } from './terminalTarget'
import { WorktreeTabs } from './WorktreeTabs'

export function WorkspaceArea({
  modifier,
  isAppChord
}: {
  modifier: PlatformModifier
  isAppChord: (event: KeyboardEvent) => boolean
}): React.JSX.Element {
  const activeWorktreeId = useWorkspaceStore((state) => state.activeWorktreeId)
  const worktree = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === state.activeWorktreeId))
  const layout = useWorkspaceStore((state) =>
    state.activeWorktreeId ? state.layouts[state.activeWorktreeId] : undefined
  )
  const terminals = useWorkspaceStore((state) => state.terminals)
  const focusPane = useWorkspaceStore((state) => state.focusPane)
  const closeTerminal = useWorkspaceStore((state) => state.closeTerminal)
  const createTerminal = useWorkspaceStore((state) => state.createTerminal)
  const splitFocusedPane = useWorkspaceStore((state) => state.splitFocusedPane)
  const applySplitSizes = useWorkspaceStore((state) => state.applySplitSizes)
  const changesOpen = useWorkspaceStore((state) => state.changesOpen)
  const toggleChanges = useWorkspaceStore((state) => state.toggleChanges)
  const status = useWorkspaceStore((state) =>
    state.activeWorktreeId ? state.statuses[state.activeWorktreeId] : undefined
  )
  const pushing = useWorkspaceStore((state) => state.pushing)
  const agents = useWorkspaceStore((state) => state.agents)
  const startAgent = useWorkspaceStore((state) => state.startAgent)
  const pushActiveWorktree = useWorkspaceStore((state) => state.pushActiveWorktree)
  const paneSearch = useWorkspaceStore((state) => state.paneSearch)
  const closePaneSearch = useWorkspaceStore((state) => state.closePaneSearch)
  const dashboardOpen = useWorkspaceStore((state) => state.dashboardOpen)
  const toggleDashboard = useWorkspaceStore((state) => state.toggleDashboard)
  const projects = useWorkspaceStore((state) => state.projects)
  const connection = useWorkspaceStore((state) => state.connection)
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const openWorktreeIds = useWorkspaceStore((state) => state.openWorktreeIds)
  const openWorktree = useWorkspaceStore((state) => state.openWorktree)
  const teamworkProjectId = useWorkspaceStore((state) => state.teamworkProjectId)
  const openTeamwork = useWorkspaceStore((state) => state.openTeamwork)
  const teamwork = useWorkspaceStore((state) => state.teamwork)
  const watchedPane = useWorkspaceStore((state) => state.watchedPane)
  const closeWatchedPane = useWorkspaceStore((state) => state.closeWatchedPane)
  const appendWatchedPaneOutput = useWorkspaceStore((state) => state.appendWatchedPaneOutput)

  // Where "open a terminal" would go, and whose teamwork "start teamwork"
  // would set up. Both are read before the early returns below, because hooks
  // are, and both are null only in states this component then does not offer.
  const target = useMemo(() => terminalTarget(worktrees, openWorktreeIds), [worktrees, openWorktreeIds])
  const teamworkProject = worktree
    ? projects.find((project) => project.id === worktree.projectId)
    : (projects.find((project) => project.id === target?.projectId) ?? projects[0])

  /**
   * Whether teamwork is already running in the project this card is about.
   *
   * The card below used to say "put your key in <project> and pick a relay"
   * whatever the answer, which is the one sentence that cannot be true here:
   * `disabledReason === null` means the relay is configured and the origin
   * matches, and `enrolled` means this machine's own key is in the checkout —
   * the two things the sentence asks for. Seen on a packaged build whose own
   * project header said "1 connected" in the same window: the app told a
   * connected member to go and do what they had already done, on the empty
   * state they are most likely to be looking at while they wait for a
   * teammate. An absent status is not an answer, so it keeps the old copy.
   */
  const teamworkRunning =
    teamworkProject !== undefined &&
    teamwork[teamworkProject.id]?.disabledReason === null &&
    teamwork[teamworkProject.id]?.enrolled === true

  // Open the tab first and put the pane in it second: the pane is the thing
  // asked for, and it has to appear somewhere the person is looking.
  const startTerminal = useCallback(async () => {
    if (target === null) return
    await openWorktree(target.id)
    await createTerminal(target.id)
  }, [target, openWorktree, createTerminal])

  const onResize = useCallback(
    (path: number[], sizes: number[]) => {
      if (activeWorktreeId) applySplitSizes(activeWorktreeId, path, sizes)
    },
    [activeWorktreeId, applySplitSizes]
  )
  const onClose = useCallback((terminalId: string) => void closeTerminal(terminalId), [closeTerminal])

  // Before the empty state, not after it: which pane needs you is a question
  // about every worktree, and it is worth asking with none of them open.
  if (dashboardOpen) return <Dashboard modifier={modifier} />

  // Same reasoning, and the reason this stopped being a modal: setting teamwork
  // up is a question about a repository, not about the worktree that happens to
  // be open, so it takes the area rather than floating over it.
  if (teamworkProjectId !== null) return <TeamworkView projectId={teamworkProjectId} />

  // And the same again for a teammate's pane, which used to be pinned to the
  // bottom-right corner of the window at a size nothing could change. What
  // makes it unmistakably somebody else's is its header saying so, not its
  // being the smallest thing on the screen — so it gets the room the thing it
  // shows actually needs. `key` on the pane id so switching between two
  // teammates' panes builds a new emulator rather than replaying one stream
  // into the scrollback of another.
  if (watchedPane !== null) {
    return (
      <WatchedPaneView
        key={watchedPane.paneId}
        projectId={watchedPane.projectId}
        paneId={watchedPane.paneId}
        label={watchedPane.label}
        handle={watchedPane.handle}
        onOutput={appendWatchedPaneOutput}
        onClose={closeWatchedPane}
      />
    )
  }

  if (!worktree || !activeWorktreeId) {
    // A runtime that never came up leaves a window that looks ordinary and
    // answers nothing. The status bar says so in three words at the bottom of
    // the screen; this is the surface somebody is actually looking at, and
    // every shortcut the empty state would otherwise offer is inert.
    if (connection.phase === 'offline') {
      return (
        <main className="workspace workspace--empty">
          <div className="placeholder">
            <h1 className="placeholder__title">The runtime is not running</h1>
            <p className="placeholder__body">
              Nothing here will respond until it is back. Quit and reopen teamree to start a new one.
            </p>
            {connection.detail ? <p className="placeholder__body">{connection.detail}</p> : null}
          </div>
        </main>
      )
    }

    // The genuine first run. Every shortcut in the legend below acts on a pane,
    // and the one that makes a worktree needs a project to make it in — with
    // none added it does nothing at all when pressed. Naming a chord here would
    // be telling somebody to press a key that cannot answer, so this state
    // offers the only action that can.
    if (projects.length === 0) {
      return (
        <main className="workspace workspace--empty">
          <div className="placeholder">
            <h1 className="placeholder__title">Add a repository to start</h1>
            <p className="placeholder__body">
              teamree works in git worktrees of a repository you already have: one checkout per task, so several agents
              can work at once without seeing each other&rsquo;s files.
            </p>
            <div className="placeholder__actions">
              <button
                type="button"
                className="button button--primary"
                onClick={() => openDialog({ kind: 'add-project' })}
              >
                Add a repository
              </button>
            </div>
          </div>
        </main>
      )
    }

    // Nothing open, and — until this — nothing offered: a heading, a sentence
    // naming a chord, and a legend of six more. That is a reference card handed
    // to somebody who has not yet done the thing it is a reference for. The two
    // things a person actually opens this app to do are here as buttons; the
    // chords stay, underneath, for the second week rather than the first hour.
    return (
      <main className="workspace workspace--empty">
        <div className="placeholder">
          <h1 className="placeholder__title">Nothing open</h1>
          {/* `target` is null when there is no worktree to pick, and pointing
              somebody at an empty list is the one thing this line must not do. */}
          <p className="placeholder__body">
            {target === null ? 'Nothing to open yet. Start here.' : 'Pick a worktree on the left, or start here.'}
          </p>

          <div className="starters">
            <div className="starter">
              <button
                type="button"
                className="button button--primary button--lead"
                aria-describedby="starter-terminal"
                onClick={() => {
                  if (target === null) {
                    if (teamworkProject) openDialog({ kind: 'new-task', projectId: teamworkProject.id })
                    return
                  }
                  void startTerminal()
                }}
              >
                {target === null ? 'Open a terminal in a new worktree' : 'Open a terminal'}
              </button>
              <p className="starter__note" id="starter-terminal">
                {target === null
                  ? 'There is no worktree to run one in yet, so this asks what the task is and makes one first.'
                  : `A shell in ${target.name}, on ${target.branch}.`}
              </p>
            </div>

            <div className="starter">
              <button
                type="button"
                className="button button--lead"
                aria-describedby="starter-teamwork"
                disabled={teamworkProject === undefined}
                onClick={() => {
                  if (teamworkProject) openTeamwork(teamworkProject.id)
                }}
              >
                {teamworkRunning ? TEAMWORK_BUTTON_LABEL : 'Start teamwork'}
              </button>
              <p className="starter__note" id="starter-teamwork">
                {teamworkProject === undefined
                  ? 'Teamwork is set up per repository, and there is none here yet.'
                  : teamworkRunning
                    ? `Teamwork is already on in ${teamworkProject.name}. Open it to see who is connected, and who may read and type into these panes.`
                    : `Put your key in ${teamworkProject.name} and pick a relay, so a teammate can see these panes and type into them.`}
              </p>
            </div>
          </div>

          <dl className="legend">
            <div>
              <dt>{shortcutHint('new-worktree', modifier)}</dt>
              <dd>new worktree</dd>
            </div>
            <div>
              <dt>{shortcutHint('new-terminal', modifier)}</dt>
              <dd>new terminal</dd>
            </div>
            <div>
              <dt>{shortcutHint('split-right', modifier)}</dt>
              <dd>split right</dd>
            </div>
            <div>
              <dt>{shortcutHint('split-down', modifier)}</dt>
              <dd>split down</dd>
            </div>
            <div>
              <dt>{shortcutHint('close-pane', modifier)}</dt>
              <dd>close pane</dd>
            </div>
            <div>
              <dt>{shortcutHint('focus-next-pane', modifier)}</dt>
              <dd>next pane</dd>
            </div>
            <div>
              <dt>{shortcutHint('open-palette', modifier)}</dt>
              <dd>go to anything</dd>
            </div>
            <div>
              <dt>{shortcutHint('find-in-pane', modifier)}</dt>
              <dd>find in pane</dd>
            </div>
            <div>
              <dt>{shortcutHint('open-dashboard', modifier)}</dt>
              <dd>every pane</dd>
            </div>
          </dl>
        </div>
      </main>
    )
  }

  return (
    <main className="workspace">
      <WorktreeTabs />

      <header className="workspace__head">
        <div className="workspace__identity">
          <h1 className="workspace__title">{worktree.name}</h1>
          <p className="workspace__path">{worktree.path}</p>
        </div>
        {/*
          Fixed buttons only, and deliberately no button per agent. This row is
          for acting on the worktree in front of you, not a launcher for
          whatever binaries happen to be on this machine's PATH: one button per
          discovered agent made the bar grow with somebody's tool collection,
          and put the two things that touch their repository — Changes and Push
          — beside a row of names that varies from laptop to laptop. Starting an
          agent in this worktree lives in the palette, which costs no width
          until it is asked for, and on the empty state of a worktree with no
          panes.
        */}
        <div className="workspace__tools">
          <button
            type="button"
            className="button button--ghost button--small"
            title={`Every pane in every worktree, by what needs you · ${shortcutHint('open-dashboard', modifier)}`}
            onClick={toggleDashboard}
          >
            All panes
          </button>
          <button
            type="button"
            className={`button button--ghost button--small${changesOpen ? ' button--on' : ''}`}
            aria-pressed={changesOpen}
            title={`Show what changed in this worktree · ${shortcutHint('open-palette', modifier)} to jump anywhere`}
            onClick={toggleChanges}
          >
            Changes
            {changedCount(status) > 0 ? <span className="button__count">{changedCount(status)}</span> : null}
          </button>
          <button
            type="button"
            className="button button--ghost button--small"
            disabled={pushing}
            title={
              status === undefined
                ? 'Send this branch to its remote'
                : status.ahead > 0
                  ? `Send ${status.ahead} commit${status.ahead === 1 ? '' : 's'} to the remote. Never forces.`
                  : 'Nothing to send; the remote already has this branch.'
            }
            onClick={() => void pushActiveWorktree()}
          >
            {pushing ? 'Pushing…' : 'Push'}
            {status !== undefined && status.ahead > 0 ? <span className="button__count">{status.ahead}</span> : null}
          </button>
          <button
            type="button"
            className="button button--ghost button--small"
            title={`Split right · ${shortcutHint('split-right', modifier)}`}
            onClick={() => void splitFocusedPane('row')}
          >
            Split right
          </button>
          <button
            type="button"
            className="button button--ghost button--small"
            title={`Split down · ${shortcutHint('split-down', modifier)}`}
            onClick={() => void splitFocusedPane('column')}
          >
            Split down
          </button>
          <button
            type="button"
            className="button button--small"
            title={`New terminal · ${shortcutHint('new-terminal', modifier)}`}
            onClick={() => void createTerminal(activeWorktreeId)}
          >
            New terminal
          </button>
        </div>
      </header>

      <div className="workspace__body">
        <div className="workspace__panes">
          {layout?.root ? (
            <PaneTree
              key={activeWorktreeId}
              node={layout.root}
              path={[]}
              terminals={terminals}
              focusedTerminalId={layout.focusedTerminalId}
              onFocus={focusPane}
              onClose={onClose}
              onResize={onResize}
              isAppChord={isAppChord}
              closeHint={shortcutHint('close-pane', modifier)}
              searchTerminalId={paneSearch?.terminalId ?? null}
              searchToken={paneSearch?.token ?? 0}
              onCloseSearch={closePaneSearch}
            />
          ) : (
            <div className="placeholder placeholder--inset">
              <h2 className="placeholder__title">
                {worktree.state === 'creating' ? 'Preparing the worktree' : 'No terminals here yet'}
              </h2>
              <p className="placeholder__body">
                {worktree.state === 'creating'
                  ? 'Panes appear as soon as the checkout is ready.'
                  : `Start one with ${shortcutHint('new-terminal', modifier)}.`}
              </p>
              {worktree.state === 'ready' ? (
                <div className="placeholder__actions">
                  {agents.map((agent) => (
                    <button
                      type="button"
                      key={agent.kind}
                      className="button button--primary"
                      onClick={() => void startAgent(agent.command)}
                    >
                      Start {agent.command}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={agents.length === 0 ? 'button button--primary' : 'button'}
                    onClick={() => void createTerminal(activeWorktreeId)}
                  >
                    New terminal
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <ChangesPanel />
      </div>
    </main>
  )
}

/**
 * What the button's badge counts: everything a commit would have to deal with.
 * Ahead and behind are about the branch rather than the tree, so they are the
 * status bar's business, not this button's.
 */
export function changedCount(
  status: { staged: number; unstaged: number; untracked: number; conflicted: number } | undefined
): number {
  if (!status) return 0
  return status.staged + status.unstaged + status.untracked + status.conflicted
}
