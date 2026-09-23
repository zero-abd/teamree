// The right-hand side: the panes of the worktree that is open, under the strip
// that lists them — and, beside them, whatever teammates' panes this window has
// open.
//
// Nothing else. There used to be a header row between the strip and the panes
// — the worktree's name, a way to its directory, two counts — and every one of
// those is said somewhere already: the sidebar's selected row and the status
// bar name the worktree, the row's menu reveals the checkout, and the status
// bar's git line carries the counts and opens the changes panel. A row that
// repeats three other surfaces is a row of nothing.
//
// The teammates' panes are held out here rather than inside the worktree's own
// tree for one reason, and it is about their lifetime rather than about the
// layout. Every navigation in this area replaces what is under it: the pane
// board takes the whole area, so does teamwork's setup, and opening another
// worktree mounts a different tree. A watched pane put inside any of those
// would unmount on the next click, and unmounting closes the subscription and
// reopens it when you come back — the relay's budget paid twice over for a pane
// nobody stopped watching. So the area is a split: the workspace on one side, a
// teammate's pane on the other, and the gutter between them is the same gutter
// that sits between two of your own.

import { useCallback, useMemo } from 'react'
import { teamworkFacts } from '@shared/entities'
import { Dashboard } from '../dashboard/Dashboard'
import { HelpView } from '../help/HelpView'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { shortcutHint } from '../keyboard/workspaceShortcuts'
import { shownRoot } from '../panes/paneLayout'
import { PaneTree } from '../panes/PaneTree'
import { SplitFrame } from '../panes/SplitFrame'
import { SettingsView } from '../settings/SettingsView'
import { TEAMWORK_BUTTON_LABEL } from '../sidebar/teamworkSummary'
import { TeamworkView } from '../teamwork/TeamworkView'
import { WatchedPaneView } from '../terminal/WatchedPaneView'
import { ChangesPanel } from './ChangesPanel'
import { useMarkPanesSeen } from '../state/usePaneSeen'
import { useWorkspaceStore } from '../state/workspaceStore'
import { terminalTarget } from './terminalTarget'
import { TerminalTabs } from './TerminalTabs'

export function WorkspaceArea({
  modifier,
  isAppChord
}: {
  modifier: PlatformModifier
  isAppChord: (event: KeyboardEvent) => boolean
}): React.JSX.Element {
  const watches = useWorkspaceStore((state) => state.watches)
  const watchSizes = useWorkspaceStore((state) => state.watchSizes)
  const setWatchSizes = useWorkspaceStore((state) => state.setWatchSizes)
  const focusedWatchId = useWorkspaceStore((state) => state.focusedWatchId)
  const focusPane = useWorkspaceStore((state) => state.focusPane)
  const closeWatchedPane = useWorkspaceStore((state) => state.closeWatchedPane)
  const noteWatchedPaneOutput = useWorkspaceStore((state) => state.noteWatchedPaneOutput)
  const closeHint = shortcutHint('close-pane', modifier)

  // Here rather than inside `WorkspaceMain`, because this component is the one
  // that is always mounted: the surfaces below it replace each other, and the
  // moment the panes stop being on screen is exactly the moment the pane that
  // was focused has to be written down as read.
  useMarkPanesSeen()

  // Keyed by the pane rather than by position, so closing the first of three
  // does not remount — and so re-open — the two beside it.
  const cells = [
    { key: 'workspace', node: <WorkspaceMain modifier={modifier} isAppChord={isAppChord} /> },
    ...watches.map((watch) => ({
      key: watch.id,
      node: (
        <WatchedPaneView
          projectId={watch.projectId}
          paneId={watch.paneId}
          label={watch.label}
          handle={watch.handle}
          focused={focusedWatchId === watch.id}
          onFocus={() => focusPane(watch.id)}
          isAppChord={isAppChord}
          closeHint={closeHint}
          onOutput={(data) => noteWatchedPaneOutput(watch.id, data)}
          onClose={() => closeWatchedPane(watch.id)}
        />
      )
    }))
  ]

  // A split of one when nobody is being watched, which renders as the workspace
  // filling the area and no gutter at all. Rendered unconditionally all the
  // same: a wrapper that appeared the moment a watch opened would remount the
  // workspace under it, and with it every terminal in the open worktree.
  return (
    <SplitFrame className="workspace-split" direction="row" sizes={watchSizes} onResize={setWatchSizes} cells={cells} />
  )
}

/**
 * The strip, then whatever the area is showing under it.
 *
 * The strip is outside the view rather than inside the open-worktree branch of
 * it, because it is the window's top edge on this side and has to be there
 * whatever is under it: the empty states, the pane board, settings and help are
 * all drawn under the same row the window is dragged by and — with the sidebar
 * away — the macOS window buttons sit on. `TerminalTabs` decides what to list.
 */
function WorkspaceMain({
  modifier,
  isAppChord
}: {
  modifier: PlatformModifier
  isAppChord: (event: KeyboardEvent) => boolean
}): React.JSX.Element {
  return (
    <div className="workspace-column">
      <TerminalTabs modifier={modifier} />
      <WorkspaceView modifier={modifier} isAppChord={isAppChord} />
    </div>
  )
}

function WorkspaceView({
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
  // The pane filling the workspace on its own, if one is. It is not in the
  // layout and never goes to the runtime: maximising is a way of looking at an
  // arrangement rather than one, and `shownRoot` is the whole of applying it.
  const expandedTerminalId = useWorkspaceStore((state) => state.expandedTerminalId)
  // A teammate's pane holding the focus is what takes it off yours. Two panes
  // wearing the focused border would be two answers to where the next keystroke
  // goes, and the border is the only place the window says it.
  const focusedWatchId = useWorkspaceStore((state) => state.focusedWatchId)
  const focusPane = useWorkspaceStore((state) => state.focusPane)
  const closeTerminal = useWorkspaceStore((state) => state.closeTerminal)
  const relaunchTerminal = useWorkspaceStore((state) => state.relaunchTerminal)
  const createTerminal = useWorkspaceStore((state) => state.createTerminal)
  const applySplitSizes = useWorkspaceStore((state) => state.applySplitSizes)
  const agents = useWorkspaceStore((state) => state.agents)
  const startAgent = useWorkspaceStore((state) => state.startAgent)
  const paneSearch = useWorkspaceStore((state) => state.paneSearch)
  const closePaneSearch = useWorkspaceStore((state) => state.closePaneSearch)
  const dashboardOpen = useWorkspaceStore((state) => state.dashboardOpen)
  const projects = useWorkspaceStore((state) => state.projects)
  const connection = useWorkspaceStore((state) => state.connection)
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const openWorktreeIds = useWorkspaceStore((state) => state.openWorktreeIds)
  const openWorktree = useWorkspaceStore((state) => state.openWorktree)
  const teamworkProjectId = useWorkspaceStore((state) => state.teamworkProjectId)
  const settingsOpen = useWorkspaceStore((state) => state.settingsOpen)
  const helpOpen = useWorkspaceStore((state) => state.helpOpen)
  const toggleHelp = useWorkspaceStore((state) => state.toggleHelp)
  const toggleSettings = useWorkspaceStore((state) => state.toggleSettings)
  const openTeamwork = useWorkspaceStore((state) => state.openTeamwork)
  const teamwork = useWorkspaceStore((state) => state.teamwork)

  // Where "open a terminal" would go, and whose teamwork "start teamwork"
  // would set up. Both are read before the early returns below, because hooks
  // are, and both are null only in states this component then does not offer.
  const target = useMemo(() => terminalTarget(worktrees, openWorktreeIds), [worktrees, openWorktreeIds])
  // The tree as it is drawn: one leaf while a pane is maximised, otherwise the
  // whole of it. Read here with the other hooks rather than beside the JSX,
  // which is where the early returns below put it out of reach.
  const paneRoot = useMemo(
    () => shownRoot(layout?.root ?? null, expandedTerminalId),
    [layout?.root, expandedTerminalId]
  )
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
   * teammate. An absent status is not an answer, so it keeps the old copy — and
   * neither is one teamwork has not read yet, which `teamworkFacts` folds into
   * the same absence for the same reason.
   */
  const teamworkFound = teamworkProject === undefined ? undefined : teamworkFacts(teamwork[teamworkProject.id])
  const teamworkRunning = teamworkFound?.disabledReason === null && teamworkFound.enrolled

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
  const onRelaunch = useCallback((terminalId: string) => void relaunchTerminal(terminalId), [relaunchTerminal])

  // Before the empty state, not after it: which pane needs you is a question
  // about every worktree, and it is worth asking with none of them open.
  if (dashboardOpen) return <Dashboard modifier={modifier} />

  // Same reasoning, and the reason this stopped being a modal: setting teamwork
  // up is a question about a repository, not about the worktree that happens to
  // be open, so it takes the area rather than floating over it.
  if (teamworkProjectId !== null) return <TeamworkView projectId={teamworkProjectId} />

  // And the same for both of these. Settings is read against the machine — what
  // is on its PATH, what its panes look like, where its checkouts are — and
  // help is read while doing the thing it describes, which is the one case a
  // modal is worst at: a scrim over the app is a scrim over the very panes the
  // reader is trying to apply the sentence to. Ahead of the empty state,
  // because a window with nothing open is exactly where somebody goes looking
  // for either of them.
  if (settingsOpen) return <SettingsView modifier={modifier} />
  if (helpOpen) return <HelpView modifier={modifier} />

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
            <p className="placeholder__body">Quit and reopen teamree.</p>
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
                  ? 'No worktree yet — this asks for the task and makes one.'
                  : `${target.name}, on ${target.branch}.`}
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
                  ? 'No repository here yet.'
                  : teamworkRunning
                    ? `Already on in ${teamworkProject.name}.`
                    : `Not set up in ${teamworkProject.name}.`}
              </p>
            </div>
          </div>

          <dl className="legend">
            <div>
              <dt>{shortcutHint('new-worktree', modifier)}</dt>
              <dd>new worktree</dd>
            </div>
            <div>
              <dt>{shortcutHint('previous-worktree', modifier)}</dt>
              <dd>previous worktree</dd>
            </div>
            <div>
              <dt>{shortcutHint('next-worktree', modifier)}</dt>
              <dd>next worktree</dd>
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
              <dt>{shortcutHint('focus-previous-pane', modifier)}</dt>
              <dd>previous pane</dd>
            </div>
            <div>
              <dt>{shortcutHint('focus-next-pane', modifier)}</dt>
              <dd>next pane</dd>
            </div>
            <div>
              <dt>{shortcutHint('expand-pane', modifier)}</dt>
              <dd>maximise pane</dd>
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
            <div>
              <dt>{shortcutHint('open-help', modifier)}</dt>
              <dd>how this works</dd>
            </div>
          </dl>

          {/* The legend above is a dozen chords offered to somebody who may not
              yet know what a worktree is, which is the question underneath all
              of them. These two lines are the way out of that: one goes to the
              page that answers it — and lists every chord, generated from the
              same table the legend reads — and the other to the page that
              settles what this machine is configured to do. Text rather than
              buttons, because they are not what this state is for. */}
          <div className="placeholder__actions">
            <button type="button" className="button button--ghost button--small" onClick={toggleHelp}>
              How this works
            </button>
            <button type="button" className="button button--ghost button--small" onClick={toggleSettings}>
              Settings
            </button>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className="workspace">
      <div className="workspace__body">
        <div className="workspace__panes">
          {paneRoot ? (
            <PaneTree
              key={activeWorktreeId}
              node={paneRoot}
              path={[]}
              terminals={terminals}
              focusedTerminalId={focusedWatchId === null ? (layout?.focusedTerminalId ?? null) : null}
              onFocus={focusPane}
              onClose={onClose}
              onRelaunch={onRelaunch}
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
