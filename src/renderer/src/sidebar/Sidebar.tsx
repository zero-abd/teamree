// A short rail of places to go, and then projects and their worktrees, with
// each worktree's panes and what they are doing underneath them.
//
// The rail exists because everything this app can show you used to be reachable
// only from a chord or from a button buried in a project's header, which is a
// fine arrangement for the person who built it and a dead end for everybody
// else. It holds the two destinations that are about the window rather than
// about one worktree — teamwork and the pane board — above the tree, where an
// app-level thing belongs.
//
// There is still no filter box, and the search entry is not one. A field that
// filters this list permanently occupying the top of the sidebar earns its
// place only in a list too long to look at, and by then the palette is faster:
// it matches names, branches, projects and commands, and it is one chord away
// from anywhere. So the rail's search opens that palette. It is a button
// wearing a field's clothes rather than a box that does a lesser thing, because
// the alternative — a second, weaker search beside the real one — is how an app
// ends up with two answers to "where is it".

import { useMemo } from 'react'
import { teammatesHeard, type PaneWatchers } from '@shared/entities'
import { cliActionLabel, cliTitle, offerCliInstall } from '../dialogs/cliInstallModel'
import type { PaneAttention } from '../state/paneAttention'
import { useNow } from '../state/useNow'
import { useWorkspaceStore } from '../state/workspaceStore'
import { evidenceLine } from './outputEvidence'
import { TeammateWorktreeRow } from './TeammateWorktreeRow'
import { teammateRows, unheardTeammates, unheardTitle } from './teammateRows'
import { teamworkSummary, TEAMWORK_BUTTON_LABEL } from './teamworkSummary'
import { usePaneEvidence } from './usePaneEvidence'
import { WorktreeRow } from './WorktreeRow'

export function Sidebar({
  newWorktreeHint,
  searchHint,
  appearanceHint,
  helpHint
}: {
  newWorktreeHint: string
  searchHint: string
  appearanceHint: string
  helpHint: string
}): React.JSX.Element {
  const projects = useWorkspaceStore((state) => state.projects)
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const statuses = useWorkspaceStore((state) => state.statuses)
  const mergePreviews = useWorkspaceStore((state) => state.mergePreviews)
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
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  const teamwork = useWorkspaceStore((state) => state.teamwork)
  const teammates = useWorkspaceStore((state) => state.teammates)
  const cli = useWorkspaceStore((state) => state.cli)
  const dashboardOpen = useWorkspaceStore((state) => state.dashboardOpen)
  const settingsOpen = useWorkspaceStore((state) => state.settingsOpen)
  const helpOpen = useWorkspaceStore((state) => state.helpOpen)
  const toggleSettings = useWorkspaceStore((state) => state.toggleSettings)
  const toggleHelp = useWorkspaceStore((state) => state.toggleHelp)
  const toggleDashboard = useWorkspaceStore((state) => state.toggleDashboard)
  const teamworkProjectId = useWorkspaceStore((state) => state.teamworkProjectId)
  const openTeamwork = useWorkspaceStore((state) => state.openTeamwork)
  const closeTeamwork = useWorkspaceStore((state) => state.closeTeamwork)

  // No box sets this any more; the palette does the finding. Kept as the one
  // place the empty-state wording asks "is this filtered or simply empty".
  const filter = ''

  const matching = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return worktrees
    return worktrees.filter(
      (worktree) => worktree.name.toLowerCase().includes(needle) || worktree.branch.toLowerCase().includes(needle)
    )
  }, [filter, worktrees])

  // Only the panes of worktrees actually rendered are read: a collapsed project
  // costs nothing, and neither does a row the filter left out.
  const onScreen = useMemo(() => {
    const shown = new Set(matching.filter((worktree) => !collapsed[worktree.projectId]).map((worktree) => worktree.id))
    return paneList.filter((terminal) => shown.has(terminal.worktreeId))
  }, [collapsed, matching, paneList])

  const evidence = usePaneEvidence(onScreen, terminals)
  const watching = useWorkspaceStore((state) => state.watchers)

  // The panes themselves are in the workspace, beside this window's own — the
  // sidebar only says which of these rows is one of them, and quotes what they
  // have printed. It used to hold the viewer as well, floating over everything,
  // and that is exactly what a watched pane stopped being.
  const watches = useWorkspaceStore((state) => state.watches)
  const watchTails = useWorkspaceStore((state) => state.watchTails)
  const toggleWatchedPane = useWorkspaceStore((state) => state.toggleWatchedPane)

  // Only an open pane has a line to quote, because only an open pane streams.
  const watchEvidence = useMemo(() => {
    const lines: Record<string, string | null> = {}
    for (const watch of watches) lines[watch.paneId] = evidenceLine(watchTails[watch.id] ?? '')
    return lines
  }, [watches, watchTails])

  // Teamwork is set up per repository, so an app-level entry has to pick one:
  // the repository whose worktree is open, and otherwise the first. Undefined
  // only before any repository has been added, and then the entry says so
  // rather than doing nothing when pressed.
  const active = worktrees.find((entry) => entry.id === activeWorktreeId)
  const railProject = projects.find((project) => project.id === active?.projectId) ?? projects[0]

  return (
    <div className="sidebar">
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
              title={
                railProject === undefined
                  ? 'Teamwork is set up per repository, and there is none here yet.'
                  : `Set up teamwork in ${railProject.name}, and see who is on it`
              }
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
              title="All panes, by what needs you"
              onClick={toggleDashboard}
            >
              <svg className="rail__icon" viewBox="0 0 14 14" aria-hidden="true">
                <rect x="2" y="2" width="4.2" height="4.2" rx="1" />
                <rect x="7.8" y="2" width="4.2" height="4.2" rx="1" />
                <rect x="2" y="7.8" width="4.2" height="4.2" rx="1" />
                <rect x="7.8" y="7.8" width="4.2" height="4.2" rx="1" />
              </svg>
              <span>All panes</span>
            </button>
          </li>
          <li>
            {/* The one entry here that opens a dialog rather than taking the
                main area. It is in the rail anyway because it belongs to the
                same set — things about the window rather than about a worktree
                — and because a preference nobody can find is a preference
                nobody has. The chord beside it is the one macOS people reach
                for without looking. */}
            <button
              type="button"
              className="rail__link"
              title="Themes and colours"
              onClick={() => openDialog({ kind: 'appearance' })}
            >
              <svg className="rail__icon" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M7 1.6a5.4 5.4 0 1 0 0 10.8c.9 0 1.3-.6 1.3-1.2 0-.8-.7-1.1-.7-1.8 0-.5.4-.9 1-.9h1.1a2.7 2.7 0 0 0 2.7-2.8c0-2.6-2.4-4.1-5.4-4.1Z" />
                <circle cx="4.5" cy="6" r="0.9" />
                <circle cx="7" cy="4.2" r="0.9" />
                <circle cx="9.6" cy="6" r="0.9" />
              </svg>
              <span>Appearance</span>
              <kbd>{appearanceHint}</kbd>
            </button>
          </li>
          <li>
            {/* Last two in the rail, and last on purpose: they are the entries
                somebody goes looking for rather than the ones they work in.
                Settings carries no chord — `⌘,` is Appearance's, and it says so
                one row up — so the palette and this row are the whole of how it
                is reached. */}
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
            </button>
          </li>
          <li>
            <button
              type="button"
              className={`rail__link${helpOpen ? ' rail__link--current' : ''}`}
              aria-current={helpOpen ? 'page' : undefined}
              title="Shortcuts and what a worktree is"
              onClick={toggleHelp}
            >
              <svg className="rail__icon" viewBox="0 0 14 14" aria-hidden="true">
                <circle cx="7" cy="7" r="5.4" />
                <path d="M5.4 5.5a1.7 1.7 0 1 1 2.2 1.7c-.4.2-.6.5-.6.9v.4" />
                <circle cx="7" cy="10.2" r="0.7" />
              </svg>
              <span>Help</span>
              <kbd>{helpHint}</kbd>
            </button>
          </li>
        </ul>
      </nav>

      <nav className="sidebar__projects" aria-label="Projects and worktrees">
        <div className="sidebar__head">
          <h2 className="sidebar__head-title">Projects</h2>
          <button
            type="button"
            className="button button--ghost button--icon"
            title="Add project"
            aria-label="Add project"
            onClick={() => openDialog({ kind: 'add-project' })}
          >
            <svg viewBox="0 0 14 14" aria-hidden="true">
              <path d="M7 2.5 L7 11.5 M2.5 7 L11.5 7" />
            </svg>
          </button>
        </div>

        <div className="sidebar__scroll">
          {projects.length === 0 ? <p className="sidebar__empty">No projects yet. Add a repository.</p> : null}

          {projects.map((project) => {
            const rows = matching.filter((worktree) => worktree.projectId === project.id)
            const isCollapsed = Boolean(collapsed[project.id])
            const summary = teamworkSummary(teamwork[project.id], now)
            // Under the same project, because that is what they are: the same
            // repository, checked out somewhere else. The rows below make whose
            // they are unmissable, which is what lets them share the list.
            const theirs = teammateRows(teammatesHeard(teammates[project.id])?.worktrees ?? [], now, watchEvidence)
            const reading = watchersByPane(watching[project.id])
            // Teammates on the roster this machine has never heard a word from.
            // Not the same as away, and not the same as having no worktrees.
            const unheard = unheardTeammates(teammates[project.id])
            return (
              <section className="project" key={project.id}>
                <div className="project__head">
                  <button
                    type="button"
                    className="project__toggle"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleProject(project.id)}
                  >
                    <svg
                      className={`chevron${isCollapsed ? '' : ' chevron--open'}`}
                      viewBox="0 0 12 12"
                      aria-hidden="true"
                    >
                      <path d="M4.5 2.5 L8.5 6 L4.5 9.5" />
                    </svg>
                    <span className="project__name">{project.name}</span>
                    <span className="project__count">{rows.length}</span>
                    {theirs.length > 0 ? (
                      <span
                        className="project__count project__count--teammate"
                        title={`${theirs.length} teammate worktree${theirs.length === 1 ? '' : 's'}`}
                      >
                        {`+${theirs.length}`}
                      </span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    className="button button--ghost button--icon"
                    title={`New task in ${project.name} · ${newWorktreeHint}`}
                    aria-label={`New task in ${project.name}`}
                    onClick={() => openDialog({ kind: 'new-task', projectId: project.id })}
                  >
                    <svg viewBox="0 0 14 14" aria-hidden="true">
                      <path d="M7 2.5 L7 11.5 M2.5 7 L11.5 7" />
                    </svg>
                  </button>
                </div>
                <div className="project__meta">
                  <p className="project__base">{project.baseRef}</p>
                  {/* Honest about all four of "not set up", "cannot reach the
                    relay", "nobody is connected" and "somebody answered and was
                    not who they should be" — one word each, and the whole of it
                    on hover. */}
                  {summary ? (
                    <span className={`teamwork teamwork--${summary.tone}`} title={summary.detail}>
                      {summary.label}
                    </span>
                  ) : null}
                  {/* Named with the project, because the rail has an entry of
                    the same name: two buttons reading "Teamwork" are one button
                    to anybody listening rather than looking. */}
                  <button
                    type="button"
                    className="project__members"
                    aria-label={`${TEAMWORK_BUTTON_LABEL} in ${project.name}`}
                    title={`Teamwork in ${project.name}`}
                    onClick={() => openTeamwork(project.id)}
                  >
                    {TEAMWORK_BUTTON_LABEL}
                  </button>
                </div>

                {isCollapsed ? null : (
                  <ul className="project__worktrees">
                    {rows.map((worktree) => (
                      <WorktreeRow
                        key={worktree.id}
                        worktree={worktree}
                        status={statuses[worktree.id]}
                        mergePreview={mergePreviews[worktree.id]}
                        terminals={paneList}
                        evidence={evidence}
                        watchers={reading}
                        now={now}
                        onFocusTerminal={(terminalId) => void revealPane(worktree.id, terminalId)}
                        active={worktree.id === activeWorktreeId}
                        onOpen={() => void openWorktree(worktree.id)}
                        onRetry={() => retryWorktree(worktree.id)}
                        onRemove={() => void removeWorktree(worktree.id)}
                      />
                    ))}
                    {theirs.map((row) => (
                      <TeammateWorktreeRow
                        key={row.id}
                        row={row}
                        watchingPaneIds={watchingIn(watches, project.id)}
                        onWatch={(pane) => toggleWatchedPane(project.id, pane)}
                      />
                    ))}
                    {unheard.length > 0 ? (
                      <li className="project__unheard" title={unheardTitle(unheard)}>
                        {`Nothing heard yet from ${unheard.join(', ')}`}
                      </li>
                    ) : null}
                    {rows.length === 0 && theirs.length === 0 ? (
                      <li className="project__none">
                        {filter.trim().length > 0 ? (
                          'No worktrees match that.'
                        ) : (
                          <>
                            {'No worktrees yet. '}
                            <button
                              type="button"
                              className="project__none-action"
                              onClick={() => openDialog({ kind: 'new-task', projectId: project.id })}
                            >
                              Start one
                            </button>
                          </>
                        )}
                      </li>
                    ) : null}
                  </ul>
                )}
              </section>
            )
          })}
        </div>
      </nav>

      {/* The one piece of chrome in this app that argues for itself: it is here
          only while the CLI is not linked to this build, and it goes as soon as
          it is. The palette reaches the same panel at any time.

          Both the label and the title are read from the model rather than
          written here, because what is wrong is not always that there is no
          link — see `cliActionLabel`. This said "Put teamree on my PATH" at
          somebody whose PATH already had one, pointing into a build directory
          that had been deleted. */}
      {offerCliInstall(cli) ? (
        <div className="sidebar__foot">
          <button
            type="button"
            className="sidebar__cli"
            title={cliTitle(cli)}
            onClick={() => openDialog({ kind: 'install-cli' })}
          >
            {cliActionLabel(cli)}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** The panes of one project this window has open, for the rows to mark. */
function watchingIn(watches: readonly { projectId: string; paneId: string }[], projectId: string): string[] {
  return watches.filter((watch) => watch.projectId === projectId).map((watch) => watch.paneId)
}

/** What everybody else is doing to each pane, in the shape a row reads. */
function watchersByPane(watchers: PaneWatchers | undefined): Record<string, PaneAttention> {
  const byPane: Record<string, PaneAttention> = {}
  for (const pane of watchers?.panes ?? []) {
    byPane[pane.terminalId] = { watchers: pane.watchers, typists: pane.typists, muted: pane.muted }
  }
  return byPane
}
