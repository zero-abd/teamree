// Projects and their worktrees, with each worktree's panes and what they are
// doing underneath it.
//
// There is no filter box. A search field permanently occupying the top of the
// sidebar earns its place only in a list too long to look at, and by then the
// palette is faster than a field you have to reach for: it matches names,
// branches and projects, and it is one chord away from anywhere. The sidebar's
// job is to show what is happening, not to be searched.
//
// The filter matches on task name and branch,
// which is how people actually look for a piece of work in flight.

import { useCallback, useMemo, useState } from 'react'
import type { PaneWatchers } from '@shared/entities'
import { offerCliInstall } from '../dialogs/cliInstallModel'
import { WatchedPaneView } from '../terminal/WatchedPaneView'
import type { PaneAttention } from '../state/paneAttention'
import { useNow } from '../state/useNow'
import { useWorkspaceStore } from '../state/workspaceStore'
import { evidenceLine } from './outputEvidence'
import { TeammateWorktreeRow } from './TeammateWorktreeRow'
import { teammateRows, unheardTeammates, unheardTitle, type TeammatePaneRow } from './teammateRows'
import { teamworkSummary, TEAMWORK_BUTTON_LABEL } from './teamworkSummary'
import { usePaneEvidence } from './usePaneEvidence'
import { WorktreeRow } from './WorktreeRow'

/**
 * One teammate's pane at a time, and the whole of what the window remembers
 * about watching.
 *
 * One rather than many because bytes cost a relay budget and a reader has one
 * pair of eyes: `docs/teamwork.md` is explicit that output flows only for a
 * pane somebody has open, and "open" meaning "was opened once and never shut"
 * is how that turns into the N² traffic it exists to prevent.
 */
type OpenWatch = { projectId: string; paneId: string; label: string; handle: string }

/** How much of a watched pane is kept to quote its last line from. */
const WATCH_TAIL_CHARS = 4_000

export function Sidebar({ newWorktreeHint }: { newWorktreeHint: string }): React.JSX.Element {
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

  const [watch, setWatch] = useState<OpenWatch | null>(null)
  // Whatever the pane this window is watching has said since it was opened.
  // Nothing else has a line to quote, because nothing else is streaming.
  const [watchTail, setWatchTail] = useState('')

  const openWatch = useCallback((projectId: string, pane: TeammatePaneRow) => {
    setWatchTail('')
    setWatch((current) =>
      // A second press on the pane already open stops watching, which is also
      // what makes stopping reachable without reaching for the viewer.
      current?.paneId === pane.terminalId
        ? null
        : { projectId, paneId: pane.terminalId, label: pane.label, handle: pane.handle }
    )
  }, [])

  const onWatchOutput = useCallback((data: string) => {
    setWatchTail((tail) => (tail + data).slice(-WATCH_TAIL_CHARS))
  }, [])

  const watchEvidence = useMemo(() => (watch ? { [watch.paneId]: evidenceLine(watchTail) } : {}), [watch, watchTail])

  return (
    <nav className="sidebar" aria-label="Projects and worktrees">
      <div className="sidebar__head">
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
        {projects.length === 0 ? (
          <p className="sidebar__empty">No projects yet. Add a repository to get started.</p>
        ) : null}

        {projects.map((project) => {
          const rows = matching.filter((worktree) => worktree.projectId === project.id)
          const isCollapsed = Boolean(collapsed[project.id])
          const summary = teamworkSummary(teamwork[project.id])
          // Under the same project, because that is what they are: the same
          // repository, checked out somewhere else. The rows below make whose
          // they are unmissable, which is what lets them share the list.
          const theirs = teammateRows(teammates[project.id]?.worktrees ?? [], now, watchEvidence)
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
                <button
                  type="button"
                  className="project__members"
                  title={`Set up teamwork in ${project.name}, and see who is on it`}
                  onClick={() => openDialog({ kind: 'start-teamwork', projectId: project.id })}
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
                      watchingPaneId={watch?.paneId ?? null}
                      onWatch={(pane) => openWatch(project.id, pane)}
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

      {/* The one piece of chrome in this app that argues for itself: it is here
          only while the CLI is not linked to this build, and it goes as soon as
          it is. The palette reaches the same panel at any time. */}
      {offerCliInstall(cli) ? (
        <div className="sidebar__foot">
          <button
            type="button"
            className="sidebar__cli"
            title={`Link ${cli?.destination ?? 'the teamree CLI'} to this app`}
            onClick={() => openDialog({ kind: 'install-cli' })}
          >
            Put teamree on my PATH
          </button>
        </div>
      ) : null}

      {/* Over the window rather than in the pane tree, because it is not one of
          your panes: it is a window onto somebody else's machine, and it goes
          away when you stop looking. */}
      {watch ? (
        <WatchedPaneView
          key={watch.paneId}
          projectId={watch.projectId}
          paneId={watch.paneId}
          label={watch.label}
          handle={watch.handle}
          onOutput={onWatchOutput}
          onClose={() => setWatch(null)}
        />
      ) : null}
    </nav>
  )
}

/** What everybody else is doing to each pane, in the shape a row reads. */
function watchersByPane(watchers: PaneWatchers | undefined): Record<string, PaneAttention> {
  const byPane: Record<string, PaneAttention> = {}
  for (const pane of watchers?.panes ?? []) {
    byPane[pane.terminalId] = { watchers: pane.watchers, typists: pane.typists, muted: pane.muted }
  }
  return byPane
}
