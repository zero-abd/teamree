// A short rail of places to go, then projects and their worktrees with each
// worktree's panes underneath. The rail's search is a button wearing a field's
// clothes: it opens the palette rather than being a second, weaker search.

import { useEffect, useMemo, useRef } from 'react'
import { hasCheckout, teammatesHeard, type Worktree } from '@shared/entities'
import { cliActionLabel, cliTitle, offerCliInstall } from '../dialogs/cliInstallModel'
import { attentionByPane } from '../state/paneAttention'
import { useNow } from '../state/useNow'
import { useUnreadPanes } from '../state/usePaneSeen'
import { useWorkspaceStore } from '../state/workspaceStore'
import { evidenceLine } from '@shared/outputEvidence'
import { Brand, SidebarGlyph } from '../shell/Brand'
import { AddProjectButton } from './AddProjectButton'
import { compareTitle, runName, siblingRuns } from '../compare/siblingRuns'
import { useOpenIn } from './openIn'
import { ProjectHead } from './ProjectHead'
import { TeammateWorktreeRow } from './TeammateWorktreeRow'
import { teammateRows, unheardTeammates, unheardTitle } from './teammateRows'
import { teamworkControlLabel, teamworkOn, teamworkSummary } from './teamworkSummary'
import { usePaneEvidence } from './usePaneEvidence'
import { useTreeKeys } from './treeKeys'
import { worktreesByProject } from './worktreeOrder'
import { WorktreeRow, type TaskFold } from './WorktreeRow'
import { agentRows, worktreeTone, type DotTone } from './agentRows'
import { flattenTask, taskForest, taskTally, treeTone, type TaskNode } from './taskTree'
import { isDoneStage, taskStages } from '../dashboard/taskRows'
import { useTaskTreeStore } from '../state/taskTreeStore'
import { agentWords, worktreeDisplay, worktreeLabel } from './worktreeDisplay'

export function Sidebar({
  searchHint
}: {
  /** The one chord drawn in the rail; the rows carry none, the menu bar and help page name theirs. */
  searchHint: string
}): React.JSX.Element {
  const projects = useWorkspaceStore((state) => state.projects)
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const statuses = useWorkspaceStore((state) => state.statuses)
  const mergePreviews = useWorkspaceStore((state) => state.mergePreviews)
  const landings = useWorkspaceStore((state) => state.landings)
  const terminals = useWorkspaceStore((state) => state.terminals)
  const revealPane = useWorkspaceStore((state) => state.revealPane)
  const paneList = useMemo(() => Object.values(terminals), [terminals])
  const now = useNow()
  const collapsed = useWorkspaceStore((state) => state.collapsedProjects)
  const activeWorktreeId = useWorkspaceStore((state) => state.activeWorktreeId)
  const toggleProject = useWorkspaceStore((state) => state.toggleProject)
  const openWorktree = useWorkspaceStore((state) => state.openWorktree)
  const retryWorktree = useWorkspaceStore((state) => state.retryWorktree)
  const removeWorktree = useWorkspaceStore((state) => state.removeWorktree)
  const removeFromTeamree = useWorkspaceStore((state) => state.removeFromTeamree)
  const trashProject = useWorkspaceStore((state) => state.trashProject)
  const renameWorktree = useWorkspaceStore((state) => state.renameWorktree)
  const editingWorktreeName = useWorkspaceStore((state) => state.editingWorktreeName)
  const editWorktreeName = useWorkspaceStore((state) => state.editWorktreeName)
  const revealInFinder = useWorkspaceStore((state) => state.revealInFinder)
  const copyToClipboard = useWorkspaceStore((state) => state.copyToClipboard)
  const openIn = useOpenIn()
  const openCompare = useWorkspaceStore((state) => state.openCompare)
  const loadEditors = useWorkspaceStore((state) => state.loadEditors)
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  const teamwork = useWorkspaceStore((state) => state.teamwork)
  const teammates = useWorkspaceStore((state) => state.teammates)
  const cli = useWorkspaceStore((state) => state.cli)
  const dashboardOpen = useWorkspaceStore((state) => state.dashboardOpen)
  const settingsOpen = useWorkspaceStore((state) => state.settingsOpen)
  const helpOpen = useWorkspaceStore((state) => state.helpOpen)
  const toggleSettings = useWorkspaceStore((state) => state.toggleSettings)
  const appearanceOpen = useWorkspaceStore((state) => state.appearanceOpen)
  const showAppearance = useWorkspaceStore((state) => state.showAppearance)
  const toggleHelp = useWorkspaceStore((state) => state.toggleHelp)
  const toggleDashboard = useWorkspaceStore((state) => state.toggleDashboard)
  const teamworkProjectId = useWorkspaceStore((state) => state.teamworkProjectId)
  const openTeamwork = useWorkspaceStore((state) => state.openTeamwork)
  const closeTeamwork = useWorkspaceStore((state) => state.closeTeamwork)
  const toggleSidebar = useWorkspaceStore((state) => state.toggleSidebar)
  const agents = useWorkspaceStore((state) => state.agents)
  const restoring = useWorkspaceStore((state) => state.restoring)
  const kindOf = useMemo(() => agentWords(agents), [agents])
  const collapsedTasks = useTaskTreeStore((state) => state.collapsedTasks)
  const setTaskCollapsed = useTaskTreeStore((state) => state.setTaskCollapsed)
  const stages = useMemo(
    () => taskStages({ worktrees, terminals: paneList, statuses, mergePreviews, landings, now }),
    [worktrees, paneList, statuses, mergePreviews, landings, now]
  )
  const tones = useMemo(() => {
    const byId: Record<string, DotTone | null> = {}
    for (const worktree of worktrees) {
      byId[worktree.id] = hasCheckout(worktree) ? worktreeTone(agentRows(paneList, worktree.id, now)) : null
    }
    return byId
  }, [worktrees, paneList, now])
  const titleOf = (worktreeId: string): string => {
    const worktree = worktrees.find((entry) => entry.id === worktreeId)
    return worktree === undefined ? '' : worktreeDisplay(worktree, kindOf).title
  }
  const tree = useRef<HTMLDivElement | null>(null)
  const treeKeys = useTreeKeys(tree)

  // Which editors are on this machine, asked once from the one thing always
  // mounted while a row exists.
  useEffect(() => {
    void loadEditors()
  }, [loadEditors])

  // No box sets this; kept as the one place the empty-state wording asks
  // "is this filtered or simply empty".
  const filter = ''

  const matching = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return worktrees
    return worktrees.filter(
      (worktree) => worktree.name.toLowerCase().includes(needle) || worktree.branch.toLowerCase().includes(needle)
    )
  }, [filter, worktrees])

  // Only the panes of worktrees actually rendered are read; a collapsed project costs nothing.
  const onScreen = useMemo(() => {
    const shown = new Set(matching.filter((worktree) => !collapsed[worktree.projectId]).map((worktree) => worktree.id))
    return paneList.filter((terminal) => shown.has(terminal.worktreeId))
  }, [collapsed, matching, paneList])

  const evidence = usePaneEvidence(onScreen, terminals)
  // Asked once for the whole sidebar: a question about the window, not a row.
  const unread = useUnreadPanes()
  const watching = useWorkspaceStore((state) => state.watchers)

  // The panes themselves are in the workspace; the sidebar only says which
  // rows are watched and quotes what they have printed.
  const watches = useWorkspaceStore((state) => state.watches)
  const watchTails = useWorkspaceStore((state) => state.watchTails)
  const toggleWatchedPane = useWorkspaceStore((state) => state.toggleWatchedPane)

  // Only an open pane has a line to quote, because only an open pane streams.
  const watchEvidence = useMemo(() => {
    const lines: Record<string, string | null> = {}
    for (const watch of watches) lines[watch.paneId] = evidenceLine(watchTails[watch.id] ?? '')
    return lines
  }, [watches, watchTails])

  // Teamwork is per repository, so the app-level entry picks the one whose
  // worktree is open, else the first. Undefined only before any has been added.
  const active = worktrees.find((entry) => entry.id === activeWorktreeId)
  const railProject = projects.find((project) => project.id === active?.projectId) ?? projects[0]
  const pageOpen = dashboardOpen || settingsOpen || helpOpen || teamworkProjectId !== null

  return (
    <div className={pageOpen ? 'sidebar sidebar--page' : 'sidebar'} data-region="sidebar">
      {/* The top edge of the window, on this side of the seam: the lockup, and
          the one control that puts the sidebar away. On macOS the window
          buttons sit on this row too, and it is what the window is dragged by
          — the stylesheet makes it a drag region and exempts the button. The
          same command is a row in the palette and the menu bar, which is where
          its chord is taught; the way back is the strip's left end. */}
      <header className="sidebar__brand">
        <Brand />
        <button
          type="button"
          className="shell__toggle"
          title="Hide sidebar"
          aria-label="Hide sidebar"
          onClick={toggleSidebar}
        >
          <SidebarGlyph />
        </button>
      </header>

      <nav className="rail" aria-label="Go to">
        {/* A button, not an input: it opens the palette, which is the search
            this app actually has. Dressing it as a field is about where the eye
            goes, and the chord beside it says what it really is. */}
        <button
          type="button"
          className="rail__search"
          aria-label="Search worktrees and commands"
          onClick={() => openDialog({ kind: 'palette' })}
        >
          <svg className="rail__icon" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="6.2" cy="6.2" r="3.7" />
            <path d="M9 9 L11.5 11.5" />
          </svg>
          <span className="rail__search-text">Search</span>
          <kbd>{searchHint}</kbd>
        </button>

        <ul className="rail__list">
          <li>
            <button
              type="button"
              className={`rail__link${teamworkProjectId !== null ? ' rail__link--current' : ''}`}
              aria-current={teamworkProjectId !== null ? 'page' : undefined}
              disabled={railProject === undefined}
              title={railProject === undefined ? 'No projects yet' : `Teamwork in ${railProject.name}`}
              onClick={() => {
                if (teamworkProjectId !== null) closeTeamwork()
                else if (railProject) openTeamwork(railProject.id)
              }}
            >
              <svg className="rail__icon" viewBox="0 0 14 14" aria-hidden="true">
                <circle cx="5" cy="4.6" r="2.1" />
                <circle cx="10.2" cy="5.4" r="1.6" />
                <path d="M1.6 11.4c0-2 1.5-3.2 3.4-3.2s3.4 1.2 3.4 3.2" />
                <path d="M9.3 8.4c1.7 0 3.1 1 3.1 2.6" />
              </svg>
              <span>Teamwork</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              className={`rail__link${dashboardOpen ? ' rail__link--current' : ''}`}
              aria-current={dashboardOpen ? 'page' : undefined}
              title="All Panes, by what needs you"
              onClick={toggleDashboard}
            >
              <svg className="rail__icon" viewBox="0 0 14 14" aria-hidden="true">
                <rect x="2" y="2" width="4.2" height="4.2" rx="1" />
                <rect x="7.8" y="2" width="4.2" height="4.2" rx="1" />
                <rect x="2" y="7.8" width="4.2" height="4.2" rx="1" />
                <rect x="7.8" y="7.8" width="4.2" height="4.2" rx="1" />
              </svg>
              <span>All Panes</span>
            </button>
          </li>
          <li>
            {/* The theme sheet, beside the panes it colours; also in the View menu and the palette. */}
            <button
              type="button"
              className={`rail__link${appearanceOpen ? ' rail__link--current' : ''}`}
              aria-pressed={appearanceOpen}
              title="Themes and colours"
              onClick={() => showAppearance(!appearanceOpen)}
            >
              <svg className="rail__icon" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M7 1.6a5.4 5.4 0 1 0 0 10.8c.9 0 1.3-.6 1.3-1.2 0-.8-.7-1.1-.7-1.8 0-.5.4-.9 1-.9h1.1a2.7 2.7 0 0 0 2.7-2.8c0-2.6-2.4-4.1-5.4-4.1Z" />
                <circle cx="4.5" cy="6" r="0.9" />
                <circle cx="7" cy="4.2" r="0.9" />
                <circle cx="9.6" cy="6" r="0.9" />
              </svg>
              <span>Appearance</span>
            </button>
          </li>
          <li>
            {/* Last two in the rail, and last on purpose: they are the entries
                somebody goes looking for rather than the ones they work in. */}
            <button
              type="button"
              className={`rail__link${settingsOpen ? ' rail__link--current' : ''}`}
              aria-current={settingsOpen ? 'page' : undefined}
              title="Settings"
              onClick={toggleSettings}
            >
              <svg className="rail__icon" viewBox="0 0 14 14" aria-hidden="true">
                <circle cx="7" cy="7" r="2.1" />
                <path d="M7 1.5v1.7M7 10.8v1.7M12.1 7h-1.7M3.6 7H1.9M10.6 3.4 9.4 4.6M4.6 9.4l-1.2 1.2M10.6 10.6 9.4 9.4M4.6 4.6 3.4 3.4" />
              </svg>
              <span>Settings</span>
              {/* The CLI link is wrong and Settings › CLI fixes it. In ink: colour is for agents' state. */}
              {offerCliInstall(cli) ? (
                <span className="rail__badge" role="img" aria-label={cliActionLabel(cli)} title={cliTitle(cli)}>
                  !
                </span>
              ) : null}
            </button>
          </li>
          <li>
            <button
              type="button"
              className={`rail__link${helpOpen ? ' rail__link--current' : ''}`}
              aria-current={helpOpen ? 'page' : undefined}
              title="Shortcuts"
              onClick={toggleHelp}
            >
              <svg className="rail__icon" viewBox="0 0 14 14" aria-hidden="true">
                <circle cx="7" cy="7" r="5.4" />
                <path d="M5.4 5.5a1.7 1.7 0 1 1 2.2 1.7c-.4.2-.6.5-.6.9v.4" />
                <circle cx="7" cy="10.2" r="0.7" />
              </svg>
              <span>Help</span>
            </button>
          </li>
        </ul>
      </nav>

      <nav className="sidebar__projects" aria-label="Projects and worktrees">
        <div className="sidebar__head">
          <h2 className="sidebar__head-title">Projects</h2>
          <AddProjectButton />
        </div>

        {/* One Tab stop; the arrows walk the rows. The other controls in it are the mouse's, each
            reachable by key elsewhere: the row menu, ⌘N, the rail. */}
        <div
          className="sidebar__scroll"
          role="tree"
          aria-label="Worktrees"
          ref={tree}
          onKeyDown={treeKeys.onKeyDown}
          onFocus={treeKeys.onFocus}
        >
          {/* The instruction that used to follow this — "Add a repository." —
              named the button directly above it, which is the plus in this
              section's own header, labelled "Add project". */}
          {projects.length === 0 && !restoring ? <p className="sidebar__empty">No projects yet</p> : null}

          {/* Grouped by the same function the next-worktree chord walks, so
              the chord moves down this list rather than through whatever order
              the runtime answered in. See `worktreeOrder.ts`. */}
          {worktreesByProject(projects, matching).map(({ project, rows }) => {
            const isCollapsed = Boolean(collapsed[project.id])
            const summary = teamworkSummary(teamwork[project.id], now)
            // Under the same project: the same repository, checked out elsewhere.
            const theirs = teammateRows(teammatesHeard(teammates[project.id])?.worktrees ?? [], now, watchEvidence)
            const reading = attentionByPane(watching[project.id])
            // Roster teammates never heard from: not away, and not without worktrees.
            const unheard = unheardTeammates(teammates[project.id])
            const drawRow = (node: TaskNode<Worktree>, depth: number): React.JSX.Element => {
              const { worktree } = node
              const display = worktreeDisplay(worktree, kindOf)
              const label = worktreeLabel(display)
              const siblings = siblingRuns(worktree, worktrees)
              const kind = display.agent?.kind
              const twinRun =
                kind !== undefined && siblings.some((other) => worktreeDisplay(other, kindOf).agent?.kind === kind)
              return (
                <WorktreeRow
                  key={worktree.id}
                  worktree={worktree}
                  display={display}
                  depth={depth}
                  {...(node.children.length === 0 ? {} : { task: taskFold(node) })}
                  onNewChild={() => openDialog({ kind: 'new-task', projectId: project.id, parentId: worktree.id })}
                  status={statuses[worktree.id]}
                  mergePreview={mergePreviews[worktree.id]}
                  {...(landings[worktree.id] === undefined ? {} : { landing: landings[worktree.id] })}
                  terminals={paneList}
                  evidence={evidence}
                  watchers={reading}
                  unread={unread}
                  now={now}
                  onFocusTerminal={(terminalId) => revealPane(worktree.id, terminalId)}
                  active={worktree.id === activeWorktreeId}
                  onOpen={() => void openWorktree(worktree.id)}
                  onRetry={() => retryWorktree(worktree.id)}
                  onRemove={() => void removeWorktree(worktree.id)}
                  onForget={() => void removeFromTeamree({ worktreeId: worktree.id })}
                  onRename={(name) => void renameWorktree(worktree.id, name)}
                  renameAsked={editingWorktreeName === worktree.id}
                  onRenameShown={() => editWorktreeName(null)}
                  onReveal={() => void revealInFinder(worktree.path, `the ${label} checkout`)}
                  onCopyPath={() => void copyToClipboard(worktree.path, `the path to ${label}`)}
                  onCopyBranch={() => void copyToClipboard(worktree.branch, `the branch ${worktree.branch}`)}
                  openIn={openIn(project.id, worktree.path, `the ${label} checkout`, false)}
                  twinRun={twinRun}
                  {...(siblings.length === 0
                    ? {}
                    : { onKeep: () => openDialog({ kind: 'confirm-keep', worktreeId: worktree.id }) })}
                  compareWith={siblings.map((other) => ({
                    label: runName(other, kindOf),
                    onChoose: () => void openCompare(worktree.id, other.id, compareTitle(worktree, other, kindOf))
                  }))}
                />
              )
            }
            const taskFold = (node: TaskNode<Worktree>): TaskFold => {
              const rolled = treeTone(node, (id) => tones[id] ?? null)
              const from =
                rolled === null ? undefined : node.worktree.id === rolled.from ? undefined : titleOf(rolled.from)
              return {
                collapsed: collapsedTasks[node.worktree.id] === true,
                onCollapse: (collapsed) => setTaskCollapsed(node.worktree.id, collapsed),
                rolled: rolled === null ? null : { tone: rolled.tone, ...(from === undefined ? {} : { from }) },
                tally: taskTally(node, (child) => isDoneStage(stages[child.id] ?? 'stopped')),
                children: node.children.map(
                  (child) => `${titleOf(child.worktree.id)} · ${stages[child.worktree.id] ?? 'stopped'}`
                )
              }
            }
            return (
              <section className="project" key={project.id} data-project-id={project.id}>
                <ProjectHead
                  project={project}
                  collapsed={isCollapsed}
                  count={rows.length}
                  theirs={theirs.length}
                  onToggle={() => toggleProject(project.id)}
                  onNewTask={() => openDialog({ kind: 'new-task', projectId: project.id })}
                  onOpenBranch={(pullRequests) =>
                    openDialog({
                      kind: 'open-branch',
                      projectId: project.id,
                      ...(pullRequests ? { pullRequests } : {})
                    })
                  }
                  onForget={() => void removeFromTeamree({ projectId: project.id })}
                  onTrash={() => void trashProject(project.id)}
                />
                <div className="project__meta">
                  <p className="project__base">{project.baseRef}</p>
                  {/* Only where teamwork is on; the rail reaches the setup either way. Named with the
                      project, because the rail has a Teamwork entry too. */}
                  {teamworkOn(teamwork[project.id]) ? (
                    <button
                      type="button"
                      className={`project__teamwork${summary ? ` project__teamwork--${summary.tone}` : ''}`}
                      tabIndex={-1}
                      aria-label={`${teamworkControlLabel(summary)} in ${project.name}`}
                      title={summary ? summary.detail : `Teamwork in ${project.name}`}
                      onClick={() => openTeamwork(project.id)}
                    >
                      {teamworkControlLabel(summary)}
                    </button>
                  ) : null}
                </div>

                {isCollapsed ? null : (
                  <ul className="project__worktrees" role="group">
                    {taskForest(rows).map((node) => {
                      if (node.children.length === 0) return drawRow(node, 0)
                      // A task and its child tasks share one box.
                      return (
                        <li className="task" role="none" key={`task-${node.worktree.id}`}>
                          <ul className="task__rows" role="none">
                            {flattenTask(node, collapsedTasks).map((entry) => drawRow(entry.node, entry.depth))}
                          </ul>
                        </li>
                      )
                    })}
                    {theirs.map((row) => (
                      <TeammateWorktreeRow
                        key={row.id}
                        row={row}
                        watchingPaneIds={watchingIn(watches, project.id)}
                        onWatch={(pane) => toggleWatchedPane(project.id, pane)}
                      />
                    ))}
                    {unheard.length > 0 ? (
                      <li className="project__unheard" role="none" title={unheardTitle(unheard)}>
                        {`Nothing heard yet from ${unheard.join(', ')}`}
                      </li>
                    ) : null}
                    {/* An empty project says nothing: its row's New Task button is the way in. */}
                    {rows.length === 0 && theirs.length === 0 && filter.trim().length > 0 ? (
                      <li className="project__none" role="none">
                        No matches
                      </li>
                    ) : null}
                  </ul>
                )}
              </section>
            )
          })}
        </div>
      </nav>
    </div>
  )
}

/** The panes of one project this window has open, for the rows to mark. */
function watchingIn(watches: readonly { projectId: string; paneId: string }[], projectId: string): string[] {
  return watches.filter((watch) => watch.projectId === projectId).map((watch) => watch.paneId)
}
